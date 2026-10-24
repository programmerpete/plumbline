import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runAgent } from "./agent.ts";
import { DEFAULT_STEP_TIMEOUT_MS, gradeTask, OracleUnavailableError, type Grade } from "./oracle.ts";
import { materialise, measureChanges, runSetup, taskEnv, type ChangeSummary } from "./scratch.ts";
import { UNKNOWN_USAGE, type AgentConfig, type FailureMode, type OracleStep, type TrialRecord } from "./schema.ts";
import type { LoadedTask } from "./task.ts";

/**
 * One trial is one agent session against one fresh checkout, followed by one
 * grading run. Trials are independent by construction: no state is shared between
 * them except the ledger they write to.
 */

export type TrialOptions = {
  task: LoadedTask;
  agent: AgentConfig;
  agentVersion: string | null;
  runId: string;
  attempt: number;
  attemptsPlanned: number;
  harness: { version: string; suite_commit: string | null };
  workRoot: string;
  stepTimeoutMs?: number;
  keep?: boolean;
};

export function trialScratchPath(options: Pick<TrialOptions, "workRoot" | "task" | "attempt">): string {
  return join(options.workRoot, options.task.spec.id, `attempt-${options.attempt}`);
}

export async function runTrial(options: TrialOptions): Promise<TrialRecord> {
  const record = await runTrialInner(options);

  if (options.keep) {
    const artifactDir = join(trialScratchPath(options), ".plumbline", "artifacts");
    try {
      await mkdir(artifactDir, { recursive: true });
      await Bun.write(join(artifactDir, "trial.json"), `${JSON.stringify(record, null, 2)}\n`);
    } catch {
      // Artifacts are a convenience; the ledger record is the record.
    }
  }

  return record;
}

async function runTrialInner(options: TrialOptions): Promise<TrialRecord> {
  const { task, agent, runId, attempt } = options;
  const startedAt = new Date();
  const scratch = trialScratchPath(options);
  const stepTimeoutMs = options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const notes: string[] = [];
  const steps: OracleStep[] = [];
  const artifacts: string[] = [];

  let agentExitCode: number | null = null;
  let agentTimedOut = false;
  let agentDurationMs = 0;
  let usage = UNKNOWN_USAGE;
  let model: string | null = null;
  let changes: ChangeSummary = { changed_files: 0, added: 0, removed: 0, patch: "" };
  let verdict: TrialRecord["verdict"] = "fail";
  let failureMode: FailureMode | null = null;

  const finish = (): TrialRecord => {
    if (!options.keep) {
      notes.push("scratch checkout removed after the trial; rerun with --keep to retain transcripts");
    }
    const endedAt = new Date();
    return {
      schema_version: 1,
      run_id: runId,
      trial_id: `${runId}-${task.spec.id}-a${attempt}`,
      task_id: task.spec.id,
      task_title: task.spec.title,
      platform: task.spec.platform,
      attempt,
      attempts_planned: options.attemptsPlanned,
      agent: {
        name: agent.name,
        command: agent.command,
        version: options.agentVersion,
        model,
      },
      harness: options.harness,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: endedAt.getTime() - startedAt.getTime(),
      agent_duration_ms: agentDurationMs,
      agent_exit_code: agentExitCode,
      agent_timed_out: agentTimedOut,
      verdict,
      failure_mode: failureMode,
      changed_files: changes.changed_files,
      diff: { added: changes.added, removed: changes.removed },
      steps,
      usage,
      artifacts,
      notes,
    };
  };

  const env = taskEnv(task, scratch, runId);

  try {
    await materialise(task, scratch);
  } catch (error) {
    notes.push(`checkout failed: ${describe(error)}`);
    verdict = "error";
    failureMode = "oracle_error";
    return finish();
  }

  const setup = await runSetup(task, scratch, env, stepTimeoutMs);
  steps.push(...setup.steps);
  if (setup.failed) {
    notes.push("setup failed before the agent ran; the trial says nothing about the agent");
    verdict = "fail";
    failureMode = "setup_failed";
    return finish();
  }

  const agentRun = await runAgent(
    agent,
    task.spec.prompt,
    scratch,
    env,
    task.spec.budget.wall_clock_seconds * 1000,
  );
  agentExitCode = agentRun.exit_code;
  agentTimedOut = agentRun.timed_out;
  agentDurationMs = agentRun.duration_ms;
  usage = agentRun.usage;
  model = agentRun.model;

  if (agentTimedOut) {
    notes.push(`agent exceeded the ${task.spec.budget.wall_clock_seconds}s wall-clock limit`);
  }

  await writeTranscript(scratch, agentRun.stdout, agentRun.stderr);

  changes = await measureChanges(scratch);
  if (changes.changed_files === 0) {
    notes.push("the agent left the checkout untouched");
  }

  let grade: Grade;
  try {
    grade = await gradeTask(task, scratch, {
      artifactDir: join(scratch, ".plumbline", "artifacts"),
      stepTimeoutMs,
    });
  } catch (error) {
    if (error instanceof OracleUnavailableError) {
      notes.push(error.message);
      verdict = "error";
      failureMode = "oracle_error";
      return finish();
    }
    notes.push(`oracle error: ${describe(error)}`);
    verdict = "error";
    failureMode = "oracle_error";
    return finish();
  }

  steps.push(...grade.steps);
  artifacts.push(...grade.artifacts);
  notes.push(...grade.notes);
  await writeOracleLog(scratch, grade);

  if (grade.verdict === "pass") {
    verdict = "pass";
    failureMode = null;
    if (agentTimedOut) {
      notes.push("the agent was killed at the limit but the tests still passed");
    }
  } else {
    verdict = "fail";
    // Precedence: how the session ended outranks how the tests failed, because a
    // run that ended badly is a different finding from one that finished and got
    // it wrong. Documented in docs/GRADING.md.
    failureMode = agentTimedOut
      ? "timeout"
      : agentExitCode !== 0
        ? "agent_error"
        : changes.changed_files === 0
          ? "no_change"
          : grade.failure_mode;
  }

  return finish();
}

async function writeTranscript(scratch: string, stdout: string, stderr: string): Promise<void> {
  try {
    const dir = join(scratch, ".plumbline", "artifacts");
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "transcript.log"), [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n"));
  } catch {
    // The verdict does not depend on the transcript being written.
  }
}

async function writeOracleLog(scratch: string, grade: Grade): Promise<void> {
  try {
    const dir = join(scratch, ".plumbline", "artifacts");
    await mkdir(dir, { recursive: true });
    const body = grade.steps
      .map((step) => `$ ${step.command}\nexit ${step.exit_code} in ${step.duration_ms}ms\n${step.output_tail}`)
      .join("\n\n");
    await Bun.write(join(dir, "oracle.log"), body);
  } catch {
    // Same: evidence is best-effort, the ledger is not.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
