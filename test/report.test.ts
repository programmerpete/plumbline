import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../src/exec.ts";
import { randomHex } from "../src/format.ts";
import { buildReport, summariseTasks } from "../src/report.ts";
import type { FailureMode, TrialRecord, ValidationRecord } from "../src/schema.ts";

const TMP_ROOT = join(REPO_ROOT, ".plumbline", "test-tmp", "report");
const RUN_ID = "2026-01-01-abc123";

function tmp(name: string): string {
  return join(TMP_ROOT, `${name}-${randomHex(3)}`);
}

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

type RecordInput = {
  task: string;
  attempt: number;
  verdict: TrialRecord["verdict"];
  failure_mode?: FailureMode | null;
  duration_ms?: number;
  /** Omit for a trial whose cost the agent never reported. */
  cost_usd?: number;
  run_id?: string;
};

function makeRecord(input: RecordInput): TrialRecord {
  const reported = input.cost_usd !== undefined;
  return {
    schema_version: 1,
    run_id: input.run_id ?? RUN_ID,
    trial_id: `${input.run_id ?? RUN_ID}-${input.task}-a${input.attempt}`,
    task_id: input.task,
    task_title: `Task ${input.task}`,
    platform: "apple",
    attempt: input.attempt,
    attempts_planned: 3,
    agent: { name: "test-agent", command: "agent --go", version: "1.0.0", model: "test-model" },
    harness: { version: "test", suite_commit: "abcdef1234567890abcdef1234567890abcdef12" },
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:10:00.000Z",
    duration_ms: input.duration_ms ?? 600_000,
    agent_duration_ms: 540_000,
    agent_exit_code: 0,
    agent_timed_out: false,
    verdict: input.verdict,
    failure_mode: input.failure_mode ?? null,
    changed_files: 2,
    diff: { added: 10, removed: 4 },
    steps: [],
    usage: {
      input_tokens: reported ? 1000 : null,
      output_tokens: reported ? 200 : null,
      cost_usd: input.cost_usd ?? null,
      source: reported ? "stdout json" : null,
    },
    artifacts: [],
    notes: [],
  };
}

function makeValidation(task: string, ok: boolean): ValidationRecord {
  return {
    schema_version: 1,
    task_id: task,
    task_content_hash: "0".repeat(16),
    validated_at: "2026-01-01T00:00:00.000Z",
    harness_version: "test",
    pristine_verdict: "fail",
    reference_verdict: ok ? "pass" : "fail",
    ok,
    reasons: [],
  };
}

async function render(
  records: TrialRecord[],
  validations: ValidationRecord[] = [],
): Promise<{ markdown: string; dir: string; outRoot: string }> {
  const outRoot = tmp("out");
  // The real default is the repository README; a test must not write to that.
  const { dir } = await buildReport({
    records,
    outRoot,
    validations,
    indexFile: join(outRoot, "README.md"),
  });
  return { markdown: await Bun.file(join(dir, "README.md")).text(), dir, outRoot };
}

describe("pass rates", () => {
  test("pass@1 counts the first attempt and pass@k counts any", () => {
    const summaries = summariseTasks(
      [
        makeRecord({ task: "a", attempt: 1, verdict: "pass" }),
        makeRecord({ task: "a", attempt: 2, verdict: "pass" }),
        makeRecord({ task: "a", attempt: 3, verdict: "fail", failure_mode: "tests_failed" }),
        makeRecord({ task: "b", attempt: 1, verdict: "fail", failure_mode: "tests_failed" }),
        makeRecord({ task: "b", attempt: 2, verdict: "fail", failure_mode: "no_change" }),
        makeRecord({ task: "b", attempt: 3, verdict: "fail", failure_mode: "tests_failed" }),
      ],
      [],
    );

    const a = summaries.find((summary) => summary.task_id === "a")!;
    const b = summaries.find((summary) => summary.task_id === "b")!;

    expect(a.pass_at_1).toBe(1);
    expect(a.pass_at_k).toBe(1);
    expect(a.k).toBe(3);
    expect(b.pass_at_1).toBe(0);
    expect(b.pass_at_k).toBe(0);
    expect(b.dominant_failure).toBe("tests_failed");
  });

  test("a task that only passes on a later attempt scores 0 for pass@1 and 1 for pass@k", () => {
    const summaries = summariseTasks(
      [
        makeRecord({ task: "a", attempt: 1, verdict: "fail", failure_mode: "tests_failed" }),
        makeRecord({ task: "a", attempt: 2, verdict: "pass" }),
      ],
      [],
    );
    expect(summaries[0]!.pass_at_1).toBe(0);
    expect(summaries[0]!.pass_at_k).toBe(1);
  });

  test("ungraded trials are excluded from the rates, not counted as failures", () => {
    const summaries = summariseTasks(
      [
        makeRecord({ task: "a", attempt: 1, verdict: "pass" }),
        makeRecord({ task: "b", attempt: 1, verdict: "fail", failure_mode: "tests_failed" }),
        makeRecord({ task: "c", attempt: 1, verdict: "error", failure_mode: "oracle_error" }),
      ],
      [],
    );

    const c = summaries.find((summary) => summary.task_id === "c")!;
    expect(c.pass_at_1).toBeNull();
    expect(c.pass_at_k).toBeNull();
    expect(c.graded).toBe(0);
    expect(c.ungraded).toBe(1);
  });

  test("the headline rates are over graded tasks only, and say so", async () => {
    const { markdown } = await render([
      makeRecord({ task: "a", attempt: 1, verdict: "pass" }),
      makeRecord({ task: "b", attempt: 1, verdict: "fail", failure_mode: "tests_failed" }),
      makeRecord({ task: "c", attempt: 1, verdict: "error", failure_mode: "oracle_error" }),
    ]);

    expect(markdown).toContain("| pass@1 | 50% (1/2 tasks) |");
    expect(markdown).toContain("| pass@k | 50% (1/2 tasks) |");
    expect(markdown).toContain("**ungraded** 1");
  });
});

describe("cost", () => {
  test("known cost is summed and unknown cost stays unknown", () => {
    const summaries = summariseTasks(
      [
        makeRecord({ task: "a", attempt: 1, verdict: "pass", cost_usd: 0.1 }),
        makeRecord({ task: "a", attempt: 2, verdict: "fail", failure_mode: "tests_failed" }),
        makeRecord({ task: "a", attempt: 3, verdict: "fail", failure_mode: "tests_failed" }),
      ],
      [],
    );

    expect(summaries[0]!.cost_usd).toBeCloseTo(0.1, 6);
    expect(summaries[0]!.cost_unknown).toBe(2);
  });

  test("the report states how much of the cost is unreported", async () => {
    const { markdown } = await render([
      makeRecord({ task: "a", attempt: 1, verdict: "pass", cost_usd: 0.1 }),
      makeRecord({ task: "a", attempt: 2, verdict: "fail", failure_mode: "tests_failed" }),
      makeRecord({ task: "a", attempt: 3, verdict: "fail", failure_mode: "tests_failed" }),
    ]);

    expect(markdown).toContain("$0.100 across 1 of 3 trials (2 unreported)");
  });

  test("a run with no reported cost says nothing rather than zero", async () => {
    const { markdown } = await render([makeRecord({ task: "a", attempt: 1, verdict: "pass" })]);
    expect(markdown).toContain("| cost | — across 0 of 1 trials (1 unreported) |");
  });
});

describe("validity", () => {
  test("validated, stale and unvalidated tasks are distinguished", () => {
    const summaries = summariseTasks(
      [
        makeRecord({ task: "a", attempt: 1, verdict: "pass" }),
        makeRecord({ task: "b", attempt: 1, verdict: "pass" }),
        makeRecord({ task: "c", attempt: 1, verdict: "pass" }),
      ],
      [makeValidation("a", true), makeValidation("b", false)],
    );

    expect(summaries.find((summary) => summary.task_id === "a")!.validity).toBe("valid");
    expect(summaries.find((summary) => summary.task_id === "b")!.validity).toBe("stale");
    expect(summaries.find((summary) => summary.task_id === "c")!.validity).toBe("unvalidated");
  });

  test("the report says how many tasks were validated", async () => {
    const { markdown } = await render(
      [
        makeRecord({ task: "a", attempt: 1, verdict: "pass" }),
        makeRecord({ task: "b", attempt: 1, verdict: "pass" }),
      ],
      [makeValidation("a", true)],
    );

    expect(markdown).toContain("tasks validated: 1/2");
    expect(markdown).toContain("provisional");
  });
});

describe("the report as an artifact", () => {
  test("failure taxonomy counts every graded failure", async () => {
    const { markdown } = await render([
      makeRecord({ task: "a", attempt: 1, verdict: "fail", failure_mode: "tests_failed" }),
      makeRecord({ task: "b", attempt: 1, verdict: "fail", failure_mode: "tests_failed" }),
      makeRecord({ task: "c", attempt: 1, verdict: "fail", failure_mode: "no_change" }),
      makeRecord({ task: "d", attempt: 1, verdict: "pass" }),
    ]);

    // Share of graded trials, which is what the column says: 2 of 4 graded trials
    // failed on the tests, 1 of 4 changed nothing, 1 passed.
    expect(markdown).toContain("| tests_failed | 2 | 50% |");
    expect(markdown).toContain("| no_change | 1 | 25% |");
  });

  test("a clean run says so in words instead of an empty table", async () => {
    const { markdown } = await render([makeRecord({ task: "a", attempt: 1, verdict: "pass" })]);
    expect(markdown).toContain("No graded trial failed, out of 1 graded trial.");
  });

  test("writes the report, the csv and the records it was built from", async () => {
    const { dir } = await render([
      makeRecord({ task: "a", attempt: 1, verdict: "pass", cost_usd: 0.25 }),
    ]);

    const csv = await Bun.file(join(dir, "summary.csv")).text();
    const lines = csv.trim().split("\n");
    expect(lines[0]).toContain("task_id,attempt,verdict");
    expect(lines[1]).toContain("a,1,pass");
    expect(lines[1]).toContain("0.25");

    const records = (await Bun.file(join(dir, "trials.jsonl")).text()).trim().split("\n");
    expect(records).toHaveLength(1);
    expect(JSON.parse(records[0]!).task_id).toBe("a");
  });

  test("rebuilding a report does not duplicate its index entry", async () => {
    const records = [makeRecord({ task: "a", attempt: 1, verdict: "pass" })];
    const outRoot = tmp("index");
    const indexFile = join(outRoot, "README.md");
    await buildReport({ records, outRoot, validations: [], indexFile });
    await buildReport({ records, outRoot, validations: [], indexFile });

    const index = await Bun.file(join(outRoot, "README.md")).text();
    const entries = index.split("\n").filter((line) => line.includes(`${RUN_ID}/README.md`));
    expect(entries).toHaveLength(1);
  });

  test("a newer run is listed above an older one", async () => {
    const outRoot = tmp("index-order");
    const indexFile = join(outRoot, "README.md");
    await buildReport({
      records: [makeRecord({ task: "a", attempt: 1, verdict: "pass" })],
      outRoot,
      validations: [],
      indexFile,
    });
    await buildReport({
      records: [
        makeRecord({ task: "a", attempt: 1, verdict: "pass", run_id: "2026-02-02-def456" }),
      ],
      outRoot,
      validations: [],
      indexFile,
    });

    const index = await Bun.file(join(outRoot, "README.md")).text();
    const newer = index.indexOf("2026-02-02-def456");
    const older = index.indexOf(RUN_ID);
    expect(newer).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
  });

  test("an empty record set is refused rather than published", () => {
    expect(buildReport({ records: [], outRoot: tmp("empty"), validations: [] })).rejects.toThrow(
      "no trials to report",
    );
  });
});
