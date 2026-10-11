import { Link } from 'react-router-dom';
import type { SplitFamilyWire } from '@asf/shared/ui';
import { partStatus, splitProgress } from '../split-view';

/**
 * The parts a run was split into, with where each one is and a link to its run.
 * On the parent run this replaces the confusing "skipped" team; on a part's run it
 * says which part this is and links back to the whole split.
 */
export function SplitCard({ family, runId }: { family: SplitFamilyWire; runId: string }) {
  const onParent = family.parent.runId === runId;
  const n = family.parts.length;
  return (
    <div className="card split-family">
      <div className="row between">
        <b>{onParent
          ? `Split into ${n} tasks`
          : `Part ${family.currentPart ?? '?'} of ${n} of `}{!onParent && <Link to={`/run/${family.parent.runId}`} className="mono">{family.parent.ticketKey}</Link>}</b>
        <span className="muted">{splitProgress(family)}</span>
      </div>
      <div className="muted" style={{ fontSize: 13, margin: '4px 0 8px' }}>
        {onParent
          ? 'This job was too big for one pull request, so the planner divided it. The team does the work in these tasks, not here: each one gets its own plan, pull request and review, and starts once the tasks it depends on are merged.'
          : `${family.parent.title}: the planner divided it into ${n} tasks. This is one of them.`}
      </div>
      <ol className="split-family-parts">
        {family.parts.map((p) => {
          const st = partStatus(p);
          const current = !onParent && p.part === family.currentPart;
          return (
            <li key={p.ticketId} className={current ? 'current' : undefined}>
              <span className={`dot split-${st.tone}`} />
              <span className="split-part-title">
                {p.run && !current
                  ? <Link to={`/run/${p.run.id}`}>{p.title}</Link>
                  : <span>{p.title}</span>}
                {current && <span className="muted"> (this task)</span>}
                <span className="mono muted" style={{ fontSize: 11 }}> {p.key}</span>
              </span>
              <span className={`split-status split-${st.tone}`}>{st.label}</span>
              {p.run?.changeRequestUrl && <a href={p.run.changeRequestUrl} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 12 }}>PR ↗</a>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
