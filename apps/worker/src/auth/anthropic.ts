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
  modeEnv(auth: RunAuth): Record<string, string> {
    switch (auth.mode) {
      case 'vertex': return { CLAUDE_CODE_USE_VERTEX: '1' };
      case 'bedrock': return { CLAUDE_CODE_USE_BEDROCK: '1' };
      default: return {};
    }
  },
  credentialTarget: (auth) => auth.mode === 'api-key' ? 'ANTHROPIC_API_KEY' : auth.mode === 'oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : null,
  credentialSetting: (mode) => mode === 'api-key' ? 'ANTHROPIC_API_KEY' : mode === 'oauth-token' ? 'CLAUDE_CODE_OAUTH_TOKEN' : null,
  configProblem: (auth, env) => auth.mode === 'vertex' && !env.ANTHROPIC_VERTEX_PROJECT_ID ? 'AGENT_AUTH_MODE=vertex needs ANTHROPIC_VERTEX_PROJECT_ID' : null,
};
