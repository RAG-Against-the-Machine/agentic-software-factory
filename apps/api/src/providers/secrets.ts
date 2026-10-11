import type { SecretsSource } from '@asf/shared';
import { resolveSecret } from '@asf/shared';
import { registry } from '../registry/client.js';

/**
 * Resolve a provider-config value that may be a `secret://` pointer, at
 * provider-BUILD time (white-label WP C). Shared by the ticket and SCM provider
 * factories.
 *
 * A UI-entered secret is stored in the org_secret sink (WP B) and its
 * org_setting value is the pointer `secret://org/<KEY>`; cfg() returns that
 * pointer verbatim, and this resolves it to the live token via the registry — so
 * a freshly-entered credential takes effect on the next provider rebuild, no
 * restart.
 *
 * Non-org secret:// pointers still resolve through the deploy-time
 * SECRETS_SOURCE (env|file|gcp|aws). A plain (non-pointer) value passes through
 * unchanged. Reading SECRETS_SOURCE from env at call time (not a boot snapshot)
 * keeps this import-order-free and testable.
 */
export async function resolveProviderSecret(value: string): Promise<string> {
  const source = (process.env.SECRETS_SOURCE as SecretsSource) || 'env';
  const out = await resolveSecret(value, {
    source,
    dir: process.env.SECRETS_DIR || '/run/secrets',
    orgLookup: async (name: string) => (await registry.getOrgSecret(name)).value,
  });
  return String(out);
}
