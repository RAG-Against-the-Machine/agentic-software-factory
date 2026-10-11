import type { Role } from './team.js';
import type { RunAuth } from './context.js';

export interface AgentUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }

/**
 * A role's tool permissions, independent of any one agent's tool names (M8 WP B).
 * The worker decides this from the team role; the adapter translates it. Enforcement
 * strength differs per runtime (see RuntimeCapabilities.toolHooks) — the worker's
 * guard layer (guard.ts) is the runtime-agnostic backstop.
 */
export interface ToolPolicy {
  /** Where the role may write: the whole worktree (writing roles) or only its artifact
   * under the run dir (read-only roles). Every role may write its run-dir artifact. */
  fileWrite: 'worktree' | 'run-dir-only';
  /** May run shell commands (tests, builds, greps). */
  shell: boolean;
  /** May fetch from / search the web. */
  network: boolean;
  /** Always false: the worker pushes, never the agent. A literal type so no caller can flip it. */
  gitPush: false;
}

/**
 * What a runtime can do for ASF (M8 WP B), declared by each adapter so the worker
 * and the fleet UI can tell hard enforcement from advisory.
 */
export interface RuntimeCapabilities {
  /** Calls back per tool use (hooks/plugins) so ASF can block in-line and see liveness. */
  toolHooks: boolean;
  /** Emits a machine-readable event stream ASF can tail for telemetry/liveness. */
  eventStream: boolean;
  /** Reports its own USD cost (else priceUsage() from usage, else unpriced). */
  reportsCost: boolean;
  /** Validates model ids itself (probe returns them) vs relying on ASF's catalogue. */
  listsModels: boolean;
  /** Can continue an earlier agent session by id (Claude Code `--resume`), so a follow-up
   * turn in a conversation (the planner chat) doesn't re-read the repo from scratch. */
  resumesSessions?: boolean;
  /** Blocks out-of-scope writes BEFORE they happen, by itself: its own hooks (Claude) or
   * its own OS sandbox (Codex workspace-write). A runtime without this is offered only
   * by a containerised worker, where the container is that boundary (docs/RUNTIMES.md). */
  confinesWrites: boolean;
  /** Finds skill folders in its working directory by itself (Claude Code reads
   * `.claude/skills/<name>/SKILL.md`). Without it, the worker writes skills to the run dir
   * and describes them in the prompt instead. */
  loadsSkillFiles?: boolean;
}

export type PreflightResult = { ok: true; detail: string } | { ok: false; reason: string };

export interface AgentSpawn {
  role: Role;
  prompt: string;
  cwd: string;
  model?: string;
  /** Reasoning effort (claude -p --effort <level>); undefined = the CLI default. */
  effort?: string;
  maxCostUsd: number;
  /** What the role may do, neutrally. Each adapter translates this into its own flags
   * (Claude `--allowedTools`, Codex `-s`, OpenCode permission map, Hermes toolsets). */
  policy: ToolPolicy;
  env: Record<string, string>;
  /** Effective agent auth for this run (mode + resolved key for api-key), from the
   * api-supplied run context. The runtime applies it per spawn so a mode change
   * takes effect on the next task with no worker restart. */
  auth: RunAuth;
  timeoutMs: number;
  /** Continue this earlier agent session instead of starting fresh; `prompt` is then just
   * the next message in the conversation. Only set when the runtime resumesSessions. */
  resumeSessionId?: string;
  maxTurns?: number;   // backstop against a wedged agent looping; passed as --max-turns. 0/undefined = no ceiling.
}

export interface AgentOutcome {
  outcome: 'done' | 'failed' | 'needs_human' | 'timeout';
  text: string;
  usage: AgentUsage | null;
  costUsd: number | null;
  /** How many agent turns the run took, when the runtime reports it (num_turns). */
  turns?: number | null;
  /** Why the runtime stopped: 'error_max_turns' | 'timeout' | ... — for the UI, not control flow. */
  terminalReason?: string | null;
  /** The agent session this run used, when the runtime has one (resumable later). */
  sessionId?: string | null;
}

export interface EventSink { emit(e: { kind: string; payload: Record<string, unknown> }): void }

export interface AgentHandle { cancel(): Promise<void> }

/**
 * Worker-owned control over one runtime invocation (M8 WP A). `signal` aborts
 * when the operator cancels the run — the worker polls the api for it, so cancel
 * works for a runtime with no tool hooks. The adapter must stop the agent (kill
 * its whole process tree) and resolve with outcome `failed`.
 */
export interface RunControl { signal: AbortSignal }

/**
 * One implementation per headless coding agent. `claude-code` is first; the
 * surface is small on purpose so codex / opencode / hermes are each a file.
 */
export interface AgentRuntime {
  readonly kind: string;
  readonly capabilities: RuntimeCapabilities;
  /**
   * Live auth check at worker start, BEFORE the worker offers capacity (M8 WP C): a
   * trivial call through the real binary with this auth. Only called when the auth
   * carries what the mode needs (a literal credential, or a mode that needs none);
   * the worker's shared checkAuthConfig handles "credential missing" first.
   */
  preflight(auth: RunAuth): Promise<PreflightResult>;
  probe(): Promise<{ ok: boolean; version: string; models: string[] }>;
  run(spawn: AgentSpawn, sink: EventSink, ctl?: RunControl): Promise<AgentOutcome>;
}
