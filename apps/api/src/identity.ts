import type { FastifyRequest } from 'fastify';
import { resolve } from '@asf/shared';

/**
 * Who is making this request (WP 7.3). Two modes, declared by AUTH_MODE:
 *
 *   none    single-operator MVP. Identity is whatever the client claims (a name
 *           box → X-Operator header, or the `by` in a body); the badge says
 *           unverified because nothing checked it.
 *   header  an upstream proxy (Google IAP, Tailscale serve, an SSO gateway) has
 *           already authenticated the user and set AUTH_HEADER. We trust it —
 *           but only when the api is NOT directly reachable, i.e. it binds
 *           loopback/VPC and the proxy is the only way in. Binding 0.0.0.0 with
 *           header mode would let anyone spoof the header, so that combination
 *           is refused at boot (assertIdentityConfig).
 *
 * IAP sets X-Goog-Authenticated-User-Email to `accounts.google.com:alice@x.com`;
 * we return the bare address.
 *
 * These read the catalogue (env) at call time rather than a load-time snapshot,
 * which keeps the module free of import-order coupling and directly testable.
 */
export interface Identity { user: string; verified: boolean; mode: string }

function authMode(): string { return resolve('AUTH_MODE'); }
function authHeader(): string { return resolve('AUTH_HEADER'); }
function apiHost(): string { return process.env.PORT ? '0.0.0.0' : resolve('API_HOST'); }

export function resolveIdentity(req: FastifyRequest): Identity {
  if (authMode() === 'header') {
    const raw = req.headers[authHeader().toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) {
      const user = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : value;
      return { user, verified: true, mode: 'header' };
    }
    // header mode but the proxy sent nothing — do not silently fall back to a
    // spoofable identity; report anonymous+unverified so the UI can say so.
    return { user: 'anonymous', verified: false, mode: 'header' };
  }
  const hdr = req.headers['x-operator'];
  const claimed = (Array.isArray(hdr) ? hdr[0] : hdr) ?? (req.body as { by?: string } | undefined)?.by ?? 'operator';
  return { user: claimed, verified: false, mode: 'none' };
}

/**
 * Boot-time guard: header mode is only safe behind a proxy, i.e. when the api
 * binds a private address. Refuse header + a public bind so a header cannot be
 * spoofed by a direct caller.
 */
export function assertIdentityConfig(): void {
  if (authMode() === 'header') {
    const host = apiHost();
    if (host === '0.0.0.0') {
      throw new Error(
        `AUTH_MODE=header requires the api to sit behind a proxy, but the api binds ${host} (publicly reachable). ` +
        'Bind loopback/VPC and let the proxy (IAP/Tailscale/SSO) reach it, or use AUTH_MODE=none.',
      );
    }
  }
}
