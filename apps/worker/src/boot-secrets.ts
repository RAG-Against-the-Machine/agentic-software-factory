/**
 * Preload: resolve every secret:// value in the environment BEFORE any config
 * module evaluates. The entry file imports this first; ESM top-level await here
 * blocks the importer until secrets are hydrated. Kept as its own module because
 * import ordering — not code ordering — is what guarantees "before ./config".
 */
import { bootSecrets, dropRegistryOnlyEnv } from '@asf/shared';

// The saved-token key belongs to the registry alone (#9). Drop it before anything
// else runs (or is spawned), and before hydration so it's never fetched here.
dropRegistryOnlyEnv(process.env);
const { source, resolved } = await bootSecrets();
if (resolved.length) console.log(JSON.stringify({ level: 'info', msg: 'secrets hydrated', source, keys: resolved }));
