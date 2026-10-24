import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { runShell, shellQuote } from "./exec.ts";
import {
  AgentConfigSchema,
  formatIssues,
  UNKNOWN_USAGE,
  type AgentConfig,
  type Usage,
} from "./schema.ts";

/**
 * plumbline ships no provider SDK and makes no model calls of its own. An agent is
 * a command you already have; this module only knows how to hand it a prompt and
 * read back what it cost.
 */

export const PROMPT_FILE = join(".plumbline", "prompt.md");

export type AgentRun = {
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  stdout: string;
  stderr: string;
  usage: Usage;
  model: string | null;
};

export async function loadAgentConfig(file: string): Promise<AgentConfig> {
  const handle = Bun.file(file);
  if (!(await handle.exists())) {
    throw new Error(`agent config not found: ${file}`);
  }

  const text = await handle.text();
  const raw = file.endsWith(".json") ? JSON.parse(text) : Bun.YAML.parse(text);
  const parsed = AgentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(formatIssues(parsed.error, file));
  }
  return parsed.data;
}

export function buildAgentCommand(config: AgentConfig, prompt: string, promptFile: string | null): string {
  switch (config.prompt_delivery) {
    case "stdin":
      return config.command;
    case "argument":
      return `${config.command} ${shellQuote(config.prompt_flag ?? "-p")} ${shellQuote(prompt)}`;
    case "file": {
      if (!promptFile) throw new Error("file delivery needs a prompt file path");
      return `${config.command} ${shellQuote(config.prompt_flag ?? "-p")} ${shellQuote(promptFile)}`;
    }
  }
}

export async function runAgent(
  config: AgentConfig,
  prompt: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<AgentRun> {
  const promptFile = config.prompt_delivery === "file" ? join(cwd, PROMPT_FILE) : null;
  if (promptFile) {
    await mkdir(dirname(promptFile), { recursive: true });
    await Bun.write(promptFile, prompt);
  }

  const result = await runShell(buildAgentCommand(config, prompt, promptFile), {
    cwd,
    env: { ...env, ...config.env },
    stdin: config.prompt_delivery === "stdin" ? prompt : undefined,
    timeoutMs,
  });

  const parsed = parseUsage(config, result.stdout, result.stderr);
  return {
    exit_code: result.exit_code,
    timed_out: result.timed_out,
    duration_ms: result.duration_ms,
    stdout: result.stdout,
    stderr: result.stderr,
    usage: parsed.usage,
    model: parsed.model,
  };
}

export async function agentVersion(config: AgentConfig): Promise<string | null> {
  if (!config.version_command) return null;
  const result = await runShell(config.version_command, { timeoutMs: 30_000 });
  if (result.exit_code !== 0) return null;
  const first = result.stdout.trim().split("\n")[0]?.trim();
  return first ? first.slice(0, 120) : null;
}

export function parseUsage(
  config: AgentConfig,
  stdout: string,
  stderr: string,
): { usage: Usage; model: string | null } {
  if (config.usage.kind === "none") {
    return { usage: UNKNOWN_USAGE, model: null };
  }

  if (config.usage.kind === "json") {
    const payload = lastJsonObject(stdout);
    if (!payload) return { usage: UNKNOWN_USAGE, model: null };

    const spec = config.usage;
    return {
      usage: {
        input_tokens: toNumber(readPath(payload, spec.input_tokens)),
        output_tokens: toNumber(readPath(payload, spec.output_tokens)),
        cost_usd: toNumber(readPath(payload, spec.cost_usd)),
        source: "stdout json",
      },
      model: toText(readPath(payload, spec.model)),
    };
  }

  const match = new RegExp(config.usage.pattern).exec(`${stdout}\n${stderr}`);
  const groups = match?.groups;
  if (!groups) return { usage: UNKNOWN_USAGE, model: null };

  return {
    usage: {
      input_tokens: toNumber(groups.input_tokens),
      output_tokens: toNumber(groups.output_tokens),
      cost_usd: toNumber(groups.cost_usd),
      source: "stdout regex",
    },
    model: toText(groups.model),
  };
}

/**
 * Agents differ in where they print their JSON: one line, pretty-printed over
 * many lines, or a stream of event objects with the result last. The object that
 * ends latest wins, which is the result in all three shapes.
 *
 * A naive "parse the last line" gets the wrong answer on pretty-printed output,
 * and so does "parse the innermost braces", which would return `usage` itself and
 * silently report no cost at all.
 */
function lastJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    const whole = JSON.parse(trimmed);
    if (whole && typeof whole === "object") return whole;
  } catch {
    // Keep looking: there is other output around it.
  }

  // Usage payloads are printed last, so only the tail is worth scanning.
  const tail = trimmed.slice(-100_000);
  const starts: number[] = [];
  for (let index = 0; index < tail.length; index += 1) {
    if (tail[index] !== "{") continue;
    const previous = index === 0 ? "\n" : tail[index - 1]!;
    if (index === 0 || /\s/.test(previous)) starts.push(index);
  }

  let best: { end: number; value: unknown } | null = null;
  for (const start of starts.slice(-50)) {
    const end = matchingBrace(tail, start);
    if (end === -1) continue;
    if (best && end <= best.end) continue;
    try {
      const parsed = JSON.parse(tail.slice(start, end + 1));
      if (parsed && typeof parsed === "object") best = { end, value: parsed };
    } catch {
      // Try the next candidate.
    }
  }

  return best?.value ?? null;
}

/** Index of the brace closing the object opened at `start`, or -1. */
function matchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function readPath(source: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replaceAll(",", ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function toText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 120);
  return null;
}
