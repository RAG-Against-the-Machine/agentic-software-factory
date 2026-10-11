import type { OrgValues, SettingKey, SettingView } from '@asf/shared';
import { resolve, describeSettings, orgSettableKeys, SettingError, SETTINGS } from '@asf/shared';
import { registry } from './registry/client.js';

/**
 * The api's view of the org-tier settings. The registry owns the org_setting
 * table (it has the only DB connection); the api caches the values so a request
 * path resolves a policy key without a round trip, and refreshes the cache after
 * any write. Deploy-time (env) keys are still read straight from process.env by
 * config.ts — this module is only the org tier and the merged resolver.
 */
let orgCache: OrgValues = {};
let loaded = false;

/** Load org values from the registry once at boot (and after each write). */
export async function loadOrgSettings(): Promise<void> {
  try {
    const { settings } = await registry.getOrgSettings();
    orgCache = settings as OrgValues;
    loaded = true;
  } catch (e) {
    // A registry that is briefly down must not take the api down; fall back to
    // env+defaults and try again on the next write/refresh.
    orgCache = loaded ? orgCache : {};
    throw new Error(`could not load org settings from the registry: ${(e as Error).message}`);
  }
}

/** Whether the org tier has been loaded at least once (false = serving env+defaults only). */
export function orgSettingsLoaded(): boolean {
  return loaded;
}

/**
 * Keep retrying the initial org-settings load until it succeeds. At boot the api
 * and registry come up together and the registry may not be listening yet; a
 * one-shot load that fails leaves the api serving env+defaults with an EMPTY org
 * tier — every UI-entered setting (providers, agent credential, gates) silently
 * absent until something triggers a reload. That is a correctness problem, not
 * just a warning: the worker reads /api/agent-auth at boot and would crash-loop
 * on "no credential" while a credential sits in the registry.
 *
 * Bounded exponential backoff (delayMs → maxDelayMs); `onRetry` gets each
 * failure so the caller can log it. Resolves on the first success; never rejects.
 */
export async function loadOrgSettingsWithRetry(opts: {
  delayMs?: number; maxDelayMs?: number; onRetry?: (attempt: number, err: Error, nextDelayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let delay = opts.delayMs ?? 500;
  const max = opts.maxDelayMs ?? 10_000;
  for (let attempt = 1; ; attempt++) {
    try { await loadOrgSettings(); return; }
    catch (e) {
      opts.onRetry?.(attempt, e as Error, delay);
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

/** Resolve any setting through env > org(cache) > default. */
export function cfg<K extends SettingKey>(key: K): (typeof SETTINGS)[K]['default'] {
  return resolve(key, process.env, orgCache);
}

/** The org values currently cached (for dispatch's gate-policy merge). */
export function orgValues(): OrgValues {
  return orgCache;
}

/** The catalogue for the /admin UI: metadata + current values, secrets redacted. */
export function describe(): SettingView[] {
  return describeSettings(process.env, orgCache);
}

/**
 * Write one org setting. Refuses a key that is not org-settable (deploy-time
 * config) or a value the catalogue rejects — the same rule the registry
 * enforces, checked here first so the UI gets a clean 400 with the reason.
 * Refreshes the cache from the registry after the write.
 *
 * SECRET INDIRECTION (white-label WP C): a secret:true org key never stores its
 * raw bytes in org_setting (that jsonb is read into the api cache and would sit
 * cleartext). Instead the bytes go to the org_secret sink (WP B) under the bare
 * key name, and the org_setting value becomes the pointer `secret://org/<KEY>`,
 * resolved to the real token only at provider-build time. Submitting an empty
 * secret clears both. describeSettings redacts the pointer to '***', so the
 * browser only ever learns set/unset.
 */
export async function putSetting(key: string, value: unknown, by: string | null): Promise<void> {
  if (!(key in SETTINGS)) throw new SettingError(`unknown setting ${key}`);
  if (!orgSettableKeys().includes(key as SettingKey)) throw new SettingError(`${key} is deploy-time configuration and cannot be set from the UI`);
  const def = SETTINGS[key as SettingKey];
  if (def.secret) {
    const token = value == null ? '' : String(value);
    if (token === '') {
      // Empty = clear the secret and its pointer.
      await registry.deleteOrgSecret(key);
      await registry.deleteOrgSetting(key);
    } else {
      // Bytes to the write-only sink; org_setting holds only the pointer.
      await registry.putOrgSecret(key, token, by);
      await registry.putOrgSetting(key, `secret://org/${key}`, by);
    }
    await loadOrgSettings();
    return;
  }
  // Validate coercion locally by resolving a probe with the candidate value.
  resolve(key as SettingKey, {}, { [key]: value } as OrgValues);
  await registry.putOrgSetting(key, value, by);
  await loadOrgSettings();
}

export async function deleteSetting(key: string): Promise<void> {
  // For a secret key, also drop the paired bytes from the sink.
  if (key in SETTINGS && SETTINGS[key as SettingKey].secret) await registry.deleteOrgSecret(key);
  await registry.deleteOrgSetting(key);
  await loadOrgSettings();
}
