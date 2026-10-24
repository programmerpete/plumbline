# Grading

The oracle is the repository's own build and test suite. There is no rubric, no judge
model, and no partial credit. A task that cannot be graded this way is not a plumbline
task, however interesting it is.

## The verdict

| Platform | Steps | Pass |
|---|---|---|
| `apple` | `xcodebuild build`, then `xcodebuild test` | every step exits 0 |
| `local` | `local.build`, then `local.test` | every step exits 0 |

The first non-zero exit decides the failure mode and stops the run: a failing build
does not go on to run the tests, because the test result would be meaningless and
expensive.

`local` exists so the harness itself can be tested anywhere, including a Linux
machine with no Xcode. A published suite is `apple` work.

## Failure modes

Decided by observable signals, in this order:

| Mode | Signal |
|---|---|
| `timeout` | the agent was still running at `budget.wall_clock_seconds` |
| `agent_error` | the agent exited non-zero |
| `no_change` | the checkout is identical to the baseline, and the oracle failed |
| `build_failed` | a build step exited non-zero |
| `tests_failed` | a test step exited non-zero |
| `setup_failed` | setup exited non-zero, so the agent never ran |
| `oracle_error` | the trial could not be graded at all |

**Order matters, and it is deliberate.** A run that ended badly is a different finding
from one that finished and got it wrong. If an agent crashes after making a partial
edit, `agent_error` is the actionable fact; reporting `tests_failed` would hide it
behind a symptom.

**A pass beats the taxonomy.** If the agent was killed at the wall-clock limit and the
tests still pass, the trial is a pass — the work is done — and the record carries a
note saying the agent was killed. The oracle decides, not how the session ended. The
reverse would let a hung-but-finished agent be scored as a failure, which is the kind
of number that quietly makes a benchmark useless.

**`oracle_error` is not a failure.** If the oracle cannot run — no macOS, no Xcode, a
harness fault — the trial is recorded with verdict `error`, excluded from every pass
rate, and reported as ungraded. Counting an ungradable trial as an agent failure would
be a lie in the agent's disfavour, and it is the easiest mistake to make when the
benchmark runs somewhere without a Mac.

## Pass rates

- **pass@1** — the share of tasks whose first attempt passed.
- **pass@k** — the share of tasks where any attempt passed, with `k` per task from
  `budget.attempts` (or `--attempts`).
- Both are computed over graded tasks only. A task whose trials were all ungraded
  contributes to neither, and its row shows `—`.

Attempts are independent: each one gets a fresh checkout, and nothing carries over
between them except the ledger.

## Cost

Costs are reported only where the agent reported them, and the report always says how
many trials were unreported. Nothing is estimated. An estimated cost column is a
number that looks authoritative and is not, and it will be quoted by someone in a
planning meeting.

## What is deliberately not used

**An LLM judge.** It would let the suite cover tasks whose success is a matter of
taste, and it would make every number unfalsifiable. A judge that agrees with itself
90% of the time cannot measure a 5% difference, and 5% differences are exactly what
decides whether an agent is worth its cost.

**Screenshot diffing.** It looks like the right way to grade UI work and it is not. A
pixel diff fails on a font fallback and passes on a wrong total. Assertions belong in
XCUITest, where they can be written against accessibility identifiers. A screenshot is
captured as evidence for a human to look at, and it never changes a verdict.

**Wall-clock alone.** A fast agent that fails is not better than a slow one that
passes. Duration is reported next to the verdict, not instead of it.

## Reading a report

```
| Task | pass@1 | pass@k | k | median | cost | dominant failure | validated |
```

- `dominant failure` is the most common failure mode for that task across attempts,
  which is usually the thing to fix — in the task, in the prompt, or in the agent.
- `validated` is `yes` only when a validation record exists whose content hash still
  matches the task. `stale` means the task changed after it was validated.
  `unvalidated` means nobody has proved the task is solvable, and its numbers are
  provisional.
- A row of `100%` with `validated: unvalidated` is the specific shape of a task that
  is too easy. Check it before quoting it.
