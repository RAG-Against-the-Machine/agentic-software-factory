# Pluggable Orchestrator Runtime (Claude Code → any agent, any model) — Plan

> **For Hermes:** one work package per PR, branch off `main`, rebase-squash, linear history. The maintainer merges between WPs.
>
> **Status:** DEFERRED — tracked as GitHub milestone [M8](https://github.com/RAG-Against-the-Machine/agentic-software-factory/milestone/1), issues #63–#70 (one per WP). ASF is in daily use on Claude Code first; this lands when a second executor is actually wanted.

**Goal:** Let an operator pick the agent framework that runs each role in the Worker (Claude Code, Codex, OpenCode, Copilot CLI, Hermes) and the model/provider behind it (Anthropic, OpenAI, GitHub, plus OSS via any OpenAI-compatible endpoint: GLM, DeepSeek, Qwen, local vLLM/llama.cpp) — from the UI, per role, without touching the registry/orchestrator, and without weakening the safety invariants (scope, no-push, no-credential-in-agent, cancel, cost cap).

**Architecture:** Keep ASF as the orchestrator (registry state machine + gates + publish stay exactly as they are). Treat every "agent framework" as a **headless runtime adapter** behind the existing `AgentRuntime` seam, widen that seam to carry the four things that are currently Claude-shaped (tool policy, telemetry/hooks, auth env, model catalogue), and move the enforcement that today lives in Claude Code hooks into a runtime-agnostic **worker-side guard layer** so a runtime with no hooks is still safe. Hermes becomes one adapter — the fastest path to OSS models — not the thing ASF is rewritten around.

**Tech stack:** existing pnpm monorepo (`@asf/shared`, `apps/{registry,api,worker,web}`), node child_process JSONL parsing, settings catalogue, org_secret sink.

---

## 0. Answer to the framing question ("should we mimic Hermes?")

Two different things are being conflated; separate them and the plan gets simpler:

1. **Orchestrator** = who sequences roles, holds state, enforces gates, publishes. That is ASF's registry + api. It already *is* the fleet orchestrator; it just isn't an LLM. Do not replace it — everything shipped so far (gates, pipeline stages, tickets, SCM hot-swap, budgets) hangs off it.
2. **Role executor** = the thing that turns one prompt + a worktree into edits/artifacts. Today only Claude Code. **This** is what becomes pluggable.

Hermes-style "model swapping + sub-agent spawning" lives inside the executor. ASF doesn't need to mimic it; it needs to *drive* it. Whether the executor spawns sub-agents internally (Claude's Task tool, Hermes `delegate_task`, Codex sub-agents) is opaque to ASF and should stay that way — ASF's unit is the role task, and its cost/scope/cancel controls apply to the whole process tree regardless.

So: **the seam is `AgentRuntime`, and the plan is "make everything Claude-specific flow through that seam, then add adapters."** Hermes is WP F, after Codex, because Codex is the smallest real second runtime and proves the seam; Hermes then buys every OSS/OpenAI-compatible model in one go (`hermes chat -m <model> --provider <p>` already exists, verified on this Mac).

## 1. Where it stands today (audit)

Already neutral (keep):
- `packages/shared/src/runtime.ts` — `AgentRuntime {kind, probe, run}`, `AgentSpawn`, `AgentOutcome`. Good shape.
- `apps/worker/src/runtimes/index.ts` — `loadRuntime(kind)` switch; `codex.ts` stub exists.
- Registry claim query `t.runtime = ANY(worker.runtimes)` — per-role runtime routing already works end-to-end (`team.ts` `teamRoleSchema.runtime`, `run_task.runtime`, `worker.runtimes`, `listFleet`). Nothing in the registry needs to change for multi-runtime.
- CI leak grep forbids credential names under `src/runtimes/` — keep, extend.

Claude-shaped leaks (each becomes a WP item):

| # | Where | What's Claude-specific |
|---|---|---|
| L1 | `segment.ts:22-33` `WRITE_TOOLS/READ_TOOLS` | Claude tool names (`Write`, `Edit`, `Bash`, `TodoWrite`) passed as `allowedTools` |
| L2 | `segment.ts:88-95` + `claudeHooksSettings()` + `apps/worker/hooks/*.mjs` | Scope enforcement, tool telemetry (`tool:pre/post`), **cancel**, and `agent:stopped` all ride Claude Code's hooks protocol (stdin JSON, `{decision:'block'}`, exit 2). No hooks → no scope guard, no cancel, no liveness. |
| L3 | `auth-preflight.ts` + `context.ts runAuthSchema` + `api/agent-auth.ts` | `RunAuth.mode ∈ {oauth-token, api-key, vertex, bedrock}` and the env translation (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_VERTEX`) are Anthropic-only; preflight short-circuits for non-claude runtimes (`ok:true`, unverified). |
| L4 | `shared/models.ts` (`ModelInfo.runtime: 'claude-code'`, 4 hardcoded ids), `shared/pricing.ts`, `settings.ts MODEL_DEFAULT_*` (enum over `MODEL_IDS`), `api/models.ts isKnownModel` | Model catalogue is a compile-time Anthropic list; dispatch refuses anything else. |
| L5 | `settings.ts AGENT_RUNTIME` (env-only, `values:['claude-code','codex']`), `CLAUDE_BIN`, `CLAUDE_EXTRA_ARGS` | Runtime choice is a worker env var; no UI; team template `runtime` default `'claude-code'` never surfaced. |
| L6 | `prompts/roles/*.md` | Wording assumes a coding agent with file tools; fine, but the `NEEDS_HUMAN:` protocol + "write to `{{artifacts}}`" convention must hold for every runtime (it's text, so it does). |
| L7 | `parseResult()` in `claude-code.ts` | `type:'result'`, `is_error`, `total_cost_usd`, `usage.cache_*` — fine, already confined to the file. |
| L8 | Worker registers `runtimes:[runtime.kind]` — one runtime per process | A box with claude+codex+hermes installed needs three workers today. |

## 2. Target design

### 2.1 Widen the contract (shared/runtime.ts)

```ts
export interface RuntimeCapabilities {
  /** Runtime can call back per tool use (hooks/plugins) so ASF can block in-line. */
  toolHooks: boolean;
  /** Runtime emits a machine-readable event stream ASF can tail for telemetry/liveness. */
  eventStream: boolean;
  /** Runtime reports its own USD cost (else priceUsage() from usage, else null). */
  reportsCost: boolean;
  /** Model ids are validated by the runtime (probe returns them) vs by ASF's catalogue. */
  listsModels: boolean;
}

export interface ToolPolicy {           // neutral; each adapter translates
  fileWrite: 'worktree' | 'run-dir-only';
  shell: boolean;
  network: boolean;
  gitPush: false;                        // always false — the worker pushes
}

export interface AgentSpawn {
  role: Role; prompt: string; cwd: string;
  model?: string;                        // provider-qualified id, see 2.3
  provider?: ModelProvider;              // resolved provider record (endpoint, kind) — NO secret
  policy: ToolPolicy;                    // replaces allowedTools/deniedTools
  env: Record<string,string>;            // ASF_* only
  auth: RunAuth;                         // see 2.4
  maxCostUsd: number; maxTurns?: number; timeoutMs: number;
  runDir: string;                        // adapters that need a per-task config file write it here
}

export interface AgentRuntime {
  readonly kind: string;
  readonly capabilities: RuntimeCapabilities;
  probe(): Promise<{ ok: boolean; version: string; models: string[] }>;
  run(spawn: AgentSpawn, sink: EventSink, ctl: RunControl): Promise<AgentOutcome>;
}
export interface RunControl { readonly signal: AbortSignal }   // cancel from the worker, not the hook
```

`allowedTools/deniedTools` go away from the shared type; each adapter derives its own flags from `policy` (`--allowedTools` for Claude, `-s workspace-write`/`read-only` for Codex, `--agent`+permission map for OpenCode, `-t toolsets`/`--yolo` for Hermes).

### 2.2 Guard layer — enforcement that does not depend on the runtime

Today's invariants and where they move:

| Invariant | Today (Claude hooks) | Runtime-agnostic home |
|---|---|---|
| Read-only role can't touch worktree | PreToolUse block | **Post-hoc audit** in `segment.ts`: after `run()`, `git status --porcelain` in the worktree; if a non-writing role dirtied it → `git checkout -- . && git clean -fd`, outcome `failed`, reason `scope violation`, event `scope:violation`. Hooks stay as a *fast-fail* for runtimes that have them. |
| No writes outside worktree/run-dir | PreToolUse block | Can't be enforced post-hoc without a sandbox. Accept: rely on runtime sandbox where available (Codex `-s workspace-write` is a real OS sandbox; Claude hooks; OpenCode permission map) and record `capabilities.toolHooks=false` runtimes as "advisory scope" in the fleet UI. Document. (Sandboxing the whole worker in a container is the real fix and is already how the self-host compose runs it.) |
| No `git push` / remote change | Bash regex in hook | **Make it impossible instead of forbidden**: worktree's `origin` gets a credential-less URL (`https://github.com/o/r.git`) — the worker already pushes via `cred.url` explicitly (`git.ts pushBranch`), so strip the token from the worktree remote at `ensureWorkspace`. Push from inside the agent then fails auth. Keep the hook regex as a nicety. |
| Cancel | `tool:pre` ack `cancelRequested` → block | Worker polls `api.event` ack / a new `GET /api/runs/:id/cancel` on a 5s timer during `run()`, fires `ctl.signal` → adapter kills the process tree (`SIGTERM` then `SIGKILL`, `detached:true` + `process.kill(-pid)`). Works for every runtime. |
| Liveness / telemetry | `tool:pre/post` events | Adapters with `eventStream` translate JSONL to `tool:pre/post`-equivalent events (`agent:tool`, `agent:message`). Adapters without either post a heartbeat event every N s from the worker while the child is alive. |
| Cost cap | `maxCostUsd` (advisory to Claude) | Unchanged: registry enforces on `finish`. Adapters without `reportsCost` use `priceUsage()`; unknown model → `null` → surfaced in UI as "unpriced" (already the honest gap). |

### 2.3 Model catalogue becomes data with a provider axis

```ts
// shared/models.ts
export type ProviderKind = 'anthropic' | 'openai' | 'openai-compatible' | 'github-copilot' | 'vertex' | 'bedrock';
export interface ModelProvider { id: string; kind: ProviderKind; baseUrl?: string; credentialKey?: string /* setting key holding the secret */ }
export interface ModelInfo { id: string; label: string; tier: ModelTier; providerId: string; runtimes: string[]; rate?: ModelRate }
```

- Built-in catalogue = today's 4 Anthropic models + a curated OpenAI set + empty OSS examples, all tagged with which runtimes can drive them (`claude-code` → anthropic only; `codex` → openai + openai-compatible; `hermes`/`opencode` → everything).
- New org-only JSON setting `MODEL_CATALOG_EXTRA` (`{providers:[...], models:[...]}`) merged over the built-in list at `cfg()` load — this is how an operator adds `glm-4.6` on a vLLM box or `deepseek-chat` without a code change. Pricing goes with it (`rate`), so `priceUsage` keeps working.
- `MODEL_DEFAULT_<ROLE>` flips from `enum` to `string` validated against the merged catalogue at dispatch (validation moves from the settings catalogue to `api/models.ts check()`, which already exists).
- Dispatch preview filters `models` by the role's runtime and by **what the live fleet advertises** (`listFleet().runtimes`), so the UI can't pick a model no worker can run.

### 2.4 Auth generalizes to per-provider credentials

`RunAuth` becomes:

```ts
export const runAuthSchema = z.object({
  providerKind: providerKindSchema,
  mode: z.string(),                         // provider-specific: anthropic 'oauth-token'|'api-key'|'vertex'|'bedrock'; openai 'api-key'|'chatgpt'; openai-compatible 'api-key'|'none'; github 'gh-token'
  credential: z.string().optional(),        // exactly one, resolved by the api per run (as today)
  baseUrl: z.string().optional(),
});
```

- Worker gets a per-provider **auth translator** table (`apps/worker/src/auth/<kind>.ts`) that maps `(runtime, providerKind, mode, credential)` → env additions + strip list. Today's `applyAgentAuth` becomes `auth/anthropic.ts` unchanged; add `openai.ts` (`OPENAI_API_KEY` / `CODEX_API_KEY` / `OPENAI_BASE_URL`), `openai-compatible.ts`, `github.ts` (`GH_TOKEN`/`COPILOT_*`), `hermes.ts` (writes a per-task provider block into `HERMES_HOME`-scoped config instead of env — see WP F).
- CI leak grep extends to `apps/worker/src/runtimes/` **and** requires every credential name to appear only under `apps/worker/src/auth/`.
- `AGENT_AUTH_MODE` (org-settable today) becomes `AGENT_AUTH_<PROVIDERKIND>_MODE` + the existing secret keys per provider (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, new `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `GITHUB_COPILOT_TOKEN`, generic `OPENAI_COMPAT_API_KEY`). All org tier, write-only, delivered per run via context — the existing hot-swap plumbing (`describeAgentAuth` poll + `reconcileAuthMode`) carries over; it just reports a map instead of one mode.
- Preflight becomes per-adapter: `AgentRuntime.preflight?(auth): Promise<{ok,detail}|{ok:false,reason}>`; the worker runs it for each runtime it advertises at boot and on auth change. No more `ok:true, "no preflight for runtime X"`.

### 2.5 Runtime selection surfaces in the UI

- `AGENT_RUNTIMES` (env, worker, comma list, default `claude-code`) replaces `AGENT_RUNTIME`; the worker probes each, advertises the ones that probe ok (L8 fixed — one worker, many runtimes).
- New org-settable `RUNTIME_DEFAULT_<ROLE>` (string, default `claude-code`) next to `MODEL_DEFAULT_<ROLE>`; `resolveRoleModels` becomes `resolveRoleRuntimes+Models` and validates the (runtime, model) pair against the catalogue.
- DispatchModal: per role, a runtime select (filtered to fleet-advertised) and a model select (filtered to runtime-compatible). Admin/fleet table already shows `runtimes`; add per-runtime probe version + auth preflight status.
- New `/agents` panel (mirrors `/providers`): per runtime kind — installed? version, auth mode + write-only credential field (reusing `SettingView` + org_secret sink), and per provider — base URL + key. This is "the Providers panel for LLMs".

### 2.6 Adapters (one file each, `apps/worker/src/runtimes/<kind>.ts`)

| Kind | Spawn | Output parsing | Tools policy | Telemetry | Cancel |
|---|---|---|---|---|---|
| `claude-code` (exists) | `claude -p … --output-format json --settings hooks.json` | last `type:result` | `--allowedTools/--disallowedTools` | hooks (`toolHooks:true`) | hooks + signal |
| `codex` | `codex exec --json -m <model> -s <workspace-write\|read-only> -a never -C <cwd> --ephemeral -o <runDir>/last.md -` (prompt on stdin) | JSONL: `turn.completed.usage`, `item.completed` (agent_message → text; `command_execution`/`file_change` → tool events), `turn.failed`/`error` → failed | sandbox flag from `policy.fileWrite` | JSONL tail (`eventStream:true`) | signal → kill tree |
| `hermes` | `hermes chat --query-file <runDir>/prompt.md --oneshot -Q -m <model> --provider <p> -t <toolsets> --max-turns N --run-budget S --in <cwd> --usage-file <runDir>/usage.json --ignore-user-config` + `HERMES_HOME=<runDir>/hermes-home` with a generated minimal `config.yaml` (provider block + base_url + key from auth) | stdout text (NEEDS_HUMAN protocol) + `--usage-file` for tokens; cost via `priceUsage` | `-t` toolsets: read-only role gets `terminal,file_read`-class toolsets, writer gets edit tools; `--yolo` only for writers | Hermes `hooks` subcommand → verify it can post tool events; else worker heartbeat | signal |
| `opencode` | `opencode run --format json -m <provider/model> --agent asf-<writer\|reader> --dir <cwd>` with a generated `.opencode/` agent config carrying an explicit allow/deny permission map (no `ask`) | JSON event stream | permission map in generated agent | plugin `tool.execute.before/after` — **known bug: hooks may not fire under `opencode run`** (anomalyco/opencode#41422); treat as `toolHooks:false`, rely on permission map + post-hoc audit | signal |
| `copilot` | `copilot -p <prompt> --allow-all-tools --excluded-tools=<…> --model <m>` | text; usage unknown (`reportsCost:false`, unpriced) | `--excluded-tools` | none → heartbeat | signal |

Order of implementation: codex (proves the seam, real sandbox, real JSONL, OpenAI-compatible base URL gives DeepSeek/Qwen/GLM immediately via `model_providers` in a generated `config.toml`), then hermes (broadest model reach + the maintainer already runs it), then opencode, then copilot.

## 3. Work packages (one PR each)

### WP A — Guard layer + cancel-by-signal (no behavior change for Claude)
**Files:** `apps/worker/src/segment.ts`, `apps/worker/src/git.ts`, `apps/worker/src/guard.ts` (new), `apps/worker/src/guard.test.ts`, `apps/worker/src/runtimes/claude-code.ts` (accept `RunControl`), `packages/shared/src/runtime.ts` (add `RunControl`, keep old fields for now), `apps/api/src/routes/runs.ts` (`GET /api/runs/:id/cancel-requested` behind X-Run-Secret).
**Steps:**
1. `git.ts ensureWorkspace`: set worktree `remote.origin.url` to the credential-less URL (derive by stripping userinfo from `cred.url`; mock/local path unchanged). Test: after `ensureWorkspace`, `git -C wt remote get-url origin` contains no `@`. Confirm `pushBranch` still uses `cred.url` explicitly (it does — assert in test).
2. `guard.ts auditWorktree(ws, writes)`: if `!writes` and `git status --porcelain` non-empty → revert, return `{violated:true, paths}`. Test with a temp repo.
3. `segment.ts`: wrap `runtime.run()` with an `AbortController`; poll cancel endpoint every 5s; on abort, adapter kills; after run, call `auditWorktree` → override outcome to `failed` + `scope:violation` event when violated.
4. `claude-code.ts`: spawn `detached:true`, on `ctl.signal` → `process.kill(-child.pid,'SIGTERM')`, 10s later SIGKILL.
**Verify:** all worker tests; live: dispatch a run, click Cancel in RunView mid-implementer → task fails within ≤15s with the process gone (`pgrep claude` empty).

### WP B — Neutral `ToolPolicy` + `RuntimeCapabilities`; adapters translate
**Files:** `packages/shared/src/runtime.ts`, `apps/worker/src/segment.ts` (`toolsFor` → `policyFor(writes)`), `apps/worker/src/runtimes/claude-code.ts` (`buildArgs` from policy), `claude-code.test.ts`, `codex.ts` stub updated to new signature, `runtimes/index.test.ts`.
**Steps:** replace `allowedTools/deniedTools` with `policy`; `buildArgs` maps policy → today's exact flag set (golden test: same argv as before for both writer and reader). Add `capabilities` to both classes. Heartbeat event for `eventStream:false && toolHooks:false` runtimes (not hit yet).
**Verify:** golden argv tests unchanged; typecheck all 4 apps (shared type change ripples).

### WP C — Provider-generalized auth
**Files:** `packages/shared/src/context.ts` (`runAuthSchema` v2 — keep a shim mapping old `{mode,apiKey,oauthToken}` for one release), `packages/shared/src/settings.ts` (new keys: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_COMPAT_API_KEY`, `OPENAI_COMPAT_BASE_URL`, `GITHUB_COPILOT_TOKEN`, `AGENT_AUTH_OPENAI_MODE`, …; regenerate docs), `apps/api/src/agent-auth.ts` (`computeRunAuth(providerKind)` + `describeAgentAuth()` → map), `apps/worker/src/auth/{index,anthropic,openai,openai-compatible,github}.ts` (move `applyAgentAuth` → `anthropic.ts`), `auth-preflight.ts` → per-adapter `preflight()`, `apps/worker/src/index.ts` (preflight each advertised runtime; `reconcileAuthMode` compares the map), `.github/workflows/ci.yml` (leak grep: credential names allowed only under `src/auth/`).
**Tests:** existing `agent-auth.test.ts` + `auth-preflight.test.ts` ported; new per-translator tests asserting strip-then-set for each kind; `gen-config-docs --check`.
**Verify:** Claude path byte-identical env (golden test); worker boots with `AGENT_RUNTIMES=claude-code` and today's behavior.

### WP D — Model catalogue as data with provider + runtime tags
**Files:** `packages/shared/src/models.ts`, `pricing.ts` (rates move onto `ModelInfo.rate`, `rateFor` reads merged catalogue), `settings.ts` (`MODEL_CATALOG_EXTRA` org JSON; `MODEL_DEFAULT_*` → string; new `RUNTIME_DEFAULT_<ROLE>`), `apps/api/src/models.ts` (`catalogue()` = builtin ⊕ extra; `resolveRoleRuntimesAndModels`; validate pair), `apps/api/src/routes/dispatch.ts` (preview returns `runtimes` from `listFleet` + `models` tagged), `apps/api/src/models.test.ts`, `packages/shared/src/models.test.ts`.
**Verify:** dispatch with a model whose runtime no live worker offers → 400 `no_worker_for_runtime`; adding `{"models":[{"id":"deepseek-chat","providerId":"deepseek","runtimes":["codex","hermes"],"tier":"balanced","rate":{...}}]}` to `MODEL_CATALOG_EXTRA` via `/api/config` shows up in preview with no restart.

### WP E — Real Codex adapter
**Files:** `apps/worker/src/runtimes/codex.ts`, `codex.test.ts` (JSONL fixtures → `AgentOutcome` + emitted events), `settings.ts` (`CODEX_BIN`, `CODEX_EXTRA_ARGS`), `auth/openai.ts` (already from WP C) + generated `~/.codex`-free config: pass `-c model_providers.asf.base_url=<baseUrl> -c model_provider=asf` for openai-compatible, `CODEX_API_KEY` env for openai; `--ephemeral`; `CODEX_HOME=<runDir>/codex-home` so nothing leaks between tasks.
**Verify:** unit: fixtures for success / `turn.failed` / NEEDS_HUMAN in final `agent_message` / sandbox denial. Live: `codex` installed on this Mac (install it first), `AGENT_RUNTIMES=claude-code,codex`, team with `implementer.runtime='codex'`, mock ticket → merged PR on `acme/scratch-repo`; fleet panel shows both runtimes; run cost reported from `turn.completed.usage`. Second live check: point `OPENAI_COMPAT_BASE_URL` at an OpenAI-compatible endpoint (DeepSeek or a local llama.cpp server) with `deepseek-chat` from `MODEL_CATALOG_EXTRA` → a run completes.

### WP F — Hermes adapter
**Files:** `apps/worker/src/runtimes/hermes.ts`, `hermes.test.ts`, `auth/hermes.ts` (renders per-task `HERMES_HOME/config.yaml` with the provider block; never touches `~/.hermes`), `settings.ts` (`HERMES_BIN`).
**Pre-work (spike, throwaway):** confirm on this Mac (a) `hermes chat --query-file - --oneshot -Q --ignore-user-config -m <m> --provider <p> --in <dir> --usage-file u.json` completes headlessly with a custom `HERMES_HOME`, (b) which `-t` toolsets give read-only vs write, (c) whether `hermes hooks` can run a command per tool call (→ `toolHooks:true`) or we fall back to heartbeat, (d) `--max-turns` + `--run-budget` respect. Write findings into the PR description.
**Verify:** live run with `RUNTIME_DEFAULT_PLANNER=hermes` + an OSS model, then a full 4-role run on hermes.

### WP G — UI: runtime per role + `/agents` panel
**Files:** `apps/web/src/components/DispatchModal.tsx` (runtime select → filtered model select), `apps/web/src/views/Agents.tsx` (new; reuse `ProviderSection`/`SettingView` patterns from `Providers.tsx`), `apps/web/src/views/Admin.tsx` (fleet: per-runtime version + preflight pill), `apps/web/src/api.ts`, `apps/api/src/routes/admin.ts` (`GET /api/agents/preflight` aggregating worker-reported preflight — workers post it on register/heartbeat; add `worker.preflight jsonb` via migration 009), router entry.
**Verify:** vite build + tsc; manual: switch implementer to codex in the modal, model list narrows; enter an OpenAI key in `/agents` write-only field → worker heartbeat flips preflight to ok without restart.

### WP H — OpenCode + Copilot adapters, docs
Same shape as WP E, each its own PR. Plus `docs/RUNTIMES.md` (how to add a runtime: one file + one auth translator + catalogue tags; the guard-layer contract; which invariants are hard vs advisory per runtime) and a `docs/runs/` live E2E log per new runtime.

## 4. Migration / compatibility
- `AGENT_RUNTIME` stays accepted as an alias of `AGENT_RUNTIMES` for one release (settings resolver maps it, log a deprecation).
- Existing `run_task.runtime` rows are already `'claude-code'`; no migration.
- `RunAuth` v1 shape accepted by the worker for one release (shim in `context.ts`) so a new api + old worker (or vice-versa) doesn't 400 during a rolling restart.
- `MODEL_DEFAULT_*` values already valid strings; only the validator moves.

## 5. Risks / open questions
- **Scope enforcement without hooks is post-hoc**, not preventive. Acceptable for a read-only role dirtying the worktree (we revert), not for writes outside the tree — only a sandbox (Codex's, or the worker container) prevents that. The fleet UI must say so per runtime rather than pretend. Open question: is "advisory scope" acceptable for hermes/copilot, or do those runtimes require the containerised worker?
- **Cost accounting for plan-billed / unpriced runtimes** (Copilot, Claude subscription) is `null`; budgets (`ORG_MONTHLY_BUDGET_USD`) silently undercount. Already true today for oauth-token mode; now more visible. Surface "unpriced runs this month: N" in Admin.
- **Sub-agents inside a runtime** (Claude Task tool, Hermes `delegate_task`) multiply cost and process count under one ASF task. Kill-tree cancel handles the processes; cost is whatever the runtime reports. Hermes `--max-turns` does not bound children — check in the WP F spike.
- **Codex `-a never` + a permission the sandbox denies** → the run fails rather than parks at `needs_human`. Map `turn.failed` with a sandbox-denial reason to `needs_human` so a human can widen policy? Decide in WP E with real output.
- **Hermes config isolation:** per-task `HERMES_HOME` avoids polluting the operator's real profile but means no skills/memory — intended (deterministic runs). Confirm Hermes honours `HERMES_HOME` fully (spike).
- Copilot CLI has no documented JSON output or usage; lowest priority, may stay text-only.

## 6. Sequencing / effort
A (guard, 1 PR) → B (policy, 1) → C (auth, 1, largest) → D (catalogue, 1) → E (codex, 1 + live E2E) → F (hermes spike + 1) → G (UI, 1) → H (2 adapters + docs). A–D are pure refactors with golden tests keeping Claude behaviour byte-identical; nothing user-visible changes until E. Each PR keeps the full green checklist (shared build, tsc ×4 + web, api/worker tests, `gen-config-docs --check`, leak grep, vite bundle).
