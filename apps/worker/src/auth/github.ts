import type { AuthTranslator } from './types.js';

/**
 * GitHub (Copilot CLI). Copilot reads COPILOT_GITHUB_TOKEN first, then GH_TOKEN,
 * then GITHUB_TOKEN; the worker sets the first and strips the Copilot-specific
 * ones. GITHUB_TOKEN is deliberately NOT in the strip list: it is the worker's SCM
 * variable (blanked for the worker by the compose file, and never forwarded as an
 * agent credential), and since COPILOT_GITHUB_TOKEN wins, a set token always takes
 * precedence over it.
 */
export const github: AuthTranslator = {
  kind: 'github',
  credentialEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_COPILOT_TOKEN'],
  modeEnv: () => ({}),
  credentialTarget: (auth) => (auth.mode === 'gh-token' ? 'COPILOT_GITHUB_TOKEN' : null),
  credentialSetting: (mode) => (mode === 'gh-token' ? 'GITHUB_COPILOT_TOKEN' : null),
};
