# plumbline

> Coding agents are not graded on Apple-platform work, so nobody knows how good they
> are at it. plumbline grades them, and keeps the record.

A plumb line finds true vertical by hanging still. No judgement, no interpretation,
no partial credit: either the string hangs straight or it does not. That is the whole
idea here.

plumbline runs coding agents against real iOS and macOS repositories pinned to a
commit, and grades every run with the repository's own build and test suite. There is
no rubric, no judge model, and no "mostly worked". The result of every trial is a
record in an append-only ledger, and the report is a view of that ledger.

It ships with an empty task suite on purpose. A task only counts once validation has
proved it fails before the work and passes after it — on a real machine, with a real
Xcode. See [tasks/README.md](tasks/README.md).

## Why this exists

Swift is not in any of the benchmarks people quote. SWE-bench, Terminal-Bench, and
the long-horizon suites that followed them grade Python, TypeScript, Go, Rust, and
JavaScript in containers. Apple-platform work is missing for a boring reason: grading
it needs macOS, `xcodebuild`, a simulator, and an XCTest run, and that is awkward to
put in a container. The awkward part is the contribution.

If you ship an iOS app and you want to know whether an agent is actually helping, the
honest answer today is a feeling. plumbline replaces the feeling with a number you can
disagree with.

## What it does

- **Runs an agent against a pinned checkout.** A fresh clone at a full SHA, in a
  throwaway directory. The agent is a command you already have — `claude -p`,
  `codex exec`, your own wrapper. plumbline ships no provider SDK and makes no model
  calls of its own.
- **Grades it with the repository's own tests.** `xcodebuild build`, then
  `xcodebuild test`, with a result bundle kept beside the run. The exit code is the
  verdict.
- **Records every trial, forever.** One JSONL line per trial in
  [ledger/trials.jsonl](ledger/trials.jsonl): verdict, failure mode, duration, diff
  size, cost where the agent reported it, and the tail of the oracle's output.
- **Publishes dated reports.** One directory per run in [report/](report/), derived
  from the ledger. A correction shows up as a later run, never as a quiet edit.

## The two rules

**1. A task must fail before the work and pass after it.**

```bash
bun run src/cli.ts validate checkout-discount-rounding
```

```
PASS  checkout-discount-rounding
        pristine: oracle failed (tests_failed)
        reference: oracle passed
```

The oracle has to fail on the untouched checkout, or the task is pre-solved and
measures nothing. It has to pass once `reference_patch` is applied, or the task is
impossible and every agent looks bad. Both checks are required, and a task without a
reference patch cannot be validated at all. Validation is keyed to a content hash of
the task, its patch, and its pinned source, so editing a task invalidates its earlier
validation instead of inheriting it.

**2. The oracle decides, not a judge.**

No LLM grading, no similarity scores, no checklists. If a task cannot be graded by
running the repository's own tests, it is not a plumbline task. This is the reason the
numbers in [report/](report/) can be argued with rather than believed.

## Quickstart

Requires [Bun](https://bun.sh/). Apple tasks additionally require macOS with Xcode;
the self-tests run anywhere.

```bash
bun install

bun run src/cli.ts doctor      # what can this machine measure right now?
bun test                       # the harness's own tests
bun run selftest               # the whole loop, with stub agents, no API key

bun run src/cli.ts validate    # both checks, on every task in the suite
```

`doctor` never calls a model and never spends a token. On a Mac with Xcode:

```
  PASS  bun 1.3.10                       runtime
  PASS  git version 2.55.0               scratch checkouts and change measurement
  PASS  macos                            Apple tasks can be graded here
  PASS  Xcode 27.0                       simulators available: 14
  PASS  agent CLIs: claude, codex        found on PATH
  PASS  task suite: 12                   12 apple, 0 local — all specs valid
  PASS  validation coverage 12/12        every task proved to fail before and pass after
  PASS  ledger                           144 trials, last run 2026-10-24-3f9a21
```

On a machine without Xcode the same command reports `SKIP` for the Apple checks,
explains why, and keeps working: the self-tests are not Apple tasks.

## Running a benchmark

An agent is a JSON or YAML file describing a command:

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

```bash
# what would run, without running it
bun run src/cli.ts run --agent agents/claude-code.json --dry-run

# three independent trials per task, into the ledger, then a report
bun run src/cli.ts run --agent agents/claude-code.json --attempts 3

# rebuild a report from the ledger
bun run src/cli.ts report --run 2026-10-24-3f9a21
```

Costs are reported only where the agent reported them. Unreported cost stays unknown;
nothing is estimated, because an estimate in a cost column is a lie with decimal
places.

## What a record looks like

```jsonc
{
  "task_id": "checkout-discount-rounding",
  "attempt": 2,
  "agent": { "name": "claude-code", "version": "2.1.0", "model": "claude-sonnet-5" },
  "verdict": "fail",
  "failure_mode": "tests_failed",
  "changed_files": 3,
  "diff": { "added": 41, "removed": 12 },
  "duration_ms": 412000,
  "usage": { "input_tokens": 184000, "output_tokens": 6100, "cost_usd": 1.42 },
  "steps": [ { "name": "build", "exit_code": 0 }, { "name": "test", "exit_code": 65 } ],
  "notes": []
}
```

Failure modes are decided by observable signals, in this order: `timeout`, then a
non-zero agent exit (`agent_error`), then an untouched checkout (`no_change`), then
`build_failed`, then `tests_failed`. A run that ended badly is a different finding
from one that finished and got it wrong, and the taxonomy keeps them apart. Trials
that could not be graded at all — no Xcode, no macOS — are recorded as `error` and
excluded from pass rates rather than counted as agent failures.

## Adding a task

See [docs/TASKS.md](docs/TASKS.md) for the format and
[tasks/example-apple/task.yaml.example](tasks/example-apple/task.yaml.example) for a
worked example. The short version: pin a commit, write a prompt a colleague would
recognise, and make sure the repository's existing tests can tell the difference.

## Why not just use an existing benchmark?

- **Existing coding benchmarks** cover five languages, and Swift is not one of them.
  Their grading is a container and a test command; Apple-platform grading is a
  simulator and an XCTest run, which is the part that does not fit.
- **An LLM judge** would let this cover more tasks and would make every number
  unfalsifiable. A judge that agrees with itself 90% of the time cannot measure a 5%
  difference, and it is the 5% differences that decide whether an agent is worth its
  cost.
- **Screenshot diffing** looks like the right way to grade UI work and is not. A
  pixel diff fails on a font fallback and passes on a wrong total. Assertions belong
  in XCUITest; screenshots are kept as evidence for a human, never as the verdict.
- **Token-per-second benchmarks** measure the wrong thing. An agent that needs three
  attempts and forty minutes has not solved the task in any sense the person waiting
  for it cares about.

## Limits

- **Apple tasks need macOS.** `xcodebuild` only exists there. `doctor` says so, and
  an ungradable trial is recorded as `error` rather than blamed on the agent.
- **Trials run one at a time.** Parallel `xcodebuild` runs fight over the same
  simulator and derived data, and a benchmark that trades reproducibility for
  throughput is not a benchmark.
- **Clones are full clones.** Correct for any commit, slower than a shallow fetch.
- **A full suite is expensive.** Three attempts across twenty tasks with a frontier
  model is a day and a real bill. Run it overnight; the ledger is designed for that.

## Layout

```
src/          the harness: tasks, trials, oracle, ledger, reports, doctor
tasks/        the published suite (empty until tasks are validated)
fixtures/     self-test tasks and the repository they point at
agents/       agent configs, plus the stub agents the self-tests use
docs/         architecture, task format, grading rules, running notes
ledger/       append-only trial and validation records
report/       dated reports, derived from the ledger
```

## Reports

No runs yet. The first real run appends here — one line per run, with its pass rates,
derived from the ledger. Self-test runs are written to `.plumbline/self-test/` so they
never appear in this list.

<!-- REPORTS:START -->
<!-- REPORTS:END -->

## License

Apache License 2.0 — see [LICENSE](LICENSE).
