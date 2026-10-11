import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * At-rest encryption for the org_secret sink (#9). Pure functions, no DB.
 *
 * A stored value is either legacy plaintext or a self-describing envelope
 *
 *   enc:v1:<keyId>:<iv>:<tag>:<ciphertext>        (iv/tag/ciphertext base64)
 *
 * AES-256-GCM with a random 12-byte IV per write. The row's NAME is bound as
 * additional authenticated data, so an envelope copied onto another row fails
 * to decrypt instead of quietly handing one provider another provider's token.
 * keyId is a fingerprint of the key (never the key), so the registry can tell
 * which key a row needs without trying them all, and doctor can show it.
 */

export const ENVELOPE_PREFIX = 'enc:v1:';

export interface SecretKey { id: string; key: Buffer }
/** current encrypts; previous only decrypts (rotation). */
export interface SecretKeyring { current: SecretKey | null; previous: SecretKey | null }

/** A missing/wrong key or a tampered value. Never "unset": callers must not treat it as no secret. */
export class SecretKeyError extends Error {
  constructor(message: string) { super(message); this.name = 'SecretKeyError'; }
}

/** 32 bytes as 64 hex chars (what setup.sh writes) or base64. Blank = no key. Anything else throws. */
export function parseSecretKey(raw: string | undefined | null, envName = 'ASF_SECRET_KEY'): SecretKey | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) key = Buffer.from(v, 'base64');
  else throw new SecretKeyError(`${envName} must be 32 random bytes as 64 hex characters (openssl rand -hex 32) or base64`);
  if (key.length !== 32) throw new SecretKeyError(`${envName} must be 32 bytes; got ${key.length}. Generate one with: openssl rand -hex 32`);
  return { id: keyIdOf(key), key };
}

export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update('asf-org-secret-key-id:').update(key).digest('hex').slice(0, 8);
}

export function keyringFrom(currentRaw: string | undefined | null, previousRaw: string | undefined | null): SecretKeyring {
  const current = parseSecretKey(currentRaw, 'ASF_SECRET_KEY');
  const previous = parseSecretKey(previousRaw, 'ASF_SECRET_KEY_PREVIOUS');
  return { current, previous: previous && current && previous.id === current.id ? null : previous };
}

export function isEnvelope(stored: string): boolean {
  return stored.startsWith(ENVELOPE_PREFIX);
}

/** The keyId an envelope was written with (null for plaintext or a malformed envelope). */
export function envelopeKeyId(stored: string): string | null {
  if (!isEnvelope(stored)) return null;
  const parts = stored.slice(ENVELOPE_PREFIX.length).split(':');
  return parts.length === 4 && parts[0] ? parts[0] : null;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const aad = (name: string) => Buffer.from(`org_secret:${name}`, 'utf8');

export function encryptSecret(name: string, value: string, key: SecretKey): string {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv('aes-256-gcm', key.key, iv, { authTagLength: TAG_BYTES });
  c.setAAD(aad(name));
  const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return `${ENVELOPE_PREFIX}${key.id}:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/** The key in the ring that matches an envelope's keyId, or null. */
export function keyFor(stored: string, ring: SecretKeyring): SecretKey | null {
  const id = envelopeKeyId(stored);
  if (!id) return null;
  if (ring.current?.id === id) return ring.current;
  if (ring.previous?.id === id) return ring.previous;
  return null;
}

/** Plaintext passes through (legacy rows, or no key configured). An envelope needs its key. */
export function decryptSecret(name: string, stored: string, ring: SecretKeyring): string {
  if (!isEnvelope(stored)) return stored;
  const id = envelopeKeyId(stored);
  if (!id) throw new SecretKeyError(`saved secret ${name} is damaged (not a valid encrypted value)`);
  const key = keyFor(stored, ring);
  if (!key) {
    const have = [ring.current?.id, ring.previous?.id].filter(Boolean).join(', ');
    throw new SecretKeyError(have
      ? `saved secret ${name} was encrypted with key ${id}, but ASF_SECRET_KEY is key ${have}. Restore the matching ASF_SECRET_KEY (or set the old one as ASF_SECRET_KEY_PREVIOUS), or save the token again in Settings`
      : `saved secret ${name} is encrypted (key ${id}) but ASF_SECRET_KEY is not set on the registry. Restore it in .env, or save the token again in Settings`);
  }
  const [, ivB, tagB, ctB] = stored.slice(ENVELOPE_PREFIX.length).split(':');
  const iv = Buffer.from(ivB, 'base64');
  const tag = Buffer.from(tagB, 'base64');
  // A full-length tag, always: some Node versions accept a truncated GCM tag,
  // which would make forging an envelope 2^32 work instead of 2^128.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretKeyError(`saved secret ${name} is damaged (not a valid encrypted value)`);
  }
  try {
    const d = createDecipheriv('aes-256-gcm', key.key, iv, { authTagLength: TAG_BYTES });
    d.setAAD(aad(name));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(ctB, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new SecretKeyError(`saved secret ${name} failed its integrity check (tampered, or copied from another row). Save the token again in Settings`);
  }
}
