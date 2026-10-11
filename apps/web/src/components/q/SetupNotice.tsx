import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type SetupItem } from '../../api';

/** Plain-language names for the required setup items that can be missing. */
const NEED: Record<string, string> = {
  ticket: 'a real work tracker',
  scm: 'a real code host',
  'agent-auth': 'an AI sign-in',
  worker: 'a worker online',
};

/** "a, b and c" */
const join = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The configuration items still missing: required, not done, and fixable through setup. */
export function missingSetup(items: SetupItem[]): string[] {
  return items.filter((i) => !i.optional && !i.done && NEED[i.id]).map((i) => NEED[i.id]);
}

export interface NoticeContent { title: string; detail: string; action: string; to: string }

/**
 * What the notice says. A provider that IS configured but failing its check (a
 * revoked token, a renamed repo) is a broken connection, not unfinished setup, so
 * it gets its own words: the provider's reason, said once even when one dead
 * token breaks both the tracker and the code host, and a link straight to the
 * panel that fixes it. Anything else still missing is listed after it.
 */
export function noticeContent(items: SetupItem[]): NoticeContent | null {
  const required = items.filter((i) => !i.optional && !i.done && NEED[i.id]);
  if (required.length === 0) return null;
  const broken = required.filter((i) => i.problem);
  if (broken.length === 0) {
    return { title: 'Setup isn’t finished', detail: `Still needed: ${join(required.map((i) => NEED[i.id]))}.`, action: 'Continue setup', to: '/setup' };
  }
  const reasons = [...new Set(broken.map((i) => (i.reason ?? '').trim()).filter(Boolean))];
  const rest = required.filter((i) => !i.problem).map((i) => NEED[i.id]);
  const rejected = broken.some((i) => i.problem === 'credential-rejected');
  const what = join(broken.map((i) => (i.id === 'ticket' ? 'work tracker' : i.id === 'scm' ? 'code host' : i.title.toLowerCase())));
  const detail = [reasons.join(' '), rest.length ? `Also still needed: ${join(rest)}.` : ''].filter(Boolean).join(' ');
  return {
    title: rejected
      ? `Saved token rejected: your ${what} ${broken.length > 1 ? 'are' : 'is'} disconnected`
      : `Your ${what} ${broken.length > 1 ? 'aren’t' : 'isn’t'} connected`,
    detail,
    action: 'Fix in Settings',
    to: broken[0].link,
  };
}

/**
 * Shown at the top of New task and Settings while setup is unfinished or a
 * connection is broken, and gone once neither is true. Setup has no nav item, so
 * this is the way back to it for anyone who left the wizard with "I'll do this
 * later". The first successful run is not a setup step, so it never triggers this.
 */
export function SetupNotice() {
  const { data } = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus, staleTime: 30_000 });
  const c = data ? noticeContent(data.items) : null;
  if (!c) return null;
  return (
    <div className="notice" role="status">
      <span>
        <b>{c.title}</b>
        <span className="muted small">{c.detail}</span>
      </span>
      <Link className="btn sm" to={c.to}>{c.action}</Link>
    </div>
  );
}
