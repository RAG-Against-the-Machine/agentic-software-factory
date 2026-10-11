# Copilot runtime — live E2E log

> **Status: pending live run.** This is a template. Nobody has run it yet. Fill it in
> during a real run on a **containerised** worker (a worker on a bare host does not offer
> `copilot`; see docs/RUNTIMES.md). Replace every `<…>` with what actually happened. Do
> not invent output: leave a section empty rather than make it up.

## Setup

- Worker: `<image tag / host>`, containerised: `<yes — /.dockerenv or ASF_IN_CONTAINER=1>`
- `COPILOT_BIN`: `<path>`, `copilot --version`: `<version>`
- `AGENT_RUNTIMES`: `<e.g. claude-code,codex,copilot>`
- Auth: `AGENT_AUTH_GITHUB_MODE=gh-token`, `GITHUB_COPILOT_TOKEN` entered in Settings: `<yes/no>`
- Model per role: `<planner / implementer / tester / reviewer>` (check that Copilot accepts these ids)

## Offer

- Workers page shows `Copilot <version> · ready`: `<yes/no + screenshot or /health output>`
- Same worker started on a bare host shows "needs the containerised worker": `<yes/no>`

## Run

| step | run id / task id | outcome | cost | notes |
| --- | --- | --- | --- | --- |
| dispatch `<ticket>` with every role on `copilot` | `<run id>` | | | |
| planner | | | | |
| implementer | | | | |
| tester | | | | |
| reviewer | | | | |
| publish (draft PR) | | | | `<PR url>` |

## Guard checks

- Cancel mid-role kills the process tree: `<yes/no, how verified>`
- A read-only role's worktree edit is reverted and fails the task: `<yes/no>`
- The agent's attempt to push is refused: `<yes/no, which layer>`
- `segment:heartbeat` events keep the run from going stale: `<yes/no>`
- Workers page "Unpriced runs this month" went up by one: `<before → after>`

## Frictions / follow-ups

1. `<…>`
