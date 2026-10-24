import { join } from "node:path";
import { runShell, shellQuote, which } from "./exec.ts";
import type { AppleTarget } from "./schema.ts";

/**
 * Apple-platform grading needs macOS: `xcodebuild` only exists there, and the
 * verdict is a simulator test run rather than a process exit code. Command
 * construction is kept pure and separate from execution so it can be tested on
 * any platform, which is the only way the Linux self-tests can cover this file.
 */

export const SCRATCH_STATE_DIR = ".plumbline";
export const DEFAULT_DERIVED_DATA = join(SCRATCH_STATE_DIR, "DerivedData");
export const DEFAULT_RESULT_BUNDLE = join(SCRATCH_STATE_DIR, "TestResults.xcresult");

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function xcodebuildProjectFlag(target: AppleTarget): string {
  if (target.project) return `-project ${shellQuote(target.project)}`;
  if (target.workspace) return `-workspace ${shellQuote(target.workspace)}`;
  throw new Error("apple target declares neither project nor workspace");
}

export function xcodebuildBuildCommand(target: AppleTarget): string {
  return [
    "xcodebuild",
    xcodebuildProjectFlag(target),
    `-scheme ${shellQuote(target.scheme)}`,
    `-destination ${shellQuote(target.destination)}`,
    `-derivedDataPath ${shellQuote(target.derived_data ?? DEFAULT_DERIVED_DATA)}`,
    "build",
  ].join(" ");
}

export function xcodebuildTestCommand(target: AppleTarget): string {
  return [
    "xcodebuild",
    xcodebuildProjectFlag(target),
    `-scheme ${shellQuote(target.scheme)}`,
    `-destination ${shellQuote(target.destination)}`,
    `-derivedDataPath ${shellQuote(target.derived_data ?? DEFAULT_DERIVED_DATA)}`,
    `-resultBundlePath ${shellQuote(DEFAULT_RESULT_BUNDLE)}`,
    "test",
  ].join(" ");
}

/** Evidence capture, never an assertion. Assertions belong in the UI tests. */
export function simulatorScreenshotCommand(destination: string): string {
  return `xcrun simctl io booted screenshot ${shellQuote(destination)}`;
}

export type AppleTooling = {
  xcodebuild: string | null;
  xcrun: string | null;
  xcode_version: string | null;
  simulator_count: number | null;
};

/** Cheap presence check, used before every Apple grading step. */
export async function appleCommandsAvailable(): Promise<{ xcodebuild: string | null; xcrun: string | null }> {
  if (!isMacOS()) return { xcodebuild: null, xcrun: null };
  const [xcodebuild, xcrun] = await Promise.all([which("xcodebuild"), which("xcrun")]);
  return { xcodebuild, xcrun };
}

export async function appleTooling(): Promise<AppleTooling> {
  if (!isMacOS()) {
    return { xcodebuild: null, xcrun: null, xcode_version: null, simulator_count: null };
  }

  const { xcodebuild, xcrun } = await appleCommandsAvailable();
  const version = xcodebuild ? await runShell("xcodebuild -version", { timeoutMs: 60_000 }) : null;
  const simulators =
    xcrun && xcodebuild
      ? await runShell("xcrun simctl list devices available", { timeoutMs: 60_000 })
      : null;

  return {
    xcodebuild,
    xcrun,
    xcode_version:
      version && version.exit_code === 0
        ? (version.stdout.trim().split("\n")[0] ?? null)
        : null,
    simulator_count: simulators?.exit_code === 0 ? countDevices(simulators.stdout) : null,
  };
}

function countDevices(simctlOutput: string): number {
  return simctlOutput
    .split("\n")
    .filter((line) => /^\s{4}\S/.test(line) && !line.includes("unavailable")).length;
}
