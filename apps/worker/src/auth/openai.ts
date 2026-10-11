import { homedir } from 'node:os';
import { join } from 'node:path';
import { symlink } from 'node:fs/promises';
import type { RunAuth } from '@asf/shared';
import type { AuthTranslator } from './types.js';

/**
 * OpenAI (Codex CLI). api-key sets both names Codex honours (CODEX_API_KEY is what
 * `codex exec` reads first; OPENAI_API_KEY for SDK-based tools). chatgpt carries no
 * credential: the ChatGPT-plan login must already be in the runtime's own home on
 * the worker. OPENAI_BASE_URL is the optional endpoint override (non-secret).
 */
export const openai: AuthTranslator = {
  kind: 'openai',
  credentialEnv: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  modeEnv: (auth): Record<string, string> => (auth.baseUrl ? { OPENAI_BASE_URL: auth.baseUrl } : {}),
  credentialTarget: (auth) => (auth.mode === 'api-key' ? 'CODEX_API_KEY' : null),
  credentialSetting: (mode) => (mode === 'api-key' ? 'OPENAI_API_KEY' : null),
};

/** The credential is mirrored into OPENAI_API_KEY too (see index.ts ALSO_SET). */
export const OPENAI_ALSO_SET: Record<string, string[]> = { CODEX_API_KEY: ['OPENAI_API_KEY'] };

/**
 * chatgpt mode under a per-task CODEX_HOME (M8 WP E): the plan login lives in the
 * worker's own Codex home, so link its auth.json into the task's home — a link, not
 * a copy, so a token Codex refreshes during one task is still valid for the next.
 * Any other mode carries its credential in the env and links nothing.
 */
export async function linkChatgptLogin(auth: RunAuth, taskHome: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (auth.providerKind !== 'openai' || auth.mode !== 'chatgpt') return;
  const src = join(env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
  await symlink(src, join(taskHome, 'auth.json')).catch(() => { /* already linked; a missing login is Codex's to report */ });
}
