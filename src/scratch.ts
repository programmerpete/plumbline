import { cp, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { SCRATCH_STATE_DIR } from "./apple.ts";
import { combineOutput, git, REPO_ROOT, runShell, shellQuote, tail } from "./exec.ts";
import type { OracleStep } from "./schema.ts";
import { localSourcePath, type LoadedTask } from "./task.ts";

/**
 * Every trial gets a throwaway checkout. It is the agent's whole world: nothing
 * outside it is writable by a task, and nothing inside it survives the run unless
 * `--keep` was passed.
 */

/**
 * Paths that must never count as "the agent changed something". Build products and
 * dependency trees are side effects of grading, not attempts at the task.
 */
const EXCLUDES = [
  `${SCRATCH_STATE_DIR}/`,
  "node_modules/",
  "DerivedData/",
  "build/",
  "*.xcresult",
  ".DS_Store",
];

export async function materialise(task: LoadedTask, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dirname(dest), { recursive: true });

  if (task.spec.source.kind === "git") {
    const clone = await runShell(
      `git clone --quiet ${shellQuote(task.spec.source.url)} ${shellQuote(dest)}`,
      { timeoutMs: 30 * 60 * 1000 },
    );
    if (clone.exit_code !== 0) {
      throw new Error(`git clone failed for ${task.spec.id}:\n${combineOutput(clone)}`);
    }

    const checkout = await git(dest, ["checkout", "--quiet", task.spec.source.commit]);
    if (checkout.exit_code !== 0) {
      throw new Error(
        `git checkout ${task.spec.source.commit} failed for ${task.spec.id}:\n${combineOutput(checkout)}`,
      );
    }
  } else {
    const source = localSourcePath(task.spec);
    await cp(source, dest, { recursive: true });
    await initBaseline(dest);
  }

  await writeExcludes(dest);
}

async function initBaseline(dest: string): Promise<void> {
  const init = await git(dest, ["init", "--quiet"]);
  if (init.exit_code !== 0) {
    throw new Error(`git init failed in scratch checkout:\n${combineOutput(init)}`);
  }
  await commitAll(dest, "plumbline baseline");
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  const add = await git(cwd, ["add", "-A"]);
  if (add.exit_code !== 0) {
    throw new Error(`git add failed:\n${combineOutput(add)}`);
  }

  const commit = await runShell(
    [
      "git",
      "-c user.name=plumbline",
      "-c user.email=plumbline@localhost",
      "commit --quiet --allow-empty -m",
      shellQuote(message),
    ].join(" "),
    { cwd },
  );
  if (commit.exit_code !== 0) {
    throw new Error(`git commit failed:\n${combineOutput(commit)}`);
  }
}

async function writeExcludes(dest: string): Promise<void> {
  const path = `${dest}/.git/info/exclude`;
  await mkdir(dirname(path), { recursive: true });
  const existing = (await Bun.file(path).exists()) ? await Bun.file(path).text() : "";
  const body = `${existing.trimEnd()}\n# plumbline: not agent work\n${EXCLUDES.join("\n")}\n`;
  await Bun.write(path, body);
}

/**
 * The environment every setup step and every agent gets. Documented in
 * docs/TASKS.md, because an agent integration depends on it being stable.
 */
export function taskEnv(
  task: LoadedTask,
  scratch: string,
  runId: string | null,
): Record<string, string> {
  return {
    ...(runId ? { PLUMBLINE_RUN_ID: runId } : {}),
    PLUMBLINE_TASK_ID: task.spec.id,
    PLUMBLINE_TASK_DIR: task.dir,
    PLUMBLINE_SCRATCH: scratch,
    PLUMBLINE_REPO: REPO_ROOT,
  };
}

export type SetupResult = {
  steps: OracleStep[];
  failed: OracleStep | null;
};

/**
 * Setup establishes the task's starting state (codegen, fixtures, dependencies).
 * It runs before the agent and before the oracle, including during validation:
 * a task whose setup does not run is not the task that was measured.
 */
export async function runSetup(
  task: LoadedTask,
  scratch: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SetupResult> {
  const steps: OracleStep[] = [];

  for (const [index, command] of task.spec.setup.entries()) {
    const result = await runShell(command, { cwd: scratch, env, timeoutMs });
    const step: OracleStep = {
      name: task.spec.setup.length > 1 ? `setup ${index + 1}` : "setup",
      command,
      exit_code: result.exit_code,
      duration_ms: result.duration_ms,
      output_tail: tail(combineOutput(result)),
    };
    steps.push(step);
    if (result.exit_code !== 0) return { steps, failed: step };
  }

  return { steps, failed: null };
}

export type ChangeSummary = {
  changed_files: number;
  added: number;
  removed: number;
  patch: string;
};

/**
 * Changes are measured by staging everything and diffing against the baseline, so
 * new files count as work. `git add -A` honours .git/info/exclude, which keeps
 * build output out of the measurement.
 */
export async function measureChanges(cwd: string): Promise<ChangeSummary> {
  const empty: ChangeSummary = { changed_files: 0, added: 0, removed: 0, patch: "" };

  const add = await git(cwd, ["add", "-A"]);
  if (add.exit_code !== 0) return empty;

  const [numstat, patch] = await Promise.all([
    git(cwd, ["diff", "--cached", "--numstat"]),
    git(cwd, ["diff", "--cached"]),
  ]);
  if (numstat.exit_code !== 0) return empty;

  let changedFiles = 0;
  let added = 0;
  let removed = 0;

  for (const line of numstat.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addedField, removedField] = line.split("\t");
    changedFiles += 1;
    added += Number.parseInt(addedField ?? "0", 10) || 0;
    removed += Number.parseInt(removedField ?? "0", 10) || 0;
  }

  return { changed_files: changedFiles, added, removed, patch: patch.stdout };
}
