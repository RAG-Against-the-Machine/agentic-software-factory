/**
 * Preload: resolve every secret:// value in the environment BEFORE any config
 * module evaluates. The entry file imports this first; ESM top-level await here
 * blocks the importer until secrets are hydrated. Kept as its own module because
 * import ordering — not code ordering — is what guarantees "before ./config".
 */
import { bootSecrets } from '@asf/shared';

const { source, resolved } = await bootSecrets();
if (resolved.length) console.log(JSON.stringify({ level: 'info', msg: 'secrets hydrated', source, keys: resolved }));
