/**
 * Provider-secret resolution moved to the shared `../secrets.ts` so both the
 * ticket and SCM provider factories use one implementation. Re-exported here so
 * existing imports (`./secrets.js` from within tickets/) keep working.
 */
export { resolveProviderSecret } from '../secrets.js';
