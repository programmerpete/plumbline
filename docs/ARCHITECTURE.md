# Architecture

Two contracts, everything else is plumbing:

| Contract | Written by | Read by | Where |
|---|---|---|---|
| `TaskSpec` | a person | the harness | `tasks/*/task.yaml` |
| `TrialRecord` | the harness | everyone | `ledger/trials.jsonl` |

Both are defined once, in [src/schema.ts](../src/schema.ts), and validated on the way
in and on the way out. A record that does not match the schema is not counted — it is
an error, because a ledger that silently drops rows is not evidence.

## The shape of a trial

```
                    ┌──────────────────────────────────────────────┐
   TaskSpec ───────▶│ materialise   clone at the pinned commit, or │
                    │               copy a fixture and baseline it │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ setup         codegen, deps — before the     │
                    │               agent and before the oracle    │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ agent         a command, a prompt, a         │
                    │               wall-clock limit, own process  │
                    │               group                          │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ measure       stage everything, diff against │
                    │               the baseline                   │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ oracle        build, then test. Exit code is │
                    │               the verdict                    │
                    └───────────────┬──────────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────────┐
                    │ record        one JSONL line, appended       │
                    └──────────────────────────────────────────────┘
```

## Modules

| File | Responsibility |
|---|---|
| `schema.ts` | The two contracts, plus the agent config and validation record. |
| `task.ts` | Loading and checking task files. Paths resolve from the repository root, never from the task file. |
| `exec.ts` | Running one command with a timeout and its own process group. The only place a process is spawned. |
| `scratch.ts` | Throwaway checkouts: materialise, baseline, setup, measure changes. |
| `agent.ts` | Agent drivers: prompt delivery, invocation, and reading cost out of whatever the CLI printed. |
| `apple.ts` | Apple command construction. Pure functions, so they are testable off macOS. |
| `oracle.ts` | Planning and running the grading steps, and turning exit codes into a verdict. |
| `trial.ts` | One trial, end to end. |
| `validate.ts` | The two checks a task must pass before its numbers count. |
| `ledger.ts` | Append-only JSONL: write a line, read lines, tolerate a truncated last line. |
| `report.ts` | Derived views: per-task rates, failure taxonomy, dated report, README index. |
| `doctor.ts` | What can this machine measure right now? |
| `cli.ts` | Argument parsing and output. No logic worth testing lives here. |

## Decisions worth knowing

**Setup runs before the oracle, including during validation.** Setup is part of the
starting state. If `plumbline validate` graded a checkout without it, it would be
grading a different task from the one the agent gets.

**Changes are measured by staging everything and diffing against the baseline.**
`git add -A` honours `.git/info/exclude`, which is where plumbline puts
`.plumbline/`, `node_modules/`, `DerivedData/`, `build/`, and `*.xcresult`. Without
that, a build would look like an agent's work and every "changed files" count would be
noise.

**Every command runs in its own process group.** Killing only the shell leaves the
grandchildren alive: `bash -c 'sleep 600'` would outlive its own trial and hold the
wall-clock limit open indefinitely. The limit signals the group, then escalates to
`SIGKILL`. The CLI installs a signal handler so Ctrl-C takes the group down too,
rather than leaving an agent building in Xcode after the harness has gone.

**The oracle is planned, not scripted per task.** Apple tasks declare a project,
scheme, and destination; the harness builds the `xcodebuild` invocations. Two tasks
with the same declared target therefore receive identical flags, which is what makes
their results comparable.

**The ledger is append-only and the reports are derived.** Nothing edits a record. A
mistake is corrected in a later run, and the correction is visible. `plumbline report
--run <id>` rebuilds any report from the ledger at any time.

**Validation is keyed to a content hash.** The hash covers the task file, its
reference patch, and its pinned source. Edit the prompt and the task's earlier
validation no longer applies — it cannot quietly inherit a check that was done
against different text.
