import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/** Repository root, derived from this file's location rather than the caller's cwd. */
export const REPO_ROOT = resolve(dirname(import.meta.dir), ".");

export type ExecResult = {
  command: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
  timed_out: boolean;
};

export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
  /** 0 or undefined means no limit. */
  timeoutMs?: number;
};

export function shellQuote(value: string): string {
  if (value === "") return "''";
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const activeGroups = new Set<number>();

/**
 * Signal a process group rather than a single process. Killing only the shell
 * leaves its grandchildren running, so `bash -c 'sleep 600'` would outlive its own
 * trial and hold the wall-clock limit open for as long as it liked.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Called by the CLI. Without it, Ctrl-C leaves the agent running in its own
 * process group for as long as it wants.
 */
export function installSignalCleanup(): void {
  const shutdown = (signal: NodeJS.Signals) => {
    for (const pid of activeGroups) signalGroup(pid, signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Run one shell command. There is no shell interpolation of untrusted data here:
 * task authors write commands, and plumbline passes them through `bash -c`.
 */
export async function runShell(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const proc = Bun.spawn({
    cmd: ["bash", "-c", command],
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    // Own process group, so a timeout can take the whole tree down with it.
    detached: true,
  });

  activeGroups.add(proc.pid);

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (options.timeoutMs && options.timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      signalGroup(proc.pid, "SIGTERM");
      // Escalate if the agent ignores SIGTERM.
      setTimeout(() => signalGroup(proc.pid, "SIGKILL"), 3000).unref?.();
    }, options.timeoutMs);
  }

  if (options.stdin !== undefined) {
    const sink = proc.stdin;
    if (sink) {
      sink.write(options.stdin);
      await sink.end();
    }
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (timer) clearTimeout(timer);
  activeGroups.delete(proc.pid);

  return {
    command,
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: Date.now() - started,
    timed_out: timedOut,
  };
}

export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function which(binary: string): Promise<string | null> {
  const result = await runShell(`command -v ${shellQuote(binary)}`, { timeoutMs: 10_000 });
  const first = result.stdout.trim().split("\n")[0];
  return result.exit_code === 0 && first ? first : null;
}

export async function git(cwd: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return runShell(["git", ...args.map(shellQuote)].join(" "), { ...options, cwd });
}

export function tail(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `…[${text.length - maxChars} chars truncated]\n${text.slice(-maxChars)}`;
}

export function combineOutput(result: Pick<ExecResult, "stdout" | "stderr">): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");
}
