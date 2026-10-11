import type { AgentRuntime } from '@asf/shared';
import { config } from '../config.js';
import { ClaudeCodeRuntime } from './claude-code.js';
import { CodexRuntime } from './codex.js';
import { OpencodeRuntime } from './opencode.js';
import { CopilotRuntime } from './copilot.js';

/**
 * Per-task runtime options that are NOT part of the neutral AgentSpawn: where
 * this task's transcript is written, and any runtime-specific config file (for
 * Claude Code, the hooks settings). Kept opaque here so segment.ts never names
 * a concrete runtime — the whole point of the seam.
 */
export interface RuntimeTaskOptions {
  logPath?: string;
  /** A runtime-specific settings/config file the worker prepared for this task. */
  settingsPath?: string;
}

/**
 * The one place a concrete runtime is chosen. Add Codex / OpenCode / Hermes /
 * Aider as a sibling file implementing AgentRuntime plus a case here; nothing
 * else in the worker, registry or api changes.
 */
export function loadRuntime(kind: string, task: RuntimeTaskOptions = {}): AgentRuntime {
  switch (kind) {
    case 'claude-code':
      return new ClaudeCodeRuntime({ bin: config.claudeBin, settingsPath: task.settingsPath, logPath: task.logPath });
    case 'codex':
      return new CodexRuntime({ bin: config.codexBin, logPath: task.logPath });
    case 'opencode':
      return new OpencodeRuntime({ bin: config.opencodeBin, logPath: task.logPath });
    case 'copilot':
      return new CopilotRuntime({ bin: config.copilotBin, logPath: task.logPath });
    // case 'hermes':   return new HermesRuntime({ ... });
    default:
      throw new Error(`Unknown AGENT_RUNTIME: ${kind}. Add a runtime file and a case in loadRuntime().`);
  }
}
