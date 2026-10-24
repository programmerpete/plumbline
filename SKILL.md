---
name: plumbline
description: Author, validate, and run plumbline tasks — a graded coding-agent benchmark for Apple-platform work. Use when adding an iOS or macOS task to a benchmark, when checking whether a task is solvable before quoting its numbers, when running an agent against the suite, or when reading a plumbline report.
---

# plumbline

A coding-agent benchmark for Apple-platform work. Tasks are real repositories pinned to
a commit; the oracle is the repository's own build and test suite; every trial is a
record in an append-only ledger.

## The rule that matters

A task's numbers count only after validation proves two things:

1. the oracle **fails** on the pinned checkout — the task is not already solved;
2. the oracle **passes** with `reference_patch` applied — the task is solvable.

Never quote a result from an unvalidated task. Reports mark those rows `unvalidated`
or `stale`, and they are provisional by definition.

## Authoring a task

Start from `tasks/example-apple/task.yaml.example`. The full format and the rules for a
good task are in `docs/TASKS.md`. The short version:

- `source.commit` is a full SHA, never a branch.
- `prompt` describes what a user sees, not where the bug is. A prompt that names the
  file and the line measures transcription, not capability.
- `apple.destination` pins the simulator model, so runs stay comparable.
- `budget.wall_clock_seconds` and `budget.attempts` are per task. Three attempts is the
  useful minimum, because pass@k needs them.
- `reference_patch` is required. Write the change in a checkout and take `git diff`.

Then validate on a machine with Xcode:

```bash
bun run src/cli.ts validate <task-id>
```

`pristine: oracle passed` means the task is pre-solved. `reference: oracle failed` means
it is probably impossible. Fix the task, not the numbers.

## Running a benchmark

```bash
bun run src/cli.ts doctor                                   # what can this machine measure?
bun run src/cli.ts run --agent agents/claude-code.json --dry-run
bun run src/cli.ts run --agent agents/claude-code.json --attempts 3
```

An agent is a JSON or YAML config naming a command; see `agents/README.md`. plumbline
makes no model calls of its own. `--dry-run` prints the plan without spending anything.

## Reading a report

Reports live in `report/<date>-<id>/README.md`, indexed from the repository README.

- `pass@1` and `pass@k` are computed over graded tasks only.
- `verdict: error` means the trial could not be graded (no macOS, no Xcode). Those are
  excluded from pass rates, never counted as agent failures.
- Failure modes are decided by observable signals, in a fixed order. `agent_error`
  outranks `tests_failed`, because a run that ended badly is a different finding from
  one that finished and got it wrong.
- Cost is reported only where the agent reported it. Unknown stays unknown.
- The full rules are in `docs/GRADING.md`.

## Working on the harness

```bash
bun test                    # the harness's own tests
bun run selftest            # the whole loop, with stub agents, no API key
bun run typecheck
```

The self-tests write to `.plumbline/self-test/` so the published ledger stays clean.
Apple command construction is tested as exact strings, which is the only way to cover
the Apple path on a machine without Xcode.
