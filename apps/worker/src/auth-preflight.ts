import type { AgentRuntime, PreflightResult, RunAuth } from '@asf/shared';
import { checkAuthConfig } from './auth/index.js';

/**
 * Check that a runtime can actually authenticate with the given auth, once, at
 * worker start — before this worker offers capacity, so a dead subscription login
 * or a missing API key shows up as "No worker connected", not as twenty failed runs.
 *
 *   1. checkAuthConfig (shared, per provider): static config problems, and "the mode
 *      needs a credential and none is available", naming the setting to fill in.
 *   2. The credential comes from the api (resolved from the org secret), not the
 *      worker env, and the health path never carries it. If the api says it is
 *      present we register and defer the live test to the first spawn, which gets
 *      the resolved value via the run context.
 *   3. Otherwise (a literal credential, or a mode that needs none: vertex/bedrock,
 *      chatgpt, a keyless endpoint) the RUNTIME's own preflight() makes a real call.
 *
 * Every runtime implements preflight (M8 WP C) — there is no "no preflight for
 * runtime X" pass-through any more.
 */
export async function preflightAgentAuth(
  runtime: Pick<AgentRuntime, 'preflight'>,
  auth: RunAuth,
  opts: { credentialPresent?: boolean } = {},
): Promise<PreflightResult> {
  const cfg = checkAuthConfig(auth, process.env, Boolean(opts.credentialPresent));
  if (!cfg.ok) return cfg;
  if (cfg.deferred) return { ok: true, detail: `${auth.mode} (credential present at the api; verified on first run)` };
  return runtime.preflight(auth);
}
