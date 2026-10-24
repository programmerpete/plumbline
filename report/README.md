# Reports

One directory per run, named `<date>-<id>`. Each holds:

| File | Contents |
|---|---|
| `README.md` | the report: pass rates, per-task table, failure taxonomy, method, provenance |
| `summary.csv` | one row per trial, for whatever you want to do next |
| `trials.jsonl` | the exact records the report was built from |

A report is a derived view of [../ledger/trials.jsonl](../ledger/trials.jsonl) and can
be rebuilt at any time:

```bash
bun run src/cli.ts report --run 2026-10-24-3f9a21
```

Nothing here is edited after the fact. A report that turns out to be wrong is
superseded by a later run, and the earlier one stays where it is.

The index of runs lives in the [repository README](../README.md#reports), so the
record is the first thing a reader sees.
