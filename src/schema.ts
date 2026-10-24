import { z } from "zod";

/**
 * The two contracts in this file are the stable public API of plumbline:
 *
 *   TaskSpec    — what a task author writes (YAML).
 *   TrialRecord — what a run produces (JSONL in the ledger).
 *
 * Everything else in `src/` is an implementation detail behind those two.
 */

export const FAILURE_MODES = [
  "setup_failed",
  "build_failed",
  "tests_failed",
  "no_change",
  "timeout",
  "agent_error",
  "oracle_error",
] as const;

export const FailureModeSchema = z.enum(FAILURE_MODES);
export type FailureMode = z.infer<typeof FailureModeSchema>;

export const PLATFORMS = ["apple", "local"] as const;

const BudgetSchema = z.object({
  /** Hard limit on one agent session. Seconds, not minutes, so fixtures can use 2. */
  wall_clock_seconds: z.number().int().positive().default(1800),
  /** Independent trials per task. pass@k is computed from these. */
  attempts: z.number().int().positive().max(10).default(1),
});

const SourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git"),
    url: z.string().min(1),
    commit: z.string().min(1),
  }),
  z.object({
    /** A directory in this repository, copied and baselined with git. Used by the self-tests. */
    kind: z.literal("path"),
    path: z.string().min(1),
  }),
]);

const AppleTargetSchema = z
  .object({
    project: z.string().optional(),
    workspace: z.string().optional(),
    scheme: z.string().min(1),
    /** Passed to -destination verbatim, e.g. "platform=iOS Simulator,name=iPhone 17". */
    destination: z.string().min(1),
    derived_data: z.string().optional(),
    /** Collect a post-run simulator screenshot as evidence. Never part of the verdict. */
    capture_screenshot: z.boolean().default(false),
  })
  .refine((t) => Boolean(t.project) !== Boolean(t.workspace), {
    message: "declare exactly one of apple.project or apple.workspace",
  });

const LocalTargetSchema = z.object({
  /** Steps run before the oracle. A failure here is build_failed. */
  build: z.array(z.string()).default([]),
  /** The oracle. Exit 0 on every command is a pass. */
  test: z.array(z.string()).min(1),
});

const TaskBase = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, "ids are lowercase, hyphen-separated"),
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source: SourceSchema,
  /** Commands run once in the scratch checkout before the agent starts. */
  setup: z.array(z.string()).default([]),
  budget: BudgetSchema,
  prompt: z.string().min(1),
  /**
   * A patch that satisfies the oracle. `plumbline validate` uses it to prove the
   * oracle is satisfiable, which is what stops a task being impossible to pass.
   */
  reference_patch: z.string().optional(),
};

export const TaskSpecSchema = z.discriminatedUnion("platform", [
  z.object({ ...TaskBase, platform: z.literal("apple"), apple: AppleTargetSchema }),
  z.object({ ...TaskBase, platform: z.literal("local"), local: LocalTargetSchema }),
]);

export type TaskSpec = z.infer<typeof TaskSpecSchema>;
export type AppleTarget = z.infer<typeof AppleTargetSchema>;
export type LocalTarget = z.infer<typeof LocalTargetSchema>;

export const UsageSchema = z.object({
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cost_usd: z.number().nullable(),
  /** Which part of the agent's output the numbers came from, or null when unknown. */
  source: z.string().nullable(),
});

export type Usage = z.infer<typeof UsageSchema>;

export const UNKNOWN_USAGE: Usage = {
  input_tokens: null,
  output_tokens: null,
  cost_usd: null,
  source: null,
};

export const OracleStepSchema = z.object({
  name: z.string(),
  command: z.string(),
  exit_code: z.number(),
  duration_ms: z.number(),
  /** Tail of the combined output, kept in the ledger so a verdict can be checked later. */
  output_tail: z.string(),
});

export type OracleStep = z.infer<typeof OracleStepSchema>;

/**
 * Agent drivers are data, not code: plumbline ships no provider SDK and makes no
 * network calls of its own. Point it at a CLI you already have.
 */
export const AgentConfigSchema = z.object({
  name: z.string().min(1),
  /** Run with `bash -c` in the scratch checkout. */
  command: z.string().min(1),
  prompt_delivery: z.enum(["stdin", "argument", "file"]).default("stdin"),
  /** Flag used by "argument" (the prompt) and "file" (the prompt file path). */
  prompt_flag: z.string().optional(),
  /** e.g. "claude --version" — recorded in the report so results carry their tool version. */
  version_command: z.string().optional(),
  usage: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({
        kind: z.literal("json"),
        /** Dot paths into the last JSON object printed on stdout. */
        input_tokens: z.string().optional(),
        output_tokens: z.string().optional(),
        cost_usd: z.string().optional(),
        model: z.string().optional(),
      }),
      z.object({
        kind: z.literal("regex"),
        /** Named groups: input_tokens, output_tokens, cost_usd, model. */
        pattern: z.string().min(1),
      }),
    ])
    .default({ kind: "none" }),
  env: z.record(z.string(), z.string()).default({}),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

export const TrialRecordSchema = z.object({
  schema_version: z.literal(1),
  run_id: z.string(),
  trial_id: z.string(),
  task_id: z.string(),
  task_title: z.string(),
  platform: z.enum(PLATFORMS),
  attempt: z.number().int().positive(),
  attempts_planned: z.number().int().positive(),
  agent: z.object({
    name: z.string(),
    command: z.string(),
    version: z.string().nullable(),
    model: z.string().nullable(),
  }),
  harness: z.object({
    version: z.string(),
    suite_commit: z.string().nullable(),
  }),
  started_at: z.string(),
  ended_at: z.string(),
  duration_ms: z.number(),
  agent_duration_ms: z.number(),
  agent_exit_code: z.number().nullable(),
  agent_timed_out: z.boolean(),
  /**
   * "error" means the trial could not be graded at all (no macOS, no Xcode, a
   * harness fault). Those trials are excluded from pass rates and reported
   * separately, because counting them as agent failures would flatter nothing.
   */
  verdict: z.enum(["pass", "fail", "error"]),
  failure_mode: FailureModeSchema.nullable(),
  changed_files: z.number(),
  diff: z.object({ added: z.number(), removed: z.number() }),
  steps: z.array(OracleStepSchema),
  usage: UsageSchema,
  artifacts: z.array(z.string()),
  notes: z.array(z.string()),
});

export type TrialRecord = z.infer<typeof TrialRecordSchema>;

/**
 * A task's numbers are only published if the task itself was checked: the oracle
 * must fail on the untouched checkout and pass with the reference patch. The
 * content hash is over the task file, the patch, and the pinned source, so editing
 * a task silently invalidates its earlier validation instead of inheriting it.
 */
export const ValidationRecordSchema = z.object({
  schema_version: z.literal(1),
  task_id: z.string(),
  task_content_hash: z.string(),
  validated_at: z.string(),
  harness_version: z.string(),
  pristine_verdict: z.enum(["pass", "fail", "error"]),
  reference_verdict: z.enum(["pass", "fail", "error"]).nullable(),
  ok: z.boolean(),
  reasons: z.array(z.string()),
});

export type ValidationRecord = z.infer<typeof ValidationRecordSchema>;

export function formatIssues(error: z.ZodError, subject: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `  ${path}: ${issue.message}` : `  ${issue.message}`;
  });
  return `${subject} is not valid:\n${lines.join("\n")}`;
}
