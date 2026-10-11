import { useEffect, useState } from 'react';
import { api, type Identity } from './api';

/**
 * Who the operator is, per the server (WP 7.3). AUTH_MODE=none → whatever the
 * client claims, unverified; AUTH_MODE=header → the proxy-authenticated user,
 * verified. Fetched once and shared; components read `me.user` instead of the
 * old hardcoded 'operator' string so a gate decision or dispatch is attributed.
 */
let cache: Identity | null = null;
let inflight: Promise<Identity> | null = null;

export function useMe(): Identity {
  const [me, setMe] = useState<Identity>(cache ?? { user: 'operator', verified: false, mode: 'none' });
  useEffect(() => {
    if (cache) { setMe(cache); return; }
    inflight ??= api.me().then((m) => { cache = m; return m; });
    let alive = true;
    inflight.then((m) => { if (alive) setMe(m); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return me;
}
