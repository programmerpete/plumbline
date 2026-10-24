import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  appleCommandsAvailable,
  simulatorScreenshotCommand,
  xcodebuildBuildCommand,
  xcodebuildTestCommand,
  isMacOS,
  SCRATCH_STATE_DIR,
} from "./apple.ts";
import { combineOutput, runShell, tail } from "./exec.ts";
import type { LoadedTask } from "./task.ts";
import type { FailureMode, OracleStep } from "./schema.ts";

/**
 * The oracle is the repository's own build and test suite. No rubric, no judge
 * model, no partial credit. If a task cannot be graded this way, it is not a
 * plumbline task.
 */

export const DEFAULT_STEP_TIMEOUT_MS = 45 * 60 * 1000;

export class OracleUnavailableError extends Error {}

export type Grade = {
  verdict: "pass" | "fail";
  failure_mode: FailureMode | null;
  steps: OracleStep[];
  artifacts: string[];
  notes: string[];
};

export type GradeOptions = {
  /** Where screenshot evidence is written. Falls back to inside the scratch checkout. */
  artifactDir?: string;
  stepTimeoutMs?: number;
};

type PlannedStep = { name: string; command: string };

export function planOracle(task: LoadedTask): PlannedStep[] {
  const spec = task.spec;

  if (spec.platform === "apple") {
    return [
      { name: "build", command: xcodebuildBuildCommand(spec.apple) },
      { name: "test", command: xcodebuildTestCommand(spec.apple) },
    ];
  }

  const steps: PlannedStep[] = spec.local.build.map((command, index) => ({
    name: spec.local.build.length > 1 ? `build ${index + 1}` : "build",
    command,
  }));
  steps.push(
    ...spec.local.test.map((command, index) => ({
      name: spec.local.test.length > 1 ? `test ${index + 1}` : "test",
      command,
    })),
  );
  return steps;
}

export async function gradeTask(
  task: LoadedTask,
  cwd: string,
  options: GradeOptions = {},
): Promise<Grade> {
  const spec = task.spec;

  if (spec.platform === "apple") {
    if (!isMacOS()) {
      throw new OracleUnavailableError(
        `task ${spec.id} is an Apple task: xcodebuild only exists on macOS`,
      );
    }
    const tooling = await appleCommandsAvailable();
    if (!tooling.xcodebuild) {
      throw new OracleUnavailableError(
        `task ${spec.id} needs xcodebuild on PATH (install Xcode and run xcode-select --install)`,
      );
    }
  }

  const steps: OracleStep[] = [];
  const artifacts: string[] = [];
  const notes: string[] = [];
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  for (const step of planOracle(task)) {
    const result = await runShell(step.command, { cwd, timeoutMs: stepTimeoutMs });
    steps.push({
      name: step.name,
      command: step.command,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      output_tail: tail(combineOutput(result)),
    });

    if (result.timed_out) {
      notes.push(`${step.name} exceeded the ${Math.round(stepTimeoutMs / 1000)}s step limit`);
    }

    if (result.exit_code !== 0) {
      return {
        verdict: "fail",
        failure_mode: step.name.startsWith("build") ? "build_failed" : "tests_failed",
        steps,
        artifacts,
        notes,
      };
    }
  }

  if (spec.platform === "apple" && spec.apple.capture_screenshot) {
    const destination = join(options.artifactDir ?? join(cwd, SCRATCH_STATE_DIR), "simulator.png");
    await mkdir(join(destination, ".."), { recursive: true });
    const capture = await runShell(simulatorScreenshotCommand(destination), {
      cwd,
      timeoutMs: 60_000,
    });
    if (capture.exit_code === 0) {
      artifacts.push(destination);
    } else {
      notes.push("screenshot capture failed; the verdict is unaffected");
    }
  }

  return { verdict: "pass", failure_mode: null, steps, artifacts, notes };
}
