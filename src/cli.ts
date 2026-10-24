#!/usr/bin/env bun
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { agentVersion, loadAgentConfig } from "./agent.ts";
import { formatCheck, runDoctor } from "./doctor.ts";
import { installSignalCleanup, REPO_ROOT, runShell } from "./exec.ts";
import { formatCost, formatDuration, localDate, randomHex } from "./format.ts";
import { appendTrial, appendValidation, latestValidations, readTrials, readValidations } from "./ledger.ts";
import { planOracle } from "./oracle.ts";
import { buildReport } from "./report.ts";
import { loadTaskDir, type LoadedTask } from "./task.ts";
import { runTrial, trialScratchPath } from "./trial.ts";
import { validateTask } from "./validate.ts";

const USAGE = `plumbline — a graded coding-agent benchmark for Apple-platform work

Usage
  plumbline doctor [--tasks <dir>]
  plumbline tasks [--tasks <dir>]
  plumbline validate [task-id ...] [--tasks <dir>]
  plumbline run --agent <config> [--task <id> ...] [--attempts <n>] [--dry-run] [--keep]
  plumbline report [--run <id>] [--ledger <file>] [--out <dir>]

Flags
  --dry-run   print the plan without running anything
  --keep      keep scratch checkouts, transcripts and screenshots
  --no-index  do not add the run to the README index (used by the self-tests)

Paths
  --tasks     task suite directory            (default: tasks)
  --ledger    append-only trial record        (default: ledger/trials.jsonl)
  --work      scratch checkouts               (default: .plumbline/work)
  --out       report directory                (default: report)
  --attempts  override the per-task budget    (default: task budget.attempts)
  --agent     agent config file (JSON or YAML)

The oracle is the repository's own build and test suite. plumbline makes no model
calls of its own: an agent is a command you already have.`;

const BOOLEAN_FLAGS = new Set(["dry-run", "keep", "json", "help", "no-index"]);

type Parsed = {
  command: string;
  flags: Map<string, string[]>;
  positionals: string[];
};

function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let command = "";

  const add = (name: string, value: string) => {
    const bucket = flags.get(name) ?? [];
    bucket.push(value);
    flags.set(name, bucket);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals !== -1) {
        add(body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        add(body, "true");
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        add(body, "true");
        continue;
      }
      add(body, next);
      index += 1;
      continue;
    }

    if (!command) {
      command = token;
      continue;
    }
    positionals.push(token);
  }

  return { command, flags, positionals };
}

function flag(parsed: Parsed, name: string): string | null {
  return parsed.flags.get(name)?.[0] ?? null;
}

function flagAll(parsed: Parsed, name: string): string[] {
  return parsed.flags.get(name) ?? [];
}

function bool(parsed: Parsed, name: string): boolean {
  return parsed.flags.get(name)?.[0] === "true";
}

function number(parsed: Parsed, name: string): number | null {
  const raw = flag(parsed, name);
  if (raw === null) return null;
  const parsedValue = Number.parseInt(raw, 10);
  return Number.isFinite(parsedValue) ? parsedValue : null;
}

type Paths = {
  tasksDir: string;
  ledgerPath: string;
  validationsPath: string;
  workRoot: string;
  reportDir: string;
};

function paths(parsed: Parsed): Paths {
  const ledgerPath = resolve(REPO_ROOT, flag(parsed, "ledger") ?? join("ledger", "trials.jsonl"));
  return {
    tasksDir: resolve(REPO_ROOT, flag(parsed, "tasks") ?? "tasks"),
    ledgerPath,
    validationsPath: join(resolve(ledgerPath, ".."), "validations.jsonl"),
    workRoot: resolve(REPO_ROOT, flag(parsed, "work") ?? join(".plumbline", "work")),
    reportDir: resolve(REPO_ROOT, flag(parsed, "out") ?? "report"),
  };
}

async function harnessInfo(): Promise<{ version: string; suite_commit: string | null }> {
  const pkg = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as { version?: string };
  const commit = await runShell("git rev-parse HEAD", { cwd: REPO_ROOT, timeoutMs: 10_000 });
  return {
    version: pkg.version ?? "0.0.0",
    suite_commit: commit.exit_code === 0 ? commit.stdout.trim().slice(0, 40) : null,
  };
}

async function selectTasks(parsed: Parsed, tasksDir: string): Promise<LoadedTask[]> {
  const tasks = await loadTaskDir(tasksDir);
  const ids = [...flagAll(parsed, "task"), ...parsed.positionals];

  if (ids.length === 0) return tasks;

  const selected = tasks.filter((task) => ids.includes(task.spec.id));
  const missing = ids.filter((id) => !selected.some((task) => task.spec.id === id));
  if (missing.length > 0) {
    throw new Error(`unknown task(s): ${missing.join(", ")}`);
  }
  return selected;
}

async function doctorCommand(parsed: Parsed): Promise<number> {
  const resolved = paths(parsed);
  const checks = await runDoctor({
    tasksDir: resolved.tasksDir,
    fixturesDir: resolve(REPO_ROOT, "fixtures", "tasks"),
    ledgerPath: resolved.ledgerPath,
    validationsPath: resolved.validationsPath,
  });

  for (const check of checks) {
    console.log(formatCheck(check));
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const skipped = checks.filter((check) => check.status === "skip").length;
  console.log(`\n  ${checks.length - failed} ok, ${skipped} skipped, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

async function tasksCommand(parsed: Parsed): Promise<number> {
  const resolved = paths(parsed);
  const tasks = await loadTaskDir(resolved.tasksDir);

  if (tasks.length === 0) {
    console.log(`no tasks in ${resolved.tasksDir}`);
    return 0;
  }

  const validations = latestValidations(await readValidations(resolved.validationsPath));
  for (const task of tasks) {
    const validity = validations.get(task.spec.id)?.ok ? "validated" : "unvalidated";
    console.log(
      `${task.spec.id.padEnd(36)} ${task.spec.platform.padEnd(6)} ${validity.padEnd(12)} ${task.spec.title}`,
    );
  }
  return 0;
}

async function validateCommand(parsed: Parsed): Promise<number> {
  const resolved = paths(parsed);
  const info = await harnessInfo();
  const tasks = await selectTasks(parsed, resolved.tasksDir);

  if (tasks.length === 0) {
    console.log("no tasks to validate");
    return 0;
  }

  let failures = 0;
  for (const task of tasks) {
    const { record, details } = await validateTask(task, {
      workRoot: resolved.workRoot,
      harnessVersion: info.version,
      stepTimeoutMs: (number(parsed, "step-timeout") ?? 0) * 1000 || undefined,
    });
    await appendValidation(resolved.validationsPath, record);

    console.log(`${record.ok ? "PASS" : "FAIL"}  ${task.spec.id}`);
    for (const detail of details) console.log(`        ${detail}`);
    for (const reason of record.reasons) console.log(`        ! ${reason}`);
    if (!record.ok) failures += 1;
  }

  console.log(`\n${tasks.length - failures}/${tasks.length} tasks validated`);
  return failures > 0 ? 1 : 0;
}

async function runCommand(parsed: Parsed): Promise<number> {
  const resolved = paths(parsed);
  const agentFile = flag(parsed, "agent");
  if (!agentFile) {
    console.error("run needs --agent <config file>. See agents/README.md for the format.");
    return 2;
  }

  const info = await harnessInfo();
  const agent = await loadAgentConfig(resolve(REPO_ROOT, agentFile));
  const version = await agentVersion(agent);
  const tasks = await selectTasks(parsed, resolved.tasksDir);
  const attemptsOverride = number(parsed, "attempts");
  const stepTimeoutMs = (number(parsed, "step-timeout") ?? 0) * 1000 || undefined;
  const keep = bool(parsed, "keep");

  if (tasks.length === 0) {
    console.error("no tasks selected");
    return 2;
  }

  const planned = tasks.reduce(
    (total, task) => total + (attemptsOverride ?? task.spec.budget.attempts),
    0,
  );

  if (bool(parsed, "dry-run")) {
    console.log(`agent      ${agent.name}${version ? ` ${version}` : ""}`);
    console.log(`command    ${agent.command}`);
    console.log(`prompt     via ${agent.prompt_delivery}`);
    console.log(`usage      ${agent.usage.kind}`);
    for (const task of tasks) {
      const attempts = attemptsOverride ?? task.spec.budget.attempts;
      console.log(
        `\n${task.spec.id}  ${task.spec.platform}  attempts ${attempts}  wall-clock ${task.spec.budget.wall_clock_seconds}s`,
      );
      for (const step of planOracle(task)) {
        console.log(`  $ ${step.command}`);
      }
    }
    console.log(`\n${tasks.length} tasks, ${planned} trials planned. Nothing was run.`);
    return 0;
  }

  const validations = latestValidations(await readValidations(resolved.validationsPath));
  const unvalidated = tasks.filter((task) => !validations.get(task.spec.id)?.ok);
  if (unvalidated.length > 0) {
    console.log(
      `warning: ${unvalidated.length} of ${tasks.length} tasks are not validated ` +
        `(run plumbline validate); their numbers are provisional`,
    );
  }

  const runId = `${localDate(new Date())}-${randomHex(3)}`;
  console.log(`run ${runId} · agent ${agent.name}${version ? ` ${version}` : ""} · ${planned} trials\n`);

  let ungraded = 0;
  for (const task of tasks) {
    const attempts = attemptsOverride ?? task.spec.budget.attempts;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      process.stdout.write(`${task.spec.id} · attempt ${attempt}/${attempts} … `);

      const record = await runTrial({
        task,
        agent,
        agentVersion: version,
        runId,
        attempt,
        attemptsPlanned: attempts,
        harness: info,
        workRoot: resolved.workRoot,
        stepTimeoutMs,
        keep,
      });
      await appendTrial(resolved.ledgerPath, record);

      if (!keep) {
        await rm(trialScratchPath({ workRoot: resolved.workRoot, task, attempt }), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }

      if (record.verdict === "error") ungraded += 1;
      console.log(
        `${record.verdict} · ${formatDuration(record.duration_ms)} · ${record.changed_files} files changed · ` +
          `${formatCost(record.usage.cost_usd)}${record.failure_mode ? ` · ${record.failure_mode}` : ""}`,
      );
    }
  }

  const records = (await readTrials(resolved.ledgerPath)).filter((record) => record.run_id === runId);
  const { dir } = await buildReport({
    records,
    outRoot: resolved.reportDir,
    validations: await readValidations(resolved.validationsPath),
    indexFile: bool(parsed, "no-index") ? null : undefined,
  });

  console.log(`\nreport: ${dir}`);
  if (ungraded > 0) {
    console.log(`${ungraded} of ${records.length} trials could not be graded and are excluded from pass rates`);
  }
  return ungraded === records.length ? 1 : 0;
}

async function reportCommand(parsed: Parsed): Promise<number> {
  const resolved = paths(parsed);
  const records = await readTrials(resolved.ledgerPath);

  if (records.length === 0) {
    console.error(`no trials in ${resolved.ledgerPath}`);
    return 1;
  }

  const runId = flag(parsed, "run") ?? records[records.length - 1]!.run_id;
  const selected = records.filter((record) => record.run_id === runId);
  if (selected.length === 0) {
    console.error(`no trials for run ${runId}`);
    return 1;
  }

  const { dir } = await buildReport({
    records: selected,
    outRoot: resolved.reportDir,
    validations: await readValidations(resolved.validationsPath),
    indexFile: bool(parsed, "no-index") ? null : undefined,
  });

  console.log(`report: ${dir}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case "":
    case "help":
      console.log(USAGE);
      return 0;
    case "version": {
      const info = await harnessInfo();
      console.log(`plumbline ${info.version}${info.suite_commit ? ` (${info.suite_commit.slice(0, 7)})` : ""}`);
      return 0;
    }
    case "doctor":
      return doctorCommand(parsed);
    case "tasks":
      return tasksCommand(parsed);
    case "validate":
      return validateCommand(parsed);
    case "run":
      return runCommand(parsed);
    case "report":
      return reportCommand(parsed);
    default:
      console.error(`unknown command: ${parsed.command}\n`);
      console.log(USAGE);
      return 2;
  }
}

if (import.meta.main) {
  try {
    installSignalCleanup();
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
