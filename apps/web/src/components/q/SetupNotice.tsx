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

/**
 * Shown at the top of New task and Settings while setup is unfinished, and gone once it
 * isn't. Setup has no nav item, so this is the way back to it for anyone who left the
 * wizard with "I'll do this later". The first successful run is not a setup step,
 * so it never triggers this notice.
 */
export function SetupNotice() {
  const { data } = useQuery({ queryKey: ['setup-status'], queryFn: api.setupStatus, staleTime: 30_000 });
  const missing = data ? missingSetup(data.items) : [];
  if (missing.length === 0) return null;
  return (
    <div className="notice" role="status">
      <span>
        <b>Setup isn’t finished</b>
        <span className="muted small">Still needed: {join(missing)}.</span>
      </span>
      <Link className="btn sm" to="/setup">Continue setup</Link>
    </div>
  );
}
