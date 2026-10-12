import type { RunAuth } from '@asf/shared';
import type { AuthTranslator } from './types.js';

/**
 * Anthropic (Claude Code). Moved verbatim from auth-preflight.ts applyAgentAuth —
 * the spawn env is byte-identical to pre-M8 (golden-tested in auth.test.ts).
 *   oauth-token  CLAUDE_CODE_OAUTH_TOKEN — a long-lived subscription token from
 *                `claude setup-token` (Anthropic's documented headless path).
 *   api-key      ANTHROPIC_API_KEY (metered).
 *   vertex       CLAUDE_CODE_USE_VERTEX + project/region; SA credentials must work.
 *   bedrock      CLAUDE_CODE_USE_BEDROCK + region; IAM must work.
 * The strip is the billing-safety invariant: Claude Code prefers ANTHROPIC_API_KEY
 * over an OAuth token, so a stray key in the worker env would silently switch a
 * plan-billed fleet to metered. The declared mode wins.
 */
export const anthropic: AuthTranslator = {
  kind: 'anthropic',
  credentialEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'],
  routingEnv: ['CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_BEDROCK'],
  modeEnv(auth: RunAuth): Record<string, string> {
    switch (auth.mode) {
      case 'vertex': return vertexEnv(auth);
      case 'bedrock': return { CLAUDE_CODE_USE_BEDROCK: '1' };
      default: return {};
    }
  },
  credentialTarget: (auth) => auth.mode === 'api-key' ? 'ANTHROPIC_API_KEY' : auth.mode === 'oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : null,
  credentialSetting: (mode) => mode === 'api-key' ? 'ANTHROPIC_API_KEY' : mode === 'oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : null,
  configProblem: (auth, env) => auth.mode === 'vertex' && !auth.vertex?.projectId && !env.ANTHROPIC_VERTEX_PROJECT_ID
    ? 'Claude on Google Cloud needs a project id (ANTHROPIC_VERTEX_PROJECT_ID): set it in Settings → Which AI should do the work?'
    : null,
};

/**
 * Vertex (M9): the settings travel on the auth (org-set, no restart); a value
 * absent there falls back to the worker's own env. Claude Code picks models by
 * itself in two places ASF does not pass --model: its default (the auth check)
 * and its background/sub-agent calls (haiku, and the sonnet/opus aliases). On
 * Vertex each must be an id the project has enabled, so they are pinned to the
 * allowed catalogue. Non-essential traffic (telemetry, update checks to
 * anthropic.com) is off: a Vertex org usually wants nothing leaving via Anthropic.
 */
function vertexEnv(auth: RunAuth): Record<string, string> {
  const v = auth.vertex ?? {};
  const env: Record<string, string> = { CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  if (v.projectId) env.ANTHROPIC_VERTEX_PROJECT_ID = v.projectId;
  if (v.region) env.CLOUD_ML_REGION = v.region;
  if (v.defaultModel) { env.ANTHROPIC_MODEL = v.defaultModel; env.ANTHROPIC_DEFAULT_SONNET_MODEL = v.defaultModel; }
  if (v.fastModel) { env.ANTHROPIC_DEFAULT_HAIKU_MODEL = v.fastModel; env.ANTHROPIC_SMALL_FAST_MODEL = v.fastModel; }
  if (v.maxModel) env.ANTHROPIC_DEFAULT_OPUS_MODEL = v.maxModel;
  return env;
}
