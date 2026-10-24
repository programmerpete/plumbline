import { describe, expect, test } from "bun:test";
import { buildAgentCommand, loadAgentConfig, parseUsage } from "../src/agent.ts";
import {
  simulatorScreenshotCommand,
  xcodebuildBuildCommand,
  xcodebuildProjectFlag,
  xcodebuildTestCommand,
} from "../src/apple.ts";
import { REPO_ROOT, shellQuote } from "../src/exec.ts";
import { AgentConfigSchema, TaskSpecSchema, UNKNOWN_USAGE } from "../src/schema.ts";
import { join } from "node:path";

/**
 * These are the contracts that cannot be exercised at runtime on this machine:
 * Apple command construction needs macOS, and a mis-quoted destination is only
 * visible in the string xcodebuild would have received. Exact-string assertions
 * are the strongest check available here, so that is what they are.
 */

const appleTask = {
  id: "example",
  title: "Example",
  platform: "apple",
  source: { kind: "path", path: "fixtures/self-test-cart" },
  budget: {},
  prompt: "Fix it.",
  apple: {
    project: "App.xcodeproj",
    scheme: "App",
    destination: "platform=iOS Simulator,name=iPhone 17",
  },
};

describe("task spec", () => {
  test("budget defaults are explicit and finite", () => {
    const parsed = TaskSpecSchema.parse(appleTask);
    expect(parsed.budget.wall_clock_seconds).toBe(1800);
    expect(parsed.budget.attempts).toBe(1);
    expect(parsed.setup).toEqual([]);
    expect(parsed.tags).toEqual([]);
  });

  test("an apple task without an apple block is rejected", () => {
    const { apple: _dropped, ...withoutApple } = appleTask;
    expect(TaskSpecSchema.safeParse(withoutApple).success).toBe(false);
  });

  test("an apple target must declare exactly one of project or workspace", () => {
    const both = {
      ...appleTask,
      apple: { ...appleTask.apple, workspace: "App.xcworkspace" },
    };
    const neither = {
      ...appleTask,
      apple: { scheme: "App", destination: "platform=iOS Simulator,name=iPhone 17" },
    };

    expect(TaskSpecSchema.safeParse(both).success).toBe(false);
    expect(TaskSpecSchema.safeParse(neither).success).toBe(false);
  });

  test("a local task without test commands is rejected", () => {
    const noTests = {
      id: "example",
      title: "Example",
      platform: "local",
      source: { kind: "path", path: "fixtures/self-test-cart" },
      budget: {},
      prompt: "Fix it.",
      local: { build: ["true"], test: [] },
    };
    expect(TaskSpecSchema.safeParse(noTests).success).toBe(false);
  });

  test("ids must be lowercase and hyphenated", () => {
    expect(TaskSpecSchema.safeParse({ ...appleTask, id: "Not An Id" }).success).toBe(false);
    expect(TaskSpecSchema.safeParse({ ...appleTask, id: "fine-id-2" }).success).toBe(true);
  });
});

describe("apple command construction", () => {
  const spec = TaskSpecSchema.parse(appleTask);
  if (spec.platform !== "apple") throw new Error("the example task must be an apple task");
  const target = spec.apple;

  test("the build command is exactly what xcodebuild should receive", () => {
    expect(xcodebuildBuildCommand(target)).toBe(
      "xcodebuild -project 'App.xcodeproj' -scheme 'App' " +
        "-destination 'platform=iOS Simulator,name=iPhone 17' " +
        "-derivedDataPath '.plumbline/DerivedData' build",
    );
  });

  test("the test command writes a result bundle and ends with the test action", () => {
    const command = xcodebuildTestCommand(target);
    expect(command).toContain("-resultBundlePath '.plumbline/TestResults.xcresult'");
    expect(command.endsWith(" test")).toBe(true);
    expect(command.startsWith("xcodebuild -project 'App.xcodeproj'")).toBe(true);
  });

  test("a workspace target uses -workspace instead of -project", () => {
    const workspace = { ...target, project: undefined, workspace: "App.xcworkspace" };
    expect(xcodebuildProjectFlag(workspace)).toBe("-workspace 'App.xcworkspace'");
  });

  test("a destination containing an apostrophe survives quoting", () => {
    // A device named "Sam's iPhone" would otherwise break the command in half.
    const awkward = { ...target, destination: "platform=iOS Simulator,name=Sam's iPhone" };
    expect(xcodebuildBuildCommand(awkward)).toContain(`-destination 'platform=iOS Simulator,name=Sam'\\''s iPhone'`);
  });

  test("derived data can be overridden by the task", () => {
    const custom = { ...target, derived_data: "/tmp/plumbline-dd" };
    expect(xcodebuildBuildCommand(custom)).toContain("-derivedDataPath '/tmp/plumbline-dd'");
  });

  test("screenshot capture targets the booted simulator", () => {
    expect(simulatorScreenshotCommand("/tmp/shot.png")).toBe(
      "xcrun simctl io booted screenshot '/tmp/shot.png'",
    );
  });
});

describe("shell quoting", () => {
  test("quotes, spaces and empty strings", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("two words")).toBe("'two words'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
  });
});

describe("agent config and invocation", () => {
  test("a config with no delivery or usage declared defaults to stdin and unknown cost", async () => {
    const config = await loadAgentConfig(join(REPO_ROOT, "agents", "self-test", "solve.json"));
    expect(config.prompt_delivery).toBe("stdin");
    expect(config.usage.kind).toBe("none");
    expect(config.env).toEqual({});
  });

  test("stdin delivery leaves the command alone", () => {
    const config = AgentConfigSchema.parse({ name: "a", command: "agent" });
    expect(buildAgentCommand(config, "do the thing", null)).toBe("agent");
  });

  test("argument delivery appends the prompt behind the declared flag", () => {
    const config = AgentConfigSchema.parse({
      name: "a",
      command: "agent",
      prompt_delivery: "argument",
      prompt_flag: "-p",
    });
    expect(buildAgentCommand(config, "fix it's bug", null)).toBe("agent '-p' 'fix it'\\''s bug'");
  });

  test("file delivery appends the prompt file path, and needs one", () => {
    const config = AgentConfigSchema.parse({
      name: "a",
      command: "agent",
      prompt_delivery: "file",
    });
    expect(buildAgentCommand(config, "ignored", "/tmp/prompt.md")).toBe("agent '-p' '/tmp/prompt.md'");
    expect(() => buildAgentCommand(config, "ignored", null)).toThrow();
  });
});

describe("usage parsing", () => {
  const jsonConfig = AgentConfigSchema.parse({
    name: "a",
    command: "agent",
    usage: {
      kind: "json",
      input_tokens: "usage.input_tokens",
      output_tokens: "usage.output_tokens",
      cost_usd: "total_cost_usd",
      model: "model",
    },
  });

  test("reads nested fields and skips noise printed before the payload", () => {
    const stdout = [
      "thinking about it…",
      '{"type":"result","usage":{"input_tokens":1200,"output_tokens":340},',
      '"total_cost_usd":0.0123,"model":"claude-sonnet-5"}',
    ].join("\n");

    const parsed = parseUsage(jsonConfig, stdout, "");
    expect(parsed.usage.input_tokens).toBe(1200);
    expect(parsed.usage.output_tokens).toBe(340);
    expect(parsed.usage.cost_usd).toBe(0.0123);
    expect(parsed.model).toBe("claude-sonnet-5");
  });

  test("a stream of event objects resolves to the last one", () => {
    const stdout = [
      '{"type":"start","model":"claude-sonnet-5"}',
      '{"type":"text","text":"working"}',
      '{"type":"result","usage":{"input_tokens":10,"output_tokens":2},"total_cost_usd":0.5}',
    ].join("\n");

    const parsed = parseUsage(jsonConfig, stdout, "");
    expect(parsed.usage.input_tokens).toBe(10);
    expect(parsed.usage.cost_usd).toBe(0.5);
  });

  test("a brace inside a string does not end the object early", () => {
    const stdout = '{"type":"result","text":"a } brace","total_cost_usd":0.25}';
    expect(parseUsage(jsonConfig, stdout, "").usage.cost_usd).toBe(0.25);
  });

  test("absent numbers stay unknown rather than becoming zero", () => {
    const parsed = parseUsage(jsonConfig, '{"type":"result"}', "");
    expect(parsed.usage.input_tokens).toBeNull();
    expect(parsed.usage.cost_usd).toBeNull();
    expect(parsed.model).toBeNull();
  });

  test("unparseable output stays unknown", () => {
    const parsed = parseUsage(jsonConfig, "no json here at all", "");
    expect(parsed.usage).toEqual(UNKNOWN_USAGE);
  });

  test("numeric strings are coerced, because CLIs print them as strings", () => {
    const parsed = parseUsage(jsonConfig, '{"total_cost_usd":"0.0042"}', "");
    expect(parsed.usage.cost_usd).toBe(0.0042);
  });

  test("regex usage reads named groups from either stream", () => {
    const config = AgentConfigSchema.parse({
      name: "a",
      command: "agent",
      usage: { kind: "regex", pattern: "(?<input_tokens>\\d+) in / (?<output_tokens>\\d+) out" },
    });
    const parsed = parseUsage(config, "", "tokens: 900 in / 120 out");
    expect(parsed.usage.input_tokens).toBe(900);
    expect(parsed.usage.output_tokens).toBe(120);
    expect(parsed.usage.source).toBe("stdout regex");
  });

  test("no usage declared means no usage reported, ever", () => {
    const config = AgentConfigSchema.parse({ name: "a", command: "agent" });
    expect(parseUsage(config, '{"usage":{"input_tokens":5}}', "").usage).toEqual(UNKNOWN_USAGE);
  });
});
