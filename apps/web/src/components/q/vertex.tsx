import { useEffect, useRef, useState } from 'react';
import { VERTEX_CANDIDATES, VERTEX_DEFAULT_REGION, isGcpProjectId, isVertexRegion, type VertexCheckResult, type VertexCheckState } from '@asf/shared/ui';
import { api } from '../../api';
import { Field, HowTo, type ByKey, str } from './ui';

/**
 * Claude on Google Cloud (Vertex AI), the answer to "Which AI should do the
 * work?" (M9). The user types a project id and a region; "Check which Claude
 * models work" has a worker (the only place with the Google login) try every
 * candidate model. The ones that answer are pre-ticked, and Save stores exactly
 * those as the factory's model list. Nothing about the company's own setup
 * script is assumed: this screen collects everything Vertex needs.
 */

export interface VertexDraft {
  projectId: string;
  region: string;
  /** Model ids the user wants the factory to use (ticked, and passed the check). */
  selected: string[];
  /** The check this draft was verified by, for the project + region on screen. */
  checked: { projectId: string; region: string; result: VertexCheckResult } | null;
}

export function initialVertexDraft(b: ByKey): VertexDraft {
  return {
    projectId: str(b.ANTHROPIC_VERTEX_PROJECT_ID),
    region: str(b.CLOUD_ML_REGION) || VERTEX_DEFAULT_REGION,
    selected: str(b.MODEL_ALLOWLIST).split(/[\s,]+/).filter(Boolean),
    checked: null,
  };
}

/** Why the draft can't be saved yet, or null. `savedOk` = this exact project/region is already saved as vertex. */
export function vertexDraftProblem(d: VertexDraft, savedOk: boolean): string | null {
  const p = d.projectId.trim(); const r = d.region.trim();
  if (!p) return 'Type your Google Cloud project id.';
  if (!isGcpProjectId(p)) return `“${p}” isn’t a project id. It’s lowercase letters, digits and hyphens, like my-team-ai.`;
  if (!isVertexRegion(r)) return 'Use region global, or one such as us-east5.';
  const fresh = d.checked && d.checked.projectId === p && d.checked.region === r;
  if (!fresh && !savedOk) return 'Press “Check which Claude models work” first, so the factory only uses models that answer.';
  if (fresh && !d.checked!.result.claudeCode.ok) return 'The check didn’t pass yet. Fix what it says, then check again.';
  if (!d.selected.length) return 'Tick at least one model.';
  return null;
}

const DOT = { ok: '✓', bad: '✗' };

export function VertexSetup({ b, draft, setDraft }: { b: ByKey; draft: VertexDraft; setDraft: (f: (d: VertexDraft) => VertexDraft) => void }) {
  const [extra, setExtra] = useState('');
  const [custom, setCustom] = useState<string[]>(() => draft.selected.filter((id) => !VERTEX_CANDIDATES.some((c) => c.id === id)));
  const [state, setState] = useState<VertexCheckState | { state: 'starting' } | { state: 'error'; reason: string } | null>(null);
  const [waited, setWaited] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const candidates = [...VERTEX_CANDIDATES.map((c) => c.id), ...custom];
  const result = draft.checked && draft.checked.projectId === draft.projectId.trim() && draft.checked.region === draft.region.trim() ? draft.checked.result : null;
  const busy = state?.state === 'starting' || state?.state === 'queued' || state?.state === 'running';

  const check = async () => {
    const projectId = draft.projectId.trim(); const region = draft.region.trim() || VERTEX_DEFAULT_REGION;
    if (!isGcpProjectId(projectId)) return setState({ state: 'error', reason: projectId ? `“${projectId}” isn’t a project id. It’s lowercase letters, digits and hyphens, like my-team-ai (not the project’s display name).` : 'Type your Google Cloud project id first.' });
    setState({ state: 'starting' }); setWaited(0);
    const started = await api.vertexCheckStart({ projectId, region, models: candidates });
    if (started.status !== 200) return setState({ state: 'error', reason: started.body.reason ?? `The check couldn’t start (${started.status}).` });
    const id = started.body.id;
    const t0 = Date.now();
    const poll = async () => {
      const s = await api.vertexCheck(id).catch((e) => ({ state: 'error' as const, reason: String(e) }));
      setWaited(Math.round((Date.now() - t0) / 1000));
      if (s.state === 'done') {
        setState(s);
        setDraft((d) => ({ ...d, checked: { projectId, region, result: s.result }, selected: s.result.models.filter((m) => m.ok).map((m) => m.id) }));
        return;
      }
      setState(s);
      if (s.state !== 'error') timer.current = setTimeout(() => { void poll(); }, 2000);
    };
    await poll();
  };

  const toggle = (id: string) => setDraft((d) => ({ ...d, selected: d.selected.includes(id) ? d.selected.filter((x) => x !== id) : [...d.selected, id] }));
  const addCustom = () => {
    const id = extra.trim();
    if (!id || candidates.includes(id)) return setExtra('');
    setCustom((c) => [...c, id]); setExtra('');
  };

  return (
    <div className="vertex">
      <HowTo open={!str(b.ANTHROPIC_VERTEX_PROJECT_ID)} steps={[
        <>Your company’s Google Cloud project must have Claude turned on in <b>Vertex AI → Model Garden</b>, and your Google account needs the <b>Vertex AI User</b> role on it. Your Google Cloud admin can confirm both.</>,
        <>On the computer running the factory, install the <a href="https://cloud.google.com/sdk/docs/install" target="_blank" rel="noreferrer">Google Cloud CLI</a>.</>,
        <>In a terminal there, run <span className="mono">gcloud auth application-default login</span> and sign in with your work Google account in the browser that opens.</>,
        <>Find the project id (not its display name): run <span className="mono">gcloud projects list</span>, or ask your admin. Type it below.</>,
      ]} />
      <Field s={b.ANTHROPIC_VERTEX_PROJECT_ID} label="Google Cloud project id" placeholder="e.g. my-team-ai" value={draft.projectId}
        onChange={(v) => setDraft((d) => ({ ...d, projectId: v.trim().toLowerCase() }))} />
      <Field s={b.CLOUD_ML_REGION} label="Region" placeholder="global" value={draft.region} width={180}
        onChange={(v) => setDraft((d) => ({ ...d, region: v.trim().toLowerCase() }))}
        help="Leave as global unless your admin says your Claude models live in one region (such as us-east5)." />

      <div className="row" style={{ marginTop: 14, flexWrap: 'wrap', gap: 10 }}>
        <button type="button" className="btn ghost sm" onClick={() => { void check(); }} disabled={busy}>Check which Claude models work</button>
        {busy && <span className="spinner" />}
        {busy && <span className="muted small">{state?.state === 'running'
          ? `Checking on worker ${(state as { worker?: string }).worker ?? ''}… (about 30 seconds)`
          : waited > 15 ? 'Still waiting for a worker to pick this up. Is the factory running? (scripts/asf status)' : 'Waiting for a worker…'}</span>}
        {state?.state === 'error' && <span className="bad">{DOT.bad} {state.reason}</span>}
      </div>

      {result && <VertexResult result={result} selected={draft.selected} toggle={toggle} />}

      <details className="howto" style={{ marginTop: 10 }}>
        <summary>Use a model id that isn’t listed</summary>
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <input value={extra} placeholder="e.g. claude-sonnet-4-6[1m]" onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(); } }} />
          <button type="button" className="btn ghost sm" onClick={addCustom}>Add</button>
        </div>
        <p className="muted small">Then check again. Add <span className="mono">[1m]</span> to a model id for its 1-million-token context, if your project allows it.{custom.length > 0 && <> Added: {custom.join(', ')}</>}</p>
      </details>
    </div>
  );
}

function VertexResult({ result, selected, toggle }: { result: VertexCheckResult; selected: string[]; toggle: (id: string) => void }) {
  const l = result.login;
  return (
    <div className="vertex-result" style={{ marginTop: 12 }}>
      <p className={l.ok ? 'ok' : 'bad'}>
        {l.ok ? DOT.ok : DOT.bad} {l.ok ? <>Signed in to Google{l.account ? <> as <b>{l.account}</b></> : null}{result.worker ? <> (on worker {result.worker})</> : null}</> : l.reason}
      </p>
      {result.models.length > 0 && (
        <ul className="plain" style={{ listStyle: 'none', paddingLeft: 0, margin: '6px 0' }}>
          {result.models.map((m) => (
            <li key={m.id}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'baseline', opacity: m.ok ? 1 : 0.7 }}>
                <input type="checkbox" disabled={!m.ok} checked={m.ok && selected.includes(m.id)} onChange={() => toggle(m.id)} />
                <span className={m.ok ? 'ok' : 'bad'}>{m.ok ? DOT.ok : DOT.bad}</span>
                <span className="mono">{m.id}</span>
                <span className="muted small">{m.ok ? (m.reason ?? 'works') : m.reason}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {!result.claudeCode.skipped && (
        <p className={result.claudeCode.ok ? 'ok' : 'bad'}>
          {result.claudeCode.ok ? DOT.ok : DOT.bad} {result.claudeCode.ok ? <>Claude Code ran on <span className="mono">{result.claudeCode.model}</span>. The factory is ready to use these models.</> : result.claudeCode.reason}
        </p>
      )}
      {result.ok && <p className="muted small">Ticked models become the factory’s model list. Each job uses the strongest ticked model of its kind; change that under <b>Which AI model does each job?</b></p>}
    </div>
  );
}
