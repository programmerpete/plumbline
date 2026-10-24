# Roadmap

Ordered by what would change a conclusion, not by what would be fun to build.

## Next

**A real task suite.** Twelve to twenty validated Apple tasks, taken from work that
actually happened: a flaky UI test, a deprecated API migration, a layout that breaks on
a large font, a launch-time regression. This is the slow part and the part that decides
whether any of the numbers mean anything. Everything else here is secondary to it.

**Per-attempt diffs in the report.** The ledger records diff sizes; the patches
themselves live in the scratch checkout and vanish unless `--keep` is passed. Keeping
the patch for failed trials — small, and the most useful thing for explaining a result —
would make "why did it fail" answerable months later.

**A second agent config that is actually tested.** The repo tests the stub agents and
documents the real ones. A verified config for one frontier CLI, exercised against the
fixture suite in CI, would remove the "does this even work" step from someone else's
first run.

## Later

**Parallel trials.** The blocker is not concurrency, it is the simulator: parallel
`xcodebuild` runs fight over one device and one derived data directory. A pool of
pre-booted simulators, one per worker, would make a suite finish in a third of the
time. Worth doing only once the suite is large enough that a run does not fit in an
evening.

**A macOS CI job on a schedule.** Weekly, not per push: enough to catch a harness
regression against real Xcode, cheap enough to keep.

**Task-level flake detection.** Run the same task twice on an untouched checkout. If
the oracle disagrees with itself, the task is flaky and its numbers are noise. The
validation step could check this, at the cost of doubling its runtime.

**Historical comparison in reports.** "pass@1 went from 58% to 71% between agent
versions" is the question everyone actually asks, and the ledger already has the data.
It needs a stable task set, which is why it comes after the suite.

## Not planned

**An LLM judge.** It would let the suite cover more tasks and make every number
unfalsifiable. See [docs/GRADING.md](../docs/GRADING.md).

**Screenshot diffing.** A pixel diff fails on a font fallback and passes on a wrong
total. Assertions belong in XCUITest; screenshots stay evidence.

**Cost estimation.** If the agent does not report cost, it is unknown. Filling that in
with a price table would produce a number that looks authoritative and is not.
