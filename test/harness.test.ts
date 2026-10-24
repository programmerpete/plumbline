import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { loadAgentConfig } from "../src/agent.ts";
import { REPO_ROOT, runShell, statOrNull } from "../src/exec.ts";
import { randomHex } from "../src/format.ts";
import { gradeTask, OracleUnavailableError } from "../src/oracle.ts";
import { TaskSpecSchema, type AgentConfig as AgentConfigType } from "../src/schema.ts";
import { materialise, measureChanges, runSetup } from "../src/scratch.ts";
import { loadTaskFile, type LoadedTask } from "../src/task.ts";
import { runTrial } from "../src/trial.ts";

const TMP_ROOT = join(REPO_ROOT, ".plumbline", "test-tmp", "harness");
const HARNESS = { version: "test", suite_commit: null };
const isMac = process.platform === "darwin";

function tmp(name: string): string {
  return join(TMP_ROOT, `${name}-${randomHex(3)}`);
}

function fixtureTask(name: string): Promise<LoadedTask> {
  return loadTaskFile(join(REPO_ROOT, "fixtures", "tasks", `${name}.yaml`));
}

function stubAgent(name: string): Promise<AgentConfigType> {
  return loadAgentConfig(join(REPO_ROOT, "agents", "self-test", `${name}.json`));
}

/** A task built in memory, so a test can state one unusual field without a file. */
function syntheticTask(id: string, spec: Record<string, unknown>): LoadedTask {
  return {
    spec: TaskSpecSchema.parse({
      id,
      title: id,
      source: { kind: "path", path: "fixtures/self-test-cart" },
      budget: {},
      prompt: "Do the work.",
      ...spec,
    }),
    file: join(TMP_ROOT, `${id}.yaml`),
    dir: TMP_ROOT,
  };
}

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
});

describe("scratch checkout", () => {
  test("a path source is copied and baselined with git", async () => {
    const task = await fixtureTask("self-test-cart");
    const dest = tmp("materialise");
    await materialise(task, dest);

    expect((await statOrNull(join(dest, "src", "cart.js")))?.isFile()).toBe(true);
    expect((await statOrNull(join(dest, ".git")))?.isDirectory()).toBe(true);

    const log = await runShell("git log --oneline", { cwd: dest });
    expect(log.stdout.trim().split("\n")).toHaveLength(1);

    const exclude = await Bun.file(join(dest, ".git", "info", "exclude")).text();
    expect(exclude).toContain(".plumbline/");
  });

  test("build output and prompt files are not agent work", async () => {
    const task = await fixtureTask("self-test-cart");
    const dest = tmp("excludes");
    await materialise(task, dest);

    await Bun.write(join(dest, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
    await Bun.write(join(dest, ".plumbline", "prompt.md"), "the prompt\n");
    await Bun.write(join(dest, "DerivedData", "junk"), "junk\n");

    const changes = await measureChanges(dest);
    expect(changes.changed_files).toBe(0);
    expect(changes.added).toBe(0);
  });

  test("a tracked edit is measured, with a patch to check later", async () => {
    const task = await fixtureTask("self-test-cart");
    const dest = tmp("edit");
    await materialise(task, dest);

    const source = await Bun.file(join(dest, "src", "cart.js")).text();
    const edited = source.replace("return subtotal(items) - discountRate;", "return subtotal(items) * 2;");
    expect(edited).not.toBe(source);
    await Bun.write(join(dest, "src", "cart.js"), edited);

    const changes = await measureChanges(dest);
    expect(changes.changed_files).toBe(1);
    expect(changes.added).toBe(1);
    expect(changes.removed).toBe(1);
    expect(changes.patch).toContain("-  return subtotal(items) - discountRate;");
  });

  test("a new file counts as work", async () => {
    const task = await fixtureTask("self-test-cart");
    const dest = tmp("newfile");
    await materialise(task, dest);

    await Bun.write(join(dest, "src", "extra.js"), "export const added = true;\n");

    const changes = await measureChanges(dest);
    expect(changes.changed_files).toBe(1);
    expect(changes.added).toBe(1);
    expect(changes.patch).toContain("new file mode");
  });

  test("setup stops at the first failing step", async () => {
    const task = syntheticTask("setup-fails", { platform: "local", local: { test: ["true"] }, setup: ["true", "exit 7", "touch never-ran"] });
    const dest = tmp("setup");
    await materialise(task, dest);

    const result = await runSetup(task, dest, {}, 10_000);

    expect(result.failed?.command).toBe("exit 7");
    expect(result.steps).toHaveLength(2);
    expect(await statOrNull(join(dest, "never-ran"))).toBeNull();
  });
});

describe("oracle grading", () => {
  test("every step passing is a pass", async () => {
    const task = syntheticTask("oracle-pass", { platform: "local", local: { test: ["true"] } });
    const grade = await gradeTask(task, TMP_ROOT);
    expect(grade.verdict).toBe("pass");
    expect(grade.failure_mode).toBeNull();
    expect(grade.steps.map((step) => step.name)).toEqual(["test"]);
  });

  test("a failing test step is tests_failed", async () => {
    const task = syntheticTask("oracle-tests", { platform: "local", local: { test: ["echo boom >&2; exit 1"] } });
    const grade = await gradeTask(task, TMP_ROOT);
    expect(grade.verdict).toBe("fail");
    expect(grade.failure_mode).toBe("tests_failed");
    expect(grade.steps[0]!.output_tail).toContain("boom");
  });

  test("a failing build step stops before the tests run", async () => {
    const task = syntheticTask("oracle-build", {
      platform: "local",
      local: { build: ["exit 3"], test: ["touch should-not-exist"] },
    });
    const grade = await gradeTask(task, TMP_ROOT);

    expect(grade.verdict).toBe("fail");
    expect(grade.failure_mode).toBe("build_failed");
    expect(grade.steps).toHaveLength(1);
    expect(await statOrNull(join(TMP_ROOT, "should-not-exist"))).toBeNull();
  });

  test("several steps of the same kind are numbered", async () => {
    const task = syntheticTask("oracle-numbered", {
      platform: "local",
      local: { build: ["true", "true"], test: ["true", "true"] },
    });
    const grade = await gradeTask(task, TMP_ROOT);
    expect(grade.steps.map((step) => step.name)).toEqual(["build 1", "build 2", "test 1", "test 2"]);
  });

  test.skipIf(isMac)("an apple task refuses to grade off macOS", async () => {
    const task = syntheticTask("oracle-apple", {
      platform: "apple",
      apple: { project: "App.xcodeproj", scheme: "App", destination: "platform=iOS Simulator,name=iPhone 17" },
    });
    expect(gradeTask(task, TMP_ROOT)).rejects.toThrow(OracleUnavailableError);
  });
});

describe("one trial", () => {
  test("an agent that does the work passes, and the record shows it", async () => {
    const task = await fixtureTask("self-test-cart");
    const record = await runTrial({
      task,
      agent: await stubAgent("solve"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 2,
      harness: HARNESS,
      workRoot: tmp("trial-pass"),
    });

    expect(record.verdict).toBe("pass");
    expect(record.failure_mode).toBeNull();
    expect(record.changed_files).toBe(1);
    expect(record.agent_exit_code).toBe(0);
    expect(record.agent_timed_out).toBe(false);
    expect(record.attempts_planned).toBe(2);
    expect(record.steps.some((step) => step.name === "test" && step.exit_code === 0)).toBe(true);
    expect(record.usage).toEqual({ input_tokens: null, output_tokens: null, cost_usd: null, source: null });
    expect(record.trial_id).toBe("test-run-self-test-cart-a1");
  });

  test("an agent that changes nothing is no_change, not tests_failed", async () => {
    const task = await fixtureTask("self-test-cart");
    const record = await runTrial({
      task,
      agent: await stubAgent("noop"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 1,
      harness: HARNESS,
      workRoot: tmp("trial-noop"),
    });

    expect(record.verdict).toBe("fail");
    expect(record.failure_mode).toBe("no_change");
    expect(record.changed_files).toBe(0);
    expect(record.notes).toContain("the agent left the checkout untouched");
  });

  test("an agent that exits non-zero is agent_error, and its code is kept", async () => {
    const task = await fixtureTask("self-test-cart");
    const record = await runTrial({
      task,
      agent: await stubAgent("error"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 1,
      harness: HARNESS,
      workRoot: tmp("trial-error"),
    });

    expect(record.verdict).toBe("fail");
    expect(record.failure_mode).toBe("agent_error");
    expect(record.agent_exit_code).toBe(3);
  });

  test("an agent that never returns is killed at the limit, and the trial ends", async () => {
    const task = syntheticTask("agent-hangs", {
      platform: "local",
      budget: { wall_clock_seconds: 1, attempts: 1 },
      local: { test: ["exit 1"] },
    });

    const record = await runTrial({
      task,
      agent: await stubAgent("sleep"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 1,
      harness: HARNESS,
      workRoot: tmp("trial-timeout"),
    });

    expect(record.verdict).toBe("fail");
    expect(record.failure_mode).toBe("timeout");
    expect(record.agent_timed_out).toBe(true);
    // The kill has to reach the agent's grandchildren, not just the shell it ran
    // in. If it does not, this trial sits here for the sleep's full duration.
    expect(record.duration_ms).toBeLessThan(20_000);
  });

  test("a killed agent whose work still passes is a pass, with the kill on the record", async () => {
    // The oracle decides, not how the session ended. An agent that finished the
    // work and then hung must not be scored as a failure, and the timeout has to
    // stay visible in the record so nobody reads the pass as clean.
    const task = syntheticTask("agent-hangs-but-worked", {
      platform: "local",
      budget: { wall_clock_seconds: 1, attempts: 1 },
      local: { test: ["true"] },
    });

    const record = await runTrial({
      task,
      agent: await stubAgent("sleep"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 1,
      harness: HARNESS,
      workRoot: tmp("trial-timeout-pass"),
    });

    expect(record.verdict).toBe("pass");
    expect(record.agent_timed_out).toBe(true);
    expect(record.notes.join(" ")).toContain("killed at the limit but the tests still passed");
  });

  test("a setup failure is recorded as such, and the agent never runs", async () => {
    const task = syntheticTask("setup-fails", {
      platform: "local",
      setup: ["exit 7"],
      local: { test: ["true"] },
    });

    const record = await runTrial({
      task,
      agent: await stubAgent("solve"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 1,
      harness: HARNESS,
      workRoot: tmp("trial-setup"),
    });

    expect(record.verdict).toBe("fail");
    expect(record.failure_mode).toBe("setup_failed");
    expect(record.agent_exit_code).toBeNull();
    expect(record.steps.map((step) => step.name)).toEqual(["setup"]);
  });

  test.skipIf(isMac)("an ungradable trial is an error, not an agent failure", async () => {
    const task = syntheticTask("apple-task", {
      platform: "apple",
      apple: { project: "App.xcodeproj", scheme: "App", destination: "platform=iOS Simulator,name=iPhone 17" },
    });

    const record = await runTrial({
      task,
      agent: await stubAgent("noop"),
      agentVersion: null,
      runId: "test-run",
      attempt: 1,
      attemptsPlanned: 1,
      harness: HARNESS,
      workRoot: tmp("trial-apple"),
    });

    expect(record.verdict).toBe("error");
    expect(record.failure_mode).toBe("oracle_error");
    expect(record.notes.join(" ")).toContain("macOS");
  });
});
