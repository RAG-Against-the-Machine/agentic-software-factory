# OpenCode runtime — live E2E log

> **Status: pending live run.** This is a template. Nobody has run it yet. Fill it in
> during a real run on a **containerised** worker (a worker on a bare host does not offer
> `opencode`; see docs/RUNTIMES.md). Replace every `<…>` with what actually happened. Do
> not invent output: leave a section empty rather than make it up.

## Setup

- Worker: `<image tag / host>`, containerised: `<yes — /.dockerenv or ASF_IN_CONTAINER=1>`
- `OPENCODE_BIN`: `<path>`, `opencode --version`: `<version>`
- `AGENT_RUNTIMES`: `<e.g. claude-code,codex,opencode>`
- Provider / auth mode: `<anthropic | openai | openai-compatible + mode>`
- Model per role: `<planner / implementer / tester / reviewer>`

## Offer

- Workers page shows `OpenCode <version> · ready`: `<yes/no + screenshot or /health output>`
- Same worker started on a bare host shows "needs the containerised worker": `<yes/no>`

## Run

| step | run id / task id | outcome | cost | notes |
| --- | --- | --- | --- | --- |
| dispatch `<ticket>` with every role on `opencode` | `<run id>` | | | |
| planner | | | | |
| implementer | | | | |
| tester | | | | |
| reviewer | | | | |
| publish (draft PR) | | | | `<PR url>` |

## Guard checks

- The generated `<run dir>/.opencode/opencode.json` has only allow/deny: `<yes/no>`
- Cancel mid-role kills the process tree: `<yes/no, how verified>`
- A read-only role's worktree edit is refused or reverted, and the task fails: `<yes/no>`
- The agent's attempt to push is refused: `<yes/no, which layer>`
- `tool:post` / `tool:denied` events appear on the Run page: `<yes/no>`
- Token usage was priced from the catalogue: `<cost per role>`

## Frictions / follow-ups

1. `<…>`
