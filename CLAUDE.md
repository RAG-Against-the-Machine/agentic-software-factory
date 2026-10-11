# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Agentic Software Factory (ASF): pick a ticket from a work tracker, spawn a small
agent team (planner → implementer → tester → reviewer) under a **deterministic
orchestrator**, and get a pull/merge request back — with a human gate at every
step the operator chooses to keep. See `README.md` and `docs/plan.md` for the
full "why"; `docs/PIPELINE.md` for the run lifecycle; `docs/PROVIDERS.md` for
the provider seams.

## Commands

```bash
pnpm install
pnpm --filter @asf/shared build   # ALWAYS build shared first; every package imports it
cp .env.example .env              # set RUN_EVENT_SECRET (others optional)
pnpm db:up                        # Postgres in Docker (role asf/asf, databases asf + asf_test)

pnpm dev                          # registry :8788 -> api :8787 -> one worker (scripts/dev.mjs)
pnpm dev:mock                     # registry + api only, no agent spend (--no-worker)
pnpm dev:web                      # Vite web on :3999
pnpm dev:api / dev:registry / dev:worker   # a single service via its filter

pnpm build        # tsc across packages + apps (shared must be built first)
pnpm typecheck    # tsc --noEmit everywhere
pnpm lint         # eslint .
pnpm test         # all package tests (node --test + tsx)
```

Run one package's tests: `pnpm --filter @asf/registry test`. Registry tests need
`DATABASE_TEST_URL` (defaults to `asf_test`) and **skip silently without it**; each
test file isolates itself in its own Postgres schema. Run a single test file:
`node --test --import tsx apps/registry/src/runs/orchestrate.test.ts`.

After editing the settings catalogue (`packages/shared/src/settings.ts`), run
`pnpm gen:config` to regenerate `.env.example` and `docs/CONFIGURATION.md`.
**CI fails if they drift** (`pnpm gen:config:check`).

## Architecture

pnpm monorepo, Node ≥22, TypeScript (ESM/NodeNext, strict). Four services + one
shared contract package:

- **`packages/shared`** — Zod schemas and the interface contracts everything
  imports (`ticket.ts`, `scm.ts`, `team.ts`, `run.ts`, `runtime.ts`,
  `notification.ts`, `settings.ts`, `pipeline.ts`, `models.ts`, `pricing.ts`).
  Change a contract here, not in a consumer.
- **`apps/api`** — Fastify. Holds tracker/SCM credentials; talks to external
  providers. **No database.** Serves the built web bundle in production.
- **`apps/registry`** — Fastify + Postgres. Owns runs, tasks, gates, workers,
  the orchestrator, the sweeper, and SSE fan-out. **The only service that
  connects to Postgres.**
- **`apps/worker`** — Claims one task, runs one role via `runtimes/*`, reports
  events, and exits. One task = one process; nothing is held across a gate.
- **`apps/web`** — Vite + React. Backlog, Today, Queue, Run, Pipeline, Admin views.

Flow: `web` ⇄ (HTTP/SSE) `api` → providers/notifications; `api`/`worker` ⇄
(RPC/SSE) `registry` → Postgres; `worker` claims tasks from `registry`.

### The orchestrator (`apps/registry/src/runs/orchestrate.ts`)

Plain, deterministic, idempotent TypeScript. `advance(sql, runId)` is called
after every task finish and gate resolution; it reads the whole run from the DB
and decides the single next state. **An LLM never decides what a state becomes.**
It handles: gate after each role, reviewer `REQUEST_CHANGES` looping back to the
implementer (bounded by `review_iterations`), needs-human checkpoints, cost
halts, and the publish phase (push → draft PR → `before_merge` gate → merge).

### Settings (`packages/shared/src/settings.ts`)

Every operator decision is a named setting. Resolution is always
**env var > `org_setting` table (UI) > default**. A key whose tiers are `['org']`
cannot be set from the environment — this is how "`before_merge` can only be
relaxed at the org level" is enforced by the catalogue, not by a comment.

### Provider / runtime seams

Concrete providers are loaded from exactly one factory each and nothing else
imports a concrete implementation:
- Tickets: `apps/api/src/providers/tickets/index.ts` (jira, github, trello, …)
- SCM: `apps/api/src/providers/scm/index.ts` (github, gitlab)
- Agent runtimes: `apps/worker/src/runtimes/index.ts` (`claude-code`, `codex`)

To add one: implement the interface from `packages/shared`, add a sibling file,
add a case in the factory. Nothing else changes.

### DB migrations (`db/migrations/*.sql`)

Additive-only, checksummed, applied by the registry at boot. Add a new numbered
file; never edit an applied one.

## Invariants that must stay true

- No credential reaches the browser; no ticket/SCM credential reaches the
  registry or an agent. **Agent runtime code (`apps/worker/src/runtimes/`) must
  never read a token/secret/password/API-key from the environment** — CI greps
  for these env-style names and fails the build.
- Only the registry connects to Postgres.
- One task = one process; nothing is held across a gate.
- `before_merge` defaults to `required` and can only be relaxed by an explicit
  org-tier setting.
- Refuse with a reason rather than guess. Never push to a forbidden branch
  (`FORBIDDEN_BRANCHES` in `scm.ts`).
- Role prompts ship in `prompts/roles/` (planner/implementer/tester/reviewer),
  not discovered from a laptop.
