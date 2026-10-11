/**
 * secret:// resolution. Any setting value of the form `secret://name` is a
 * pointer, not the secret itself; where the bytes actually live is a single
 * deploy-time choice — SECRETS_SOURCE — so the same config file works on a
 * laptop (`env`), in Docker/K8s (`file`), and in a cloud project (`gcp`/`aws`).
 *
 *   env   the value after secret:// is itself the literal secret (or names an
 *         env var of the same name — the laptop default, no infra needed).
 *   file  SECRETS_DIR/<name> holds the secret (Docker/K8s mounted secrets).
 *   gcp   Secret Manager: projects/<PROJECT>/secrets/<name>/versions/latest.
 *   aws   Secrets Manager: GetSecretValue(SecretId=<name>).
 *
 * gcp and aws are resolved through their SDKs, imported lazily so neither is a
 * hard dependency of a laptop or Docker install. resolveSecrets() walks a flat
 * config object once at boot and replaces every pointer in place.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type SecretsSource = 'env' | 'file' | 'gcp' | 'aws';

export class SecretError extends Error {}

const PREFIX = 'secret://';

export function isSecretRef(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export function secretName(ref: string): string {
  return ref.slice(PREFIX.length);
}

export interface SecretsConfig {
  source: SecretsSource;
  dir?: string;              // file mode
  gcpProject?: string;       // gcp mode (else inferred from ADC)
  awsRegion?: string;        // aws mode
  env?: NodeJS.ProcessEnv;   // injectable for tests
  /**
   * DB-backed secret sink (white-label WP B). A secret named `org/<KEY>` is
   * resolved through this lookup regardless of `source`, so a UI-entered token
   * (stored write-only in org_secret) composes with the existing indirection
   * without changing SECRETS_SOURCE. shared has no DB access; the api supplies
   * this backed by the registry RPC, and resolves it at provider-build time so
   * a freshly-entered token takes effect live.
   */
  orgLookup?: (name: string) => Promise<string | null>;
}

const ORG_PREFIX = 'org/';

async function resolveOne(name: string, cfg: SecretsConfig): Promise<string> {
  const env = cfg.env ?? process.env;
  if (name.startsWith(ORG_PREFIX)) {
    if (!cfg.orgLookup) throw new SecretError(`secret "${name}": no org secret lookup configured`);
    const v = await cfg.orgLookup(name.slice(ORG_PREFIX.length));
    if (v == null) throw new SecretError(`secret "${name}": not set in the org secret store`);
    return v;
  }
  switch (cfg.source) {
    case 'env': {
      // secret://FOO means "the literal is in env FOO"; if unset, treat the
      // name itself as the literal (so secret://a-literal also works in a pinch).
      const v = env[name];
      return v !== undefined ? v : name;
    }
    case 'file': {
      const dir = cfg.dir ?? '/run/secrets';
      const file = path.join(dir, name);
      try {
        return (await readFile(file, 'utf8')).replace(/\n$/, '');
      } catch (e) {
        throw new SecretError(`secret "${name}": cannot read ${file} (SECRETS_SOURCE=file): ${(e as Error).message}`);
      }
    }
    case 'gcp': {
      let client: { accessSecretVersion(req: { name: string }): Promise<[{ payload?: { data?: Uint8Array | string } }]> };
      try {
        // Indirect specifier so tsc does not try to resolve this optional SDK at
        // build time; it is a runtime-only dependency of the gcp path.
        const spec = '@google-cloud/secret-manager';
        const mod = (await import(/* @vite-ignore */ spec)) as {
          SecretManagerServiceClient: new () => typeof client;
        };
        client = new mod.SecretManagerServiceClient();
      } catch (e) {
        throw new SecretError(`SECRETS_SOURCE=gcp needs @google-cloud/secret-manager installed: ${(e as Error).message}`);
      }
      const project = cfg.gcpProject ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
      // Allow a fully-qualified resource name to pass through unchanged.
      const resource = name.startsWith('projects/')
        ? name
        : `projects/${project ?? '-'}/secrets/${name}/versions/latest`;
      const [res] = await client.accessSecretVersion({ name: resource });
      const data = res.payload?.data;
      if (data == null) throw new SecretError(`secret "${name}": empty payload from Secret Manager`);
      return typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    }
    case 'aws': {
      let client: { send(cmd: unknown): Promise<{ SecretString?: string; SecretBinary?: Uint8Array }> };
      let GetSecretValueCommand: new (i: { SecretId: string }) => unknown;
      try {
        const spec = '@aws-sdk/client-secrets-manager';
        const mod = (await import(/* @vite-ignore */ spec)) as {
          SecretsManagerClient: new (o: { region?: string }) => typeof client;
          GetSecretValueCommand: typeof GetSecretValueCommand;
        };
        client = new mod.SecretsManagerClient({ region: cfg.awsRegion ?? env.AWS_REGION });
        GetSecretValueCommand = mod.GetSecretValueCommand;
      } catch (e) {
        throw new SecretError(`SECRETS_SOURCE=aws needs @aws-sdk/client-secrets-manager installed: ${(e as Error).message}`);
      }
      const res = await client.send(new GetSecretValueCommand({ SecretId: name }));
      if (res.SecretString != null) return res.SecretString;
      if (res.SecretBinary != null) return Buffer.from(res.SecretBinary).toString('utf8');
      throw new SecretError(`secret "${name}": no SecretString or SecretBinary from Secrets Manager`);
    }
  }
}

/**
 * Resolve every `secret://` value that sits directly in process.env, in place,
 * so that the settings resolver (which reads process.env) transparently sees the
 * real secret. Call this ONCE, before any config module is imported — from a
 * preload module the entry file imports first. In env mode it is a cheap
 * in-process substitution; in file/gcp/aws mode it does the I/O up front so a
 * bad secret fails at boot, not mid-run.
 */
export async function hydrateSecretEnv(secrets: SecretsConfig): Promise<string[]> {
  const env = secrets.env ?? process.env;
  const resolvedKeys: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretRef(value)) continue;
    try {
      env[key] = String(await resolveOne(secretName(value), { ...secrets, env }));
      resolvedKeys.push(key);
    } catch (e) {
      if (e instanceof SecretError) throw new SecretError(`${key}: ${e.message}`);
      throw new SecretError(`${key}: resolving ${value as string} via SECRETS_SOURCE=${secrets.source} failed: ${(e as Error).message}`);
    }
  }
  return resolvedKeys;
}

/** Resolve a single secret ref (or pass a non-ref through unchanged). */
export async function resolveSecret(value: unknown, cfg: SecretsConfig): Promise<unknown> {
  if (!isSecretRef(value)) return value;
  return resolveOne(secretName(value), cfg);
}

/**
 * The one call every service makes at the very top of boot: read SECRETS_SOURCE
 * / SECRETS_DIR straight from the environment (the settings catalogue has not run
 * yet) and hydrate every secret:// value in process.env. Import this from a
 * preload module BEFORE ./config so the resolved values are in place when config
 * evaluates. Logs which keys were resolved (names only, never values).
 */
export async function bootSecrets(env: NodeJS.ProcessEnv = process.env): Promise<{ source: SecretsSource; resolved: string[] }> {
  const source = (env.SECRETS_SOURCE as SecretsSource) || 'env';
  if (!['env', 'file', 'gcp', 'aws'].includes(source)) throw new SecretError(`SECRETS_SOURCE="${source}" is not one of env | file | gcp | aws`);
  const resolved = await hydrateSecretEnv({
    source,
    dir: env.SECRETS_DIR || '/run/secrets',
    gcpProject: env.ANTHROPIC_VERTEX_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT,
    awsRegion: env.AWS_REGION,
    env,
  });
  return { source, resolved };
}

/**
 * Resolve every secret:// pointer in a flat config object, in place, once at
 * boot. Non-ref values are left exactly as they are. Fails loud, naming the
 * key and the secret, rather than starting a service with a placeholder that
 * would later 401 mid-run.
 */
export async function resolveSecrets<T extends Record<string, unknown>>(cfg: T, secrets: SecretsConfig): Promise<T> {
  if (secrets.source === 'env') {
    // env mode still substitutes secret://NAME → env[NAME]; no I/O, no SDK.
  }
  const out: Record<string, unknown> = { ...cfg };
  for (const [key, value] of Object.entries(out)) {
    if (!isSecretRef(value)) continue;
    try {
      out[key] = await resolveOne(secretName(value), secrets);
    } catch (e) {
      if (e instanceof SecretError) throw new SecretError(`${key}: ${e.message}`);
      throw new SecretError(`${key}: resolving ${value} via SECRETS_SOURCE=${secrets.source} failed: ${(e as Error).message}`);
    }
  }
  return out as T;
}
