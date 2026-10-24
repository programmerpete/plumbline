# Writing a task

A task is a pinned checkout, a prompt, and a way for the repository's own tests to
tell the difference. Copy
[tasks/example-apple/task.yaml.example](../tasks/example-apple/task.yaml.example) and
change it.

## The format

```yaml
id: checkout-discount-rounding        # lowercase, hyphenated, permanent
title: Checkout shows a total that disagrees with the cart
platform: apple                        # apple | local
tags: [swiftui, state, money]

source:
  kind: git                            # git | path
  url: https://github.com/you/app.git
  commit: 0f1e2d3c4b5a69788796a5b4c3d2e1f009182736   # full SHA, never a branch

setup:                                 # optional, runs before the agent
  - xcodegen generate

apple:
  project: App.xcodeproj               # or workspace:, never both
  scheme: App
  destination: platform=iOS Simulator,name=iPhone 17
  capture_screenshot: true             # evidence only, never the verdict

budget:
  wall_clock_seconds: 1200             # seconds, per agent session
  attempts: 3                          # independent trials, for pass@k

prompt: |
  What a user sees, not where the bug is.

reference_patch: tasks/checkout-discount-rounding/fix.patch   # required to validate
```

`platform: local` replaces `apple` with shell commands, and exists so the harness can
be tested without Xcode:

```yaml
local:
  build: ["bun install"]
  test: ["bun test"]
```

## Paths

`source.path` and `reference_patch` are relative to the repository root, never to the
task file. Moving a task between directories cannot change what it measures. Both must
stay inside the repository: absolute paths and `..` are rejected.

## What the agent gets

The prompt, verbatim, as the whole of its context. Plus a scratch checkout and these
environment variables:

| Variable | Meaning |
|---|---|
| `PLUMBLINE_REPO` | this repository, so a config can reference scripts in it |
| `PLUMBLINE_SCRATCH` | the checkout the agent may modify |
| `PLUMBLINE_TASK_ID` | the task id |
| `PLUMBLINE_TASK_DIR` | the directory holding the task file |
| `PLUMBLINE_RUN_ID` | the run, for logging (absent during validation) |

The agent is expected to write into the current working directory, which is the
scratch checkout. Nothing outside it is writable by the task, and the whole thing is
deleted after the trial unless `--keep` was passed.

## What does not count as work

Build products and dependency trees are side effects of grading, not attempts at the
task. These paths are excluded from change measurement in every checkout:

```
.plumbline/  node_modules/  DerivedData/  build/  *.xcresult  .DS_Store
```

Add a task-level exclusion by putting it in the repository's own `.gitignore`, since
change measurement stages everything with `git add -A`.

## Rules for a good task

1. **Pin a commit.** A benchmark whose tasks move is not a benchmark.
2. **Describe the symptom, not the fix.** If the prompt names the file and the line,
   you are measuring transcription. "The checkout total disagrees with the cart when a
   percentage discount applies" is a task. "Change line 42 to multiply" is not.
3. **Use a real repository.** The bug has to come from something that actually
   happened, or the task teaches you nothing about the code you ship.
4. **Let the existing tests decide.** If the repository has no test that fails before
   the work, either add one as part of the task's starting state or pick another task.
5. **Write a reference patch.** The agent never sees it. It is the only evidence the
   task can be solved at all, and `validate` refuses a task without one.

## Validate before you quote a number

```bash
bun run src/cli.ts validate checkout-discount-rounding
```

```
PASS  checkout-discount-rounding
        pristine: oracle failed (tests_failed)
        reference: oracle passed
```

Both lines matter. `pristine: oracle passed` means the task is already solved and
measures nothing. `reference: oracle failed` means the patch does not satisfy the
oracle, so the task is probably impossible and every agent will look bad on it.

Validation is keyed to a hash of the task, its patch, and its pinned source. Edit the
task and the validation goes stale, which the report will show until you re-run it.

## Writing the reference patch

Make the change in a checkout, then take the diff:

```bash
cd .plumbline/work/<task-id>/validate-pristine
# ... make the change ...
git diff > ../../../../tasks/<task-id>/fix.patch
```

`plumbline validate` applies it with `git apply --whitespace=nowarn` from the scratch
root, so keep the usual `a/` and `b/` prefixes.

## Suite hygiene

- `plumbline tasks` lists the suite with each task's validation state.
- A task id appears in every ledger record forever. Renaming one loses its history.
- Keep the suite small and honest. Twenty tasks that each took an afternoon to author
  and validate beat two hundred generated ones, and they will survive contact with
  someone who disagrees with you.
