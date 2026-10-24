# The ledger

Two append-only JSONL files. This directory is the record; everything in `report/` is
a view of it and can be rebuilt at any time.

| File | One line per |
|---|---|
| `trials.jsonl` | trial: a verdict, a duration, a diff size, a cost, and the tail of the oracle's output |
| `validations.jsonl` | task validation: the two checks a task must pass, with the content hash they were run against |

## Rules

1. **Lines are only ever added.** A record is never edited or deleted. A mistake is
   corrected by a later run, and the correction is visible next to the original.
2. **A record that fails the schema is an error, not a row to skip.** The only
   tolerated exception is a truncated *final* line, which is what a crash mid-write
   leaves behind. Everything else is loud.
3. **Nothing is derived in place.** Reports, tables, and rates are computed from these
   lines on demand.

## Reading it

```bash
jq -r 'select(.verdict=="fail") | "\(.task_id) \(.failure_mode)"' ledger/trials.jsonl
```

```bash
# every run, newest last
jq -r '.run_id' ledger/trials.jsonl | uniq -c
```

Each line carries `schema_version`, so a future change to the record shape can be
handled without rewriting history.
