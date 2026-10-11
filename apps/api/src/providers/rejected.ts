import type { Preflight } from '@asf/shared';

/** The HTTP status in a provider error ("GitHub GET /user → 401: …"), or 0. */
export function httpStatusOf(err: unknown): number {
  return Number(/→ (\d{3}):/.exec((err as Error)?.message ?? '')?.[1] ?? 0);
}

/**
 * The plain failure for a token the service refused (401). One wording for every
 * provider and both roles (tracker + code host), so a single dead GitHub token
 * reads as one problem, not two, and never as a raw JSON body.
 */
export function credentialRejected(service: string): Extract<Preflight, { ok: false }> {
  return {
    ok: false,
    credentialRejected: true,
    reason: `${service} rejected the saved access token (401). It was revoked, has expired, or was mistyped: create a new one and paste it in Settings.`,
  };
}

/** A failed preflight from a caught error: the plain 401 message, else the raw detail. */
export function preflightFailure(service: string, err: unknown): Extract<Preflight, { ok: false }> {
  return httpStatusOf(err) === 401 ? credentialRejected(service) : { ok: false, reason: (err as Error).message };
}
