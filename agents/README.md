# Agent configs

An agent is a command you already have. plumbline ships no provider SDK, holds no API
keys, and makes no model calls of its own — it hands a prompt to a process and reads
what that process says it cost.

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

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Appears in every ledger record and report. |
| `command` | yes | Run with `bash -c` in the scratch checkout. |
| `prompt_delivery` | no | `stdin` (default), `argument`, or `file`. |
| `prompt_flag` | no | Flag used by `argument` and `file`. Defaults to `-p`. |
| `version_command` | no | Recorded in every trial, so results carry their tool version. Worth setting: a benchmark whose agent version is unknown cannot be compared with next month's. |
| `usage` | no | `none` (default), `json`, or `regex`. Without it, cost is recorded as unknown — never estimated. |
| `env` | no | Extra environment variables for the agent. |

Configs may be JSON or YAML. Run `plumbline run --agent <file> --dry-run` to see the
command, the prompt delivery, and the exact oracle commands before spending anything.

## Prompt delivery

- **`stdin`** — the prompt is piped in and stdin is closed. Most CLIs work this way.
- **`argument`** — the prompt is appended as an argument behind `prompt_flag`.
- **`file`** — the prompt is written to `.plumbline/prompt.md` in the checkout and its
  path is passed as an argument. Useful for CLIs that take a task file.

## Reading cost out of a CLI

`usage.kind: json` looks for the last JSON object printed on stdout and reads the dot
paths you name. It handles a single line, a pretty-printed object, and a stream of
event objects with the result last.

`usage.kind: regex` matches named groups against stdout and stderr together:

```json
{
  "usage": {
    "kind": "regex",
    "pattern": "tokens: (?<input_tokens>\\d+) in / (?<output_tokens>\\d+) out, cost \\$(?<cost_usd>[\\d.]+)"
  }
}
```

If a number is missing, it stays `null` in the record. Nothing is filled in with a
zero or a guess.

## Examples

These are starting points, not verified claims about any particular release. Flags
change; check yours, then confirm with `--dry-run`.

```json
{ "name": "codex", "command": "codex exec --json", "prompt_delivery": "argument",
  "prompt_flag": "--", "version_command": "codex --version" }
```

```json
{ "name": "amp", "command": "amp -x", "prompt_delivery": "argument",
  "prompt_flag": "--", "version_command": "amp --version" }
```

A wrapper script is often the simplest integration, because it can normalise prompts
and print a usage line in whatever format you like:

```json
{ "name": "my-wrapper", "command": "bash \"$PLUMBLINE_REPO/agents/my-wrapper.sh\"",
  "prompt_delivery": "stdin",
  "usage": { "kind": "regex", "pattern": "COST (?<cost_usd>[\\d.]+)" } }
```

The agent runs with `PLUMBLINE_REPO`, `PLUMBLINE_SCRATCH`, `PLUMBLINE_TASK_ID`,
`PLUMBLINE_TASK_DIR`, and `PLUMBLINE_RUN_ID` set; see
[docs/TASKS.md](../docs/TASKS.md).

## The stub agents

`agents/self-test/` holds the agents the harness tests itself with. They are not
measurements of anything: one performs the known fix for the fixture, one does
nothing, one fails, and one never returns. They exist so the whole loop can be
exercised on any machine with no model, no network, and no API key.
