# Running a benchmark

## Prerequisites

- [Bun](https://bun.sh/) — the runtime, test runner, and CLI.
- `git` — scratch checkouts and change measurement.
- **macOS with Xcode** for Apple tasks. `plumbline doctor` reports what the current
  machine can and cannot measure; on Linux it says so and moves on.
- An agent CLI you already have installed and authenticated. plumbline ships no
  provider SDK and makes no model calls of its own.

```bash
xcode-select --install            # if xcodebuild is missing
xcrun simctl list devices available
```

Pin the simulator in the task (`platform=iOS Simulator,name=iPhone 17`) rather than
letting `xcodebuild` pick. A suite that grades on a different device each month is not
comparable with itself.

## Agent configs

An agent is a JSON or YAML file:

```json
{
  "name": "claude-code",
  "command": "claude -p --output-format json --permission-mode acceptEdits",
  "prompt_delivery": "stdin",
  "version_command": "claude --version",
  "usage": {
    "kind": "json",
    "input_tokens": "usage.input_tokens",
    "output_tokens": "usage.output_tokens",
    "cost_usd": "total_cost_usd",
    "model": "model"
  }
}
```

| Field | Notes |
|---|---|
| `command` | run with `bash -c` in the scratch checkout |
| `prompt_delivery` | `stdin` (default), `argument`, or `file` |
| `prompt_flag` | used by `argument` and `file`; defaults to `-p` |
| `version_command` | recorded in every trial, so results carry their tool version |
| `usage.kind` | `none`, `json` (dot paths into the last JSON object printed), or `regex` (named groups `input_tokens`, `output_tokens`, `cost_usd`, `model`) |
| `env` | extra environment variables for the agent |

See [agents/README.md](../agents/README.md) for more examples, including how to point
at a wrapper script of your own.

## Running

```bash
# what would run, without running it: no model calls, no writes
bun run src/cli.ts run --agent agents/claude-code.json --dry-run

# one attempt per task, the task's own budget
bun run src/cli.ts run --agent agents/claude-code.json

# three independent attempts per task, for pass@k
bun run src/cli.ts run --agent agents/claude-code.json --attempts 3

# a subset
bun run src/cli.ts run --agent agents/claude-code.json --task checkout-discount-rounding

# keep the checkouts, transcripts, diffs, and screenshots
bun run src/cli.ts run --agent agents/claude-code.json --keep

# rebuild a report from the ledger
bun run src/cli.ts report --run 2026-10-24-3f9a21

# write a report without adding the run to the README index
bun run src/cli.ts report --run 2026-10-24-3f9a21 --no-index
```

A trial is not a cheap operation. Three attempts across twenty tasks, at a few minutes
to twenty minutes each, is an overnight run and a real bill. The ledger is built for
that: start it, walk away, read the report in the morning.

## Timeouts

- `budget.wall_clock_seconds` limits one agent session. The agent's whole process
  group is signalled at the limit, then killed.
- `--step-timeout <seconds>` limits each oracle step (default 45 minutes). A build
  that hangs should not hold the suite for the rest of the day.
- Ctrl-C takes the current process group down with it. A second Ctrl-C exits
  immediately and may leave an agent process behind; check with `ps` if you are
  unsure.

## Where things go

| Path | Contents |
|---|---|
| `ledger/trials.jsonl` | every trial, appended, never edited |
| `ledger/validations.jsonl` | every task validation, with content hashes |
| `report/<date>-<id>/` | one report: `README.md`, `summary.csv`, `trials.jsonl` |
| `report/` | the report directory; the index lives in the repository README |
| `.plumbline/work/` | scratch checkouts (deleted per trial unless `--keep`) |
| `.plumbline/self-test/` | self-test output, so it never touches the real ledger |

Override any of them with `--ledger`, `--out`, `--work`, `--tasks`. Validation records
live beside the ledger, so pointing `--ledger` somewhere else moves both — which is how
the self-tests keep their fixtures out of the published record.

## Running the self-tests

The harness is tested against stub agents on any machine, with no model and no API
key. `bun run selftest` runs the whole loop — checkout, agent, oracle, ledger, report
— against `fixtures/tasks`, writing to `.plumbline/self-test/` so the published ledger
stays clean.

```bash
bun test                        # the harness's own tests
bun run selftest:validate       # both checks, against the fixture suite
bun run selftest                # the whole loop, with stub agents
```

The fixtures cover the failure modes that are easy to get wrong: an agent that changes
nothing, one that crashes, one that never returns, a task that is already solved, and
a task whose oracle cannot run on this machine.

## Continuous integration

`.github/workflows/ci.yml` runs the harness's tests on Linux, which is enough to catch
most regressions. Apple grading needs macOS, and a hosted macOS runner costs enough
that it is a deliberate choice rather than a default. If you add one, run it on a
schedule rather than on every push, and keep the suite small.

## Limits

- **One trial at a time.** Parallel `xcodebuild` runs fight over the same simulator
  and the same derived data. Parallelism would need a simulator pool per worker;
  until then, reproducibility wins.
- **Full clones.** Correct for any commit, and slower than a shallow fetch.
- **A killed trial can leave a detached process** if the agent ignores `SIGTERM` and
  its children re-parent. `plumbline doctor` and the record's `notes` are where to
  look when a run behaves oddly.
- **Costs are only as good as the agent's output.** If a CLI does not print usage,
  cost is unknown, and the report says so.
