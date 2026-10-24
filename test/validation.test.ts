import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { randomHex } from "../src/format.ts";
import { appendJsonLine, readJsonLines, readTrials } from "../src/ledger.ts";
import { REPO_ROOT } from "../src/exec.ts";
import { TrialRecordSchema } from "../src/schema.ts";
import { loadTaskFile } from "../src/task.ts";
import { taskContentHash, validateTask } from "../src/validate.ts";

const TMP_ROOT = join(REPO_ROOT, ".plumbline", "test-tmp", "validation");

function tmp(name: string): string {
  return join(TMP_ROOT, `${name}-${randomHex(3)}`);
}

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("task validation", () => {
  test("a solvable task passes both checks", async () => {
    const task = await loadTaskFile(join(REPO_ROOT, "fixtures", "tasks", "self-test-cart.yaml"));
    const { record, details } = await validateTask(task, {
      workRoot: tmp("work"),
      harnessVersion: "test",
    });

    expect(record.ok).toBe(true);
    expect(record.pristine_verdict).toBe("fail");
    expect(record.reference_verdict).toBe("pass");
    expect(record.reasons).toEqual([]);
    expect(details.join(" ")).toContain("oracle failed");
  });

  test("a pre-solved task is refused, and says why", async () => {
    // The fixture applies its own fix in `setup`, so the oracle passes before any
    // agent touches it. A task everyone passes measures nothing.
    const task = await loadTaskFile(join(REPO_ROOT, "fixtures", "tasks", "self-test-presolved.yaml"));
    const { record } = await validateTask(task, {
      workRoot: tmp("work"),
      harnessVersion: "test",
    });

    expect(record.ok).toBe(false);
    expect(record.pristine_verdict).toBe("pass");
    expect(record.reasons.join(" ")).toContain("the oracle already passes on the untouched checkout");
  });

  test("a task with no reference patch cannot prove it is solvable", async () => {
    const task = await loadTaskFile(join(REPO_ROOT, "fixtures", "tasks", "self-test-presolved.yaml"));
    const { record } = await validateTask(task, {
      workRoot: tmp("work"),
      harnessVersion: "test",
    });

    expect(record.reference_verdict).toBeNull();
    expect(record.reasons.join(" ")).toContain("no reference_patch");
  });
});

describe("task content hash", () => {
  test("is stable, and changes when the task changes", async () => {
    const file = join(tmp("tasks"), "hash-probe.yaml");
    await Bun.write(
      file,
      [
        "id: hash-probe",
        "title: Hash probe",
        "platform: local",
        "source:",
        "  kind: path",
        "  path: fixtures/self-test-cart",
        "budget: {}",
        "prompt: |",
        "  First wording.",
        "local:",
        "  test:",
        "    - bun test",
        "",
      ].join("\n"),
    );

    const before = await taskContentHash(await loadTaskFile(file));
    expect(await taskContentHash(await loadTaskFile(file))).toBe(before);

    const text = await Bun.file(file).text();
    await Bun.write(file, text.replace("First wording.", "Second wording."));
    const after = await taskContentHash(await loadTaskFile(file));

    expect(after).not.toBe(before);
  });
});

describe("the ledger", () => {
  test("records round-trip", async () => {
    const path = join(tmp("ledger"), "trials.jsonl");
    const record = sampleRecord();

    await appendJsonLine(path, record);
    await appendJsonLine(path, { ...record, attempt: 2 });

    const read = await readTrials(path);
    expect(read).toHaveLength(2);
    expect(read[0]!.attempt).toBe(1);
    expect(read[1]!.attempt).toBe(2);
  });

  test("a missing ledger is empty, not an error", async () => {
    expect(await readTrials(join(tmp("ledger"), "absent.jsonl"))).toEqual([]);
  });

  test("one truncated final line is tolerated, because a crash can leave one", async () => {
    const path = join(tmp("ledger"), "truncated.jsonl");
    await Bun.write(path, `${JSON.stringify(sampleRecord())}\n{"schema_version":1,"run_id":"partial"`);

    expect(await readTrials(path)).toHaveLength(1);
  });

  test("corruption in the middle of the ledger is loud, not skipped", async () => {
    const path = join(tmp("ledger"), "corrupt.jsonl");
    await Bun.write(
      path,
      `${JSON.stringify(sampleRecord())}\nnot json at all\n${JSON.stringify(sampleRecord())}\n`,
    );

    expect(readTrials(path)).rejects.toThrow();
  });

  test("a record missing fields is rejected rather than counted", async () => {
    const path = join(tmp("ledger"), "invalid.jsonl");
    const broken = { ...sampleRecord(), verdict: undefined };
    // Not the final line: a trailing line is the one place a truncated write is
    // allowed to be, and tolerating it there must not become tolerance elsewhere.
    await Bun.write(path, `${JSON.stringify(broken)}\n${JSON.stringify(sampleRecord())}\n`);

    expect(readTrials(path)).rejects.toThrow();
  });

  test("the reader validates against the published schema", () => {
    expect(TrialRecordSchema.safeParse(sampleRecord()).success).toBe(true);
  });
});

function sampleRecord() {
  return {
    schema_version: 1 as const,
    run_id: "2026-01-01-abc123",
    trial_id: "2026-01-01-abc123-example-a1",
    task_id: "example",
    task_title: "Example",
    platform: "local" as const,
    attempt: 1,
    attempts_planned: 3,
    agent: { name: "stub", command: "stub", version: null, model: null },
    harness: { version: "test", suite_commit: null },
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1000,
    agent_duration_ms: 500,
    agent_exit_code: 0,
    agent_timed_out: false,
    verdict: "pass" as const,
    failure_mode: null,
    changed_files: 1,
    diff: { added: 2, removed: 1 },
    steps: [],
    usage: { input_tokens: null, output_tokens: null, cost_usd: null, source: null },
    artifacts: [],
    notes: [],
  };
}

describe("ledger reading uses the schema it was given", () => {
  test("a different schema is honoured", async () => {
    const path = join(tmp("ledger"), "mixed.jsonl");
    await appendJsonLine(path, { schema_version: 1, kind: "anything" });
    await appendJsonLine(path, { schema_version: 1, kind: "anything else" });

    const read = await readJsonLines(
      path,
      TrialRecordSchema,
      "trials",
    ).catch((error: Error) => error.message);

    expect(typeof read === "string" ? read : "").toContain("trials line 1");
  });
});
