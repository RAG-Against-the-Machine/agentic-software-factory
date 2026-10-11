import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIdentity, assertIdentityConfig } from './identity.js';

// identity.ts reads AUTH_MODE / AUTH_HEADER / API_HOST from the environment at
// call time, so a test just sets them around each call — no module cache games.
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function req(headers: Record<string, string> = {}, body?: unknown) {
  return { headers, body } as unknown as import('fastify').FastifyRequest;
}

test('none mode: identity is the claimed X-Operator header, unverified', () => {
  withEnv({ AUTH_MODE: 'none' }, () => {
    assert.deepEqual(resolveIdentity(req({ 'x-operator': 'jon' })), { user: 'jon', verified: false, mode: 'none' });
  });
});

test('none mode: falls back to body.by, then to "operator"', () => {
  withEnv({ AUTH_MODE: 'none' }, () => {
    assert.equal(resolveIdentity(req({}, { by: 'alice' })).user, 'alice');
    assert.equal(resolveIdentity(req({})).user, 'operator');
  });
});

test('header mode: trusts the proxy header and strips the IAP prefix, verified', () => {
  withEnv({ AUTH_MODE: 'header', AUTH_HEADER: 'X-Goog-Authenticated-User-Email' }, () => {
    const id = resolveIdentity(req({ 'x-goog-authenticated-user-email': 'accounts.google.com:alice@example.com' }));
    assert.deepEqual(id, { user: 'alice@example.com', verified: true, mode: 'header' });
  });
});

test('header mode: a missing header is anonymous+unverified, never a spoofable fallback', () => {
  withEnv({ AUTH_MODE: 'header', AUTH_HEADER: 'X-Goog-Authenticated-User-Email' }, () => {
    assert.deepEqual(resolveIdentity(req({ 'x-operator': 'spoofed' })), { user: 'anonymous', verified: false, mode: 'header' });
  });
});

test('assertIdentityConfig: header mode on a public bind (PORT set → 0.0.0.0) is refused at boot', () => {
  withEnv({ AUTH_MODE: 'header', PORT: '8080' }, () => {
    assert.throws(() => assertIdentityConfig(), /requires the api to sit behind a proxy/);
  });
});

test('assertIdentityConfig: header mode on loopback is allowed', () => {
  withEnv({ AUTH_MODE: 'header', PORT: undefined, API_HOST: '127.0.0.1' }, () => {
    assert.doesNotThrow(() => assertIdentityConfig());
  });
});

test('assertIdentityConfig: none mode never refuses', () => {
  withEnv({ AUTH_MODE: 'none', PORT: '8080' }, () => {
    assert.doesNotThrow(() => assertIdentityConfig());
  });
});
