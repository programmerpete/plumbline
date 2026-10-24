import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runShell, shellQuote } from "./exec.ts";
import { DEFAULT_STEP_TIMEOUT_MS, gradeTask, OracleUnavailableError } from "./oracle.ts";
import { materialise, runSetup, taskEnv } from "./scratch.ts";
import { resolveInsideRoot, type LoadedTask } from "./task.ts";
import type { ValidationRecord } from "./schema.ts";

/**
 * A task is only trustworthy if the oracle fails before the work and passes after
 * it. Without that check a task can be pre-solved (everyone passes, nothing is
 * measured) or impossible (nobody passes, which looks like a bad agent).
 *
 *   pristine  — the oracle must FAIL on the pinned checkout
 *   reference — the oracle must PASS once the reference patch is applied
 *
 * Both are required. A task with no reference patch cannot be validated, and
 * unvalidated numbers are marked provisional in every report.
 */

export const DEFAULT_WORK_ROOT = join(".plumbline", "work");

export type TaskValidation = {
  record: ValidationRecord;
  details: string[];
};

export async function taskContentHash(task: LoadedTask): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await Bun.file(task.file).text());

  if (task.spec.reference_patch) {
    const patch = resolveInsideRoot(task.spec.reference_patch, "reference_patch", task.spec.id);
    hash.update(await Bun.file(patch).text());
  }

  hash.update(
    task.spec.source.kind === "path"
      ? `path:${task.spec.source.path}`
      : `git:${task.spec.source.url}@${task.spec.source.commit}`,
  );

  return hash.digest("hex").slice(0, 16);
}

export async function validateTask(
  task: LoadedTask,
  options: { workRoot: string; harnessVersion: string; stepTimeoutMs?: number },
): Promise<TaskValidation> {
  const details: string[] = [];
  const reasons: string[] = [];
  const hash = await taskContentHash(task);

  const pristine = await runOnce(task, join(options.workRoot, task.spec.id, "validate-pristine"), options);
  details.push(`pristine: ${describeVerdict(pristine.verdict, pristine.message)}`);

  let referenceVerdict: ValidationRecord["reference_verdict"] = null;
  if (!task.spec.reference_patch) {
    reasons.push("no reference_patch: nothing proves the oracle can be satisfied");
    details.push("reference: skipped (no reference_patch)");
  } else {
    const reference = await runOnce(
      task,
      join(options.workRoot, task.spec.id, "validate-reference"),
      options,
      task.spec.reference_patch,
    );
    referenceVerdict = reference.verdict;
    details.push(`reference: ${describeVerdict(reference.verdict, reference.message)}`);
  }

  if (pristine.verdict === "pass") {
    reasons.push("the oracle already passes on the untouched checkout: the task is pre-solved");
  }
  if (pristine.verdict === "error" && pristine.message) {
    reasons.push(`cannot grade the pristine checkout: ${pristine.message}`);
  }
  if (referenceVerdict === "fail") {
    reasons.push("the reference patch does not satisfy the oracle: the task may be impossible");
  }
  if (referenceVerdict === "error" && task.spec.reference_patch) {
    reasons.push("the oracle could not be run against the reference patch");
  }

  const ok = pristine.verdict === "fail" && referenceVerdict === "pass";

  return {
    record: {
      schema_version: 1,
      task_id: task.spec.id,
      task_content_hash: hash,
      validated_at: new Date().toISOString(),
      harness_version: options.harnessVersion,
      pristine_verdict: pristine.verdict,
      reference_verdict: referenceVerdict,
      ok,
      reasons,
    },
    details,
  };
}

async function runOnce(
  task: LoadedTask,
  scratch: string,
  options: { stepTimeoutMs?: number },
  patch?: string,
): Promise<{ verdict: "pass" | "fail" | "error"; message: string | null }> {
  try {
    await materialise(task, scratch);

    // Setup first: it establishes the starting state the agent would have seen, so
    // the reference patch is applied on top of it rather than on a bare checkout.
    const setup = await runSetup(
      task,
      scratch,
      taskEnv(task, scratch, null),
      options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    );
    if (setup.failed) {
      return { verdict: "error", message: `setup failed: ${setup.failed.command}` };
    }

    if (patch) {
      const absolute = resolveInsideRoot(patch, "reference_patch", task.spec.id);
      const applied = await runShell(`git apply --whitespace=nowarn ${shellQuote(absolute)}`, {
        cwd: scratch,
      });
      if (applied.exit_code !== 0) {
        return { verdict: "fail", message: `reference patch did not apply: ${applied.stderr.trim()}` };
      }
    }

    const grade = await gradeTask(task, scratch, {
      artifactDir: join(scratch, ".plumbline", "artifacts"),
      stepTimeoutMs: options.stepTimeoutMs,
    });
    return { verdict: grade.verdict, message: grade.failure_mode };
  } catch (error) {
    if (error instanceof OracleUnavailableError) {
      return { verdict: "error", message: error.message };
    }
    return { verdict: "error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

function describeVerdict(verdict: "pass" | "fail" | "error", message: string | null): string {
  if (verdict === "pass") return "oracle passed";
  if (verdict === "fail") return `oracle failed${message ? ` (${message})` : ""}`;
  return `could not grade${message ? `: ${message}` : ""}`;
}
