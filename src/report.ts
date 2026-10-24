import { mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { REPO_ROOT } from "./exec.ts";
import { formatCost, formatDuration, formatPercent, median, plural, sum } from "./format.ts";
import { latestValidations } from "./ledger.ts";
import { FAILURE_MODES, type FailureMode, type TrialRecord, type ValidationRecord } from "./schema.ts";

/**
 * A report is a derived view of the ledger: everything here can be rebuilt from
 * `ledger/trials.jsonl`. Nothing is hand-edited afterwards, and a run that goes
 * badly is published with the same prominence as one that goes well.
 */

const INDEX_START = "<!-- REPORTS:START -->";
const INDEX_END = "<!-- REPORTS:END -->";

export type ReportOptions = {
  records: TrialRecord[];
  outRoot: string;
  validations: ValidationRecord[];
  /**
   * Where the run index lives. Omit for the repository README, so the record is the
   * first thing a reader sees rather than a directory they have to find. Pass null
   * to skip the index: a self-test run with stub agents is not a measurement, and it
   * must not appear in the list of runs.
   */
  indexFile?: string | null;
};

export type TaskSummary = {
  task_id: string;
  title: string;
  platform: string;
  attempts: number;
  graded: number;
  ungraded: number;
  pass_at_1: number | null;
  pass_at_k: number | null;
  k: number;
  median_duration_ms: number | null;
  cost_usd: number | null;
  cost_unknown: number;
  dominant_failure: FailureMode | null;
  validity: "valid" | "stale" | "unvalidated";
};

export async function buildReport(options: ReportOptions): Promise<{ dir: string; index: string | null }> {
  const records = [...options.records].sort(
    (a, b) => a.task_id.localeCompare(b.task_id) || a.attempt - b.attempt,
  );
  if (records.length === 0) {
    throw new Error("no trials to report");
  }

  const runId = records[0]!.run_id;
  const summaries = summariseTasks(records, options.validations);
  const dir = join(options.outRoot, runId);

  await mkdir(dir, { recursive: true });
  await Bun.write(join(dir, "README.md"), renderReport(records, summaries));
  await Bun.write(join(dir, "summary.csv"), renderCsv(records));
  await Bun.write(join(dir, "trials.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const indexFile = options.indexFile === undefined ? join(REPO_ROOT, "README.md") : options.indexFile;
  const index = indexFile ? await updateIndex(indexFile, dir, runId, records, summaries) : null;
  return { dir, index };
}

export function summariseTasks(
  records: TrialRecord[],
  validations: ValidationRecord[],
): TaskSummary[] {
  const latest = latestValidations(validations);
  const byTask = new Map<string, TrialRecord[]>();
  for (const record of records) {
    const bucket = byTask.get(record.task_id) ?? [];
    bucket.push(record);
    byTask.set(record.task_id, bucket);
  }

  const summaries: TaskSummary[] = [];
  for (const [taskId, trials] of byTask) {
    const ordered = [...trials].sort((a, b) => a.attempt - b.attempt);
    const graded = ordered.filter((trial) => trial.verdict !== "error");
    const first = ordered[0]!;
    const firstGraded = first.verdict !== "error";

    const failures = new Map<FailureMode, number>();
    for (const trial of graded) {
      if (trial.failure_mode) {
        failures.set(trial.failure_mode, (failures.get(trial.failure_mode) ?? 0) + 1);
      }
    }
    const dominant = [...failures.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    const costs = ordered
      .map((trial) => trial.usage.cost_usd)
      .filter((cost): cost is number => cost !== null);

    const validation = latest.get(taskId);

    summaries.push({
      task_id: taskId,
      title: first.task_title,
      platform: first.platform,
      attempts: ordered.length,
      graded: graded.length,
      ungraded: ordered.length - graded.length,
      pass_at_1: firstGraded ? (first.verdict === "pass" ? 1 : 0) : null,
      pass_at_k: graded.length === 0 ? null : graded.some((trial) => trial.verdict === "pass") ? 1 : 0,
      k: ordered.length,
      median_duration_ms: median(ordered.map((trial) => trial.duration_ms)),
      cost_usd: costs.length > 0 ? sum(costs) : null,
      cost_unknown: ordered.length - costs.length,
      dominant_failure: dominant,
      validity: validation
        ? validation.ok
          ? "valid"
          : "stale"
        : "unvalidated",
    });
  }

  return summaries.sort((a, b) => a.task_id.localeCompare(b.task_id));
}

function renderReport(records: TrialRecord[], summaries: TaskSummary[]): string {
  const runId = records[0]!.run_id;
  const agent = records[0]!.agent;
  const harness = records[0]!.harness;
  const graded = records.filter((record) => record.verdict !== "error");
  const ungraded = records.length - graded.length;

  const firstAttempts = summaries.filter((summary) => summary.pass_at_1 !== null);
  const passAt1 =
    firstAttempts.length > 0
      ? sum(firstAttempts.map((summary) => summary.pass_at_1 ?? 0)) / firstAttempts.length
      : null;
  const kAttempts = summaries.filter((summary) => summary.pass_at_k !== null);
  const passAtK =
    kAttempts.length > 0 ? sum(kAttempts.map((summary) => summary.pass_at_k ?? 0)) / kAttempts.length : null;

  const costs = records.map((r) => r.usage.cost_usd).filter((cost): cost is number => cost !== null);
  const totalCost = costs.length > 0 ? sum(costs) : null;
  const unknownCost = records.length - costs.length;

  const lines: string[] = [];
  lines.push(`# plumbline run \`${runId}\``);
  lines.push("");
  lines.push(
    `**Agent** ${agent.name}${agent.version ? ` ${agent.version}` : ""}` +
      `${agent.model ? ` · **model** ${agent.model}` : " · **model** not reported"}` +
      ` · **attempts per task** ${records[0]!.attempts_planned}`,
  );
  lines.push(
    `**Harness** plumbline ${harness.version}${harness.suite_commit ? ` (\`${harness.suite_commit.slice(0, 7)}\`)` : ""}` +
      ` · **${plural(summaries.length, "task")}** · **${plural(records.length, "trial")}**` +
      `${ungraded > 0 ? ` · **ungraded** ${ungraded}` : ""}`,
  );
  lines.push("");
  lines.push("| | |");
  lines.push("|---|---|");
  lines.push(`| pass@1 | ${formatPercent(passAt1)} (${firstAttempts.filter((s) => s.pass_at_1 === 1).length}/${firstAttempts.length} tasks) |`);
  lines.push(`| pass@k | ${formatPercent(passAtK)} (${kAttempts.filter((s) => s.pass_at_k === 1).length}/${kAttempts.length} tasks) |`);
  lines.push(`| median trial | ${formatDuration(median(records.map((r) => r.duration_ms)) ?? 0)} |`);
  lines.push(`| agent time | ${formatDuration(sum(records.map((r) => r.agent_duration_ms)))} |`);
  lines.push(
    `| cost | ${formatCost(totalCost)}${unknownCost > 0 ? ` across ${costs.length} of ${records.length} trials (${unknownCost} unreported)` : ""} |`,
  );
  lines.push("");
  lines.push("## Tasks");
  lines.push("");
  lines.push("| Task | pass@1 | pass@k | k | median | cost | dominant failure | validated |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const summary of summaries) {
    lines.push(
      [
        `| \`${summary.task_id}\``,
        formatPercent(summary.pass_at_1),
        formatPercent(summary.pass_at_k),
        String(summary.k),
        formatDuration(summary.median_duration_ms ?? 0),
        formatCost(summary.cost_usd),
        summary.dominant_failure ?? "—",
        summary.validity === "valid" ? "yes" : summary.validity,
      ].join(" | ") + " |",
    );
  }
  lines.push("");
  lines.push("## Failure taxonomy");
  lines.push("");
  const gradedFailures = graded.filter((record) => record.failure_mode !== null).length;
  if (gradedFailures === 0) {
    lines.push(`No graded trial failed, out of ${plural(graded.length, "graded trial")}.`);
  } else {
    lines.push("| mode | trials | share of graded |");
    lines.push("|---|---|---|");
    for (const mode of FAILURE_MODES) {
      const count = graded.filter((record) => record.failure_mode === mode).length;
      if (count === 0) continue;
      lines.push(`| ${mode} | ${count} | ${formatPercent(count / Math.max(graded.length, 1))} |`);
    }
  }
  lines.push("");
  lines.push("## Method");
  lines.push("");
  lines.push(
    "- The oracle is the repository's own build and test suite. No rubric, no judge model, no partial credit.",
  );
  lines.push(
    "- pass@1 counts tasks whose first attempt passed; pass@k counts tasks where any attempt passed. Both are over graded trials only.",
  );
  lines.push(
    "- A trial is graded `error` when the oracle could not run at all (no Xcode, no macOS). Those trials are excluded from pass rates rather than counted as agent failures.",
  );
  lines.push(
    "- Failure precedence: timeout, then a non-zero agent exit, then an untouched checkout, then build, then tests. A run that ended badly is a different finding from one that finished and got it wrong.",
  );
  lines.push(
    "- Costs are reported only where the agent reported them. Unreported cost stays unknown; nothing is estimated.",
  );
  lines.push("");
  lines.push("## Provenance");
  lines.push("");
  lines.push(`- run id: \`${runId}\``);
  lines.push(`- agent command: \`${agent.command}\``);
  lines.push(`- every trial, including its oracle output tail: \`trials.jsonl\` beside this file`);
  lines.push(`- per-trial rows: \`summary.csv\` beside this file`);
  lines.push(
    `- tasks validated: ${summaries.filter((s) => s.validity === "valid").length}/${summaries.length}` +
      `${summaries.some((s) => s.validity !== "valid") ? " — tasks marked stale or unvalidated are provisional" : ""}`,
  );
  lines.push("");
  lines.push("Generated by plumbline. Nothing in this report was edited after the run.");
  lines.push("");
  return lines.join("\n");
}

function renderCsv(records: TrialRecord[]): string {
  const header = [
    "task_id",
    "attempt",
    "verdict",
    "failure_mode",
    "duration_ms",
    "agent_duration_ms",
    "agent_exit_code",
    "agent_timed_out",
    "changed_files",
    "added",
    "removed",
    "cost_usd",
    "input_tokens",
    "output_tokens",
    "model",
    "started_at",
  ];
  const rows = records.map((record) =>
    [
      record.task_id,
      record.attempt,
      record.verdict,
      record.failure_mode ?? "",
      record.duration_ms,
      record.agent_duration_ms,
      record.agent_exit_code ?? "",
      record.agent_timed_out,
      record.changed_files,
      record.diff.added,
      record.diff.removed,
      record.usage.cost_usd ?? "",
      record.usage.input_tokens ?? "",
      record.usage.output_tokens ?? "",
      record.agent.model ?? "",
      record.started_at,
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n") + "\n";
}

async function updateIndex(
  path: string,
  reportDir: string,
  runId: string,
  records: TrialRecord[],
  summaries: TaskSummary[],
): Promise<string> {
  const firstAttempts = summaries.filter((summary) => summary.pass_at_1 !== null);
  const passAt1 =
    firstAttempts.length > 0
      ? sum(firstAttempts.map((summary) => summary.pass_at_1 ?? 0)) / firstAttempts.length
      : null;

  const link = `${relative(dirname(path), reportDir)}/README.md`;
  const entry =
    `- [${runId}](${link}) — ${records[0]!.agent.name}, ` +
    `${plural(summaries.length, "task")}, pass@1 ${formatPercent(passAt1)}`;

  const existing = (await Bun.file(path).exists()) ? await Bun.file(path).text() : defaultIndex();
  const start = existing.indexOf(INDEX_START);
  const end = existing.indexOf(INDEX_END);
  if (start === -1 || end === -1) {
    throw new Error(`${path} is missing the ${INDEX_START} / ${INDEX_END} markers`);
  }

  const before = existing.slice(0, start + INDEX_START.length);
  const body = existing.slice(start + INDEX_START.length, end);
  const entries = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .filter((line) => !line.includes(`](${link})`));

  const updated = `${before}\n${[entry, ...entries].join("\n")}\n${existing.slice(end)}`;
  await Bun.write(path, updated);
  return path;
}

function defaultIndex(): string {
  return [
    "# Reports",
    "",
    "Every run appends a directory here, derived from `ledger/trials.jsonl`.",
    "Nothing is edited after the fact: a correction shows up as a later run, not a quiet fix.",
    "",
    INDEX_START,
    INDEX_END,
    "",
  ].join("\n");
}
