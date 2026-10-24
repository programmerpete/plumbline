import { appleTooling, isMacOS } from "./apple.ts";
import { runShell, statOrNull, which } from "./exec.ts";
import { readTrials, readValidations, latestValidations } from "./ledger.ts";
import { loadTaskDir } from "./task.ts";
import { taskContentHash } from "./validate.ts";

/**
 * `plumbline doctor` answers one question: can this machine produce trustworthy
 * numbers right now? It never calls a model and never spends a token, so it is
 * safe to run before and after anything else.
 */

export type CheckStatus = "pass" | "skip" | "fail" | "warn";
export type Check = { status: CheckStatus; label: string; detail: string };

export const AGENT_CLIS = ["claude", "codex", "amp", "opencode", "cursor-agent", "gemini"];

export type DoctorOptions = {
  tasksDir: string;
  fixturesDir: string;
  ledgerPath: string;
  validationsPath: string;
};

export async function runDoctor(options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];

  checks.push({ status: "pass", label: `bun ${Bun.version}`, detail: "runtime" });

  const git = await which("git");
  if (git) {
    const version = await runShell("git --version", { timeoutMs: 10_000 });
    checks.push({
      status: "pass",
      label: version.stdout.trim() || "git",
      detail: "scratch checkouts and change measurement",
    });
  } else {
    checks.push({ status: "fail", label: "git", detail: "git is required: plumbline measures changes with it" });
  }

  if (isMacOS()) {
    checks.push({ status: "pass", label: "macOS", detail: "Apple tasks can be graded here" });
    const tooling = await appleTooling();
    if (tooling.xcodebuild) {
      checks.push({
        status: "pass",
        label: tooling.xcode_version ?? "xcodebuild",
        detail: `simulators available: ${tooling.simulator_count ?? "unknown"}`,
      });
    } else {
      checks.push({
        status: "fail",
        label: "xcodebuild",
        detail: "install Xcode and select it with xcode-select --switch",
      });
    }
  } else {
    checks.push({
      status: "skip",
      label: `platform ${process.platform}`,
      detail: "xcodebuild only exists on macOS: Apple tasks cannot be graded here",
    });
    checks.push({
      status: "skip",
      label: "xcodebuild",
      detail: "self-test tasks (platform: local) still run",
    });
  }

  const found: string[] = [];
  for (const candidate of AGENT_CLIS) {
    if (await which(candidate)) found.push(candidate);
  }
  checks.push(
    found.length > 0
      ? { status: "pass", label: `agent CLIs: ${found.join(", ")}`, detail: "found on PATH" }
      : {
          status: "warn",
          label: "agent CLIs",
          detail: "none found on PATH; pass --agent with your own command",
        },
  );

  checks.push(await suiteCheck("task suite", options.tasksDir, false));
  checks.push(await suiteCheck("self-test suite", options.fixturesDir, true));
  checks.push(await validationCheck(options));

  const trials = await readTrials(options.ledgerPath);
  checks.push({
    status: trials.length > 0 ? "pass" : "skip",
    label: "ledger",
    detail:
      trials.length > 0
        ? `${trials.length} trials, last run ${trials[trials.length - 1]!.run_id}`
        : `no trials yet (${options.ledgerPath})`,
  });

  return checks;
}

async function suiteCheck(label: string, dir: string, optional: boolean): Promise<Check> {
  const stat = await statOrNull(dir);
  if (!stat?.isDirectory()) {
    return {
      status: optional ? "skip" : "fail",
      label,
      detail: `no directory at ${dir}`,
    };
  }

  try {
    const tasks = await loadTaskDir(dir);
    const apple = tasks.filter((task) => task.spec.platform === "apple").length;
    const local = tasks.length - apple;
    if (tasks.length === 0) {
      return { status: optional ? "skip" : "warn", label, detail: `no tasks in ${dir}` };
    }
    return {
      status: "pass",
      label: `${label}: ${tasks.length}`,
      detail: `${apple} apple, ${local} local — all specs valid`,
    };
  } catch (error) {
    return { status: "fail", label, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function validationCheck(options: DoctorOptions): Promise<Check> {
  const stat = await statOrNull(options.tasksDir);
  if (!stat?.isDirectory()) {
    return { status: "skip", label: "validation coverage", detail: "no task suite to check" };
  }

  let tasks;
  try {
    tasks = await loadTaskDir(options.tasksDir);
  } catch {
    return { status: "skip", label: "validation coverage", detail: "task suite did not load" };
  }
  if (tasks.length === 0) {
    return { status: "skip", label: "validation coverage", detail: "no tasks" };
  }

  const latest = latestValidations(await readValidations(options.validationsPath));
  let valid = 0;
  for (const task of tasks) {
    const record = latest.get(task.spec.id);
    if (record?.ok && record.task_content_hash === (await taskContentHash(task))) valid += 1;
  }

  return {
    status: valid === tasks.length ? "pass" : "warn",
    label: `validation coverage ${valid}/${tasks.length}`,
    detail:
      valid === tasks.length
        ? "every task proved to fail before and pass after"
        : "run plumbline validate; unvalidated numbers are provisional",
  };
}

export function formatCheck(check: Check): string {
  return `  ${check.status.toUpperCase().padEnd(5)} ${check.label.padEnd(32)} ${check.detail}`;
}
