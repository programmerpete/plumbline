# The task suite

This directory is empty on purpose. A task only belongs here once `plumbline
validate` has proved two things about it on a real machine:

1. the oracle **fails** on the pinned checkout — the task is not already solved;
2. the oracle **passes** once `reference_patch` is applied — the task is solvable.

Until then its numbers are provisional, and every report says so. Authoring tasks
is the slow part of a benchmark and the part that decides whether it measures
anything. See [docs/TASKS.md](../docs/TASKS.md) for the format and the rules, and
[tasks/example-apple/task.yaml.example](example-apple/task.yaml.example) for a
worked example.

## What makes a good task

- **A pinned commit.** `source.commit` is a full SHA. A benchmark whose tasks move
  is not a benchmark.
- **A prompt a colleague would recognise.** It describes the symptom, not the fix.
  If the prompt names the file and the line, you are measuring transcription.
- **A real repository.** The bug or gap has to come from something that actually
  happened, or the task teaches you nothing about the code you ship.
- **An oracle that already exists.** The repository's own build and test suite.
  If you have to invent a rubric to grade it, it is not a plumbline task.
- **A reference patch.** Not because the agent sees it — it never does — but
  because it is the only evidence that the task can be solved at all.

## Naming

`<area>-<symptom>`, lowercase, hyphenated: `checkout-discount-rounding`,
`settings-state-reset`, `test-flake-retry`. The id appears in every ledger record,
so it is permanent.
