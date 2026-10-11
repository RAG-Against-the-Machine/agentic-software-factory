#!/usr/bin/env node
import { env, isFactoryRun, readInput, writtenPaths, writeAllowed, writeScope, isBlockedBash, block, writeHalt, describeTool, postEvent } from './lib.mjs';

/**
 * PreToolUse. Three jobs in order — scope, telemetry, cancel — and the order
 * is the design. Exit 0 allows; exit 2 (with a JSON block decision) refuses.
 * Fails open on a network error: restarting the api must not kill the fleet.
 */
if (!isFactoryRun()) process.exit(0);
const input = await readInput();

// 1. SCOPE — purely local, works whether or not the api is up. Every role may
// write its artifact under the run dir; only a writing role may touch the worktree.
for (const path of writtenPaths(input)) {
  if (writeAllowed(path)) continue;
  const scope = writeScope(path);
  const reason = scope === 'worktree'
    ? `This is a read-only role (${env.role}); it may not change source files. Refused ${path}. Write only your artifact under ${env.runDir}.`
    : `Refused a write to ${path}: outside this run's worktree (${env.scopeRoot}) and run dir (${env.runDir}).`;
  writeHalt('scope', { path, reason });
  await postEvent('scope:violation', { path, reason });
  block(reason);
}
const bashReason = isBlockedBash(input);
if (bashReason) { writeHalt('scope', { reason: bashReason }); await postEvent('scope:violation', { reason: bashReason }); block(bashReason); }

// 2. TELEMETRY (also the liveness signal) + 3. CANCEL (carried on the ack).
const ack = await postEvent('tool:pre', { tool: input?.tool_name ?? 'unknown', summary: describeTool(input) });
if (ack && ack.cancelRequested) block('Run cancelled by the operator. Stop now.');
process.exit(0);
