import type { RunAuth } from '@asf/shared';
import type { AuthTranslator } from './types.js';

/**
 * Any OpenAI-compatible endpoint (DeepSeek, Qwen, GLM, a local vLLM/llama.cpp
 * server). The credential goes in OPENAI_COMPAT_API_KEY — a name no runtime reads
 * by default, so an adapter must point at it explicitly (Codex:
 * `-c model_providers.asf.env_key=OPENAI_COMPAT_API_KEY`, WP E) and a stray real
 * OpenAI key can never be sent to a third-party endpoint. The endpoint travels as
 * OPENAI_COMPAT_BASE_URL. mode 'none' = a keyless (local) server.
 */
export const openaiCompatible: AuthTranslator = {
  kind: 'openai-compatible',
  credentialEnv: ['OPENAI_COMPAT_API_KEY'],
  modeEnv: (auth): Record<string, string> => (auth.baseUrl ? { OPENAI_COMPAT_BASE_URL: auth.baseUrl } : {}),
  credentialTarget: (auth) => (auth.mode === 'api-key' ? 'OPENAI_COMPAT_API_KEY' : null),
  credentialSetting: (mode) => (mode === 'api-key' ? 'OPENAI_COMPAT_API_KEY' : null),
  configProblem: (auth) => (auth.baseUrl ? null : 'the openai-compatible provider needs OPENAI_COMPAT_BASE_URL (set it in .env; the Settings UI does not offer this provider yet)'),
};

/**
 * Codex's `-c` overrides that point it at the compat endpoint (M8 WP E): a
 * generated `asf` model provider, so no config.toml is needed. env_key names the
 * one variable applyAuth set (omitted for a keyless server). Current Codex only
 * speaks the Responses wire API (`chat` is rejected), so the endpoint must too.
 */
export function codexCompatArgs(auth: RunAuth): string[] {
  const kv = [
    'model_providers.asf.name=asf',
    `model_providers.asf.base_url=${auth.baseUrl ?? ''}`,
    ...(auth.mode === 'api-key' ? ['model_providers.asf.env_key=OPENAI_COMPAT_API_KEY'] : []),
    'model_providers.asf.wire_api=responses',
    'model_provider=asf',
  ];
  return kv.flatMap((c) => ['-c', c]);
}

/**
 * OpenCode's provider block for the compat endpoint (M8 WP H): a generated `asf`
 * provider on the AI SDK's openai-compatible package. A custom provider must list
 * its models, so the task's model is declared here. The key is referenced by env
 * name (OpenCode's `{env:…}` substitution), never written into the config file.
 */
export function opencodeCompatProvider(auth: RunAuth, model: string | undefined): Record<string, unknown> {
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'asf',
    options: { baseURL: auth.baseUrl ?? '', ...(auth.mode === 'api-key' ? { apiKey: '{env:OPENAI_COMPAT_API_KEY}' } : {}) },
    models: model ? { [model]: {} } : {},
  };
}
