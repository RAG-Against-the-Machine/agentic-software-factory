import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  parseSecretKey, keyringFrom, encryptSecret, decryptSecret, isEnvelope, envelopeKeyId, SecretKeyError, ENVELOPE_PREFIX,
} from './secret-crypto.js';

const hexKey = () => randomBytes(32).toString('hex');

test('parses a 64-hex or base64 key; blank = no key; anything else is a clear error', () => {
  const h = hexKey();
  const a = parseSecretKey(h)!;
  const b = parseSecretKey(Buffer.from(h, 'hex').toString('base64'))!;
  assert.equal(a.key.length, 32);
  assert.equal(a.id, b.id, 'same bytes, same fingerprint, whatever the encoding');
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(parseSecretKey(''), null);
  assert.equal(parseSecretKey('   '), null);
  assert.equal(parseSecretKey(undefined), null);
  assert.throws(() => parseSecretKey('abc'), SecretKeyError);
  assert.throws(() => parseSecretKey(randomBytes(16).toString('hex')), /32 bytes/);
  assert.throws(() => parseSecretKey('not a key!!'), /openssl rand -hex 32/);
});

test('round-trips, uses a fresh IV per write, and never leaves the plaintext in the envelope', () => {
  const ring = keyringFrom(hexKey(), '');
  const e1 = encryptSecret('GITHUB_TOKEN', 'ghp_secret_value', ring.current!);
  const e2 = encryptSecret('GITHUB_TOKEN', 'ghp_secret_value', ring.current!);
  assert.ok(e1.startsWith(ENVELOPE_PREFIX) && isEnvelope(e1));
  assert.notEqual(e1, e2);
  assert.ok(!e1.includes('ghp_secret_value'));
  assert.equal(envelopeKeyId(e1), ring.current!.id);
  assert.equal(decryptSecret('GITHUB_TOKEN', e1, ring), 'ghp_secret_value');
  assert.equal(decryptSecret('X', encryptSecret('X', '', ring.current!), ring), '', 'empty value');
  assert.equal(decryptSecret('X', encryptSecret('X', 'ünïcødé ✓', ring.current!), ring), 'ünïcødé ✓');
});

test('plaintext (legacy rows) passes through, with or without a key', () => {
  assert.equal(decryptSecret('A', 'plain-token', keyringFrom('', '')), 'plain-token');
  assert.equal(decryptSecret('A', 'plain-token', keyringFrom(hexKey(), '')), 'plain-token');
});

test('an envelope moved to another row fails (name is bound as AAD)', () => {
  const ring = keyringFrom(hexKey(), '');
  const e = encryptSecret('GITHUB_TOKEN', 'v', ring.current!);
  assert.throws(() => decryptSecret('GITLAB_TOKEN', e, ring), /integrity check/);
});

test('a tampered envelope fails its integrity check', () => {
  const ring = keyringFrom(hexKey(), '');
  const e = encryptSecret('A', 'value-123', ring.current!);
  const parts = e.split(':');
  const ct = Buffer.from(parts[5], 'base64'); ct[0] ^= 1; parts[5] = ct.toString('base64');
  assert.throws(() => decryptSecret('A', parts.join(':'), ring), SecretKeyError);
  assert.throws(() => decryptSecret('A', 'enc:v1:garbage', ring), /damaged/);
});

test('missing or wrong key is an error naming both key ids, never an empty value', () => {
  const k1 = hexKey(); const k2 = hexKey();
  const e = encryptSecret('A', 'v', keyringFrom(k1, '').current!);
  assert.throws(() => decryptSecret('A', e, keyringFrom('', '')), /not set on the registry/);
  const wrong = keyringFrom(k2, '');
  assert.throws(() => decryptSecret('A', e, wrong), (err: Error) =>
    err instanceof SecretKeyError && err.message.includes(envelopeKeyId(e)!) && err.message.includes(wrong.current!.id));
});

test('rotation: the previous key still decrypts; previous == current collapses to one key', () => {
  const k1 = hexKey(); const k2 = hexKey();
  const e = encryptSecret('A', 'v', keyringFrom(k1, '').current!);
  assert.equal(decryptSecret('A', e, keyringFrom(k2, k1)), 'v');
  assert.equal(keyringFrom(k1, k1).previous, null);
  assert.throws(() => keyringFrom(k1, 'bad'), /ASF_SECRET_KEY_PREVIOUS/);
});

test('a truncated auth tag or a wrong-size IV is rejected before decryption (no short-tag forgery)', () => {
  const ring = keyringFrom(hexKey(), '');
  const parts = encryptSecret('A', 'v', ring.current!).split(':');
  const short = [...parts]; short[4] = Buffer.from(parts[4], 'base64').subarray(0, 4).toString('base64');
  assert.throws(() => decryptSecret('A', short.join(':'), ring), /damaged/);
  const badIv = [...parts]; badIv[3] = randomBytes(16).toString('base64');
  assert.throws(() => decryptSecret('A', badIv.join(':'), ring), /damaged/);
});
