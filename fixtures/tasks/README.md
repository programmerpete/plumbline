# Self-test tasks

These tasks are not measurements. They exist so the harness itself can be tested on
any machine, including one without Xcode: each points at `fixtures/self-test-cart`
and grades with `bun test`.

| Task | What it exercises |
|---|---|
| `self-test-cart` | The whole loop: checkout, agent, oracle, ledger, report. Fails before the work and passes after it. |
| `self-test-presolved` | A task that is already solved. `plumbline validate` must reject it. |
| `self-test-timeout` | An agent that never returns, so the wall-clock limit has to kill it and the trial is classified `timeout`. |

Run them with the stub agents, into their own ledger so the published record stays
clean:

```bash
bun run selftest:validate      # the two checks, against the fixture suite
bun run selftest               # the whole loop, with stub agents
```

`selftest:validate` exits non-zero on purpose: `self-test-presolved` is refused, which
is the behaviour it exists to demonstrate.

`fixtures/tasks` is never part of a published suite. Real tasks live in `tasks/`
and are Apple-platform work graded by `xcodebuild`.
