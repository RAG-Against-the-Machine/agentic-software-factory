import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { SetupNotice } from '../components/q/SetupNotice';
import { ESSENTIALS, LATER, QTip, type Question } from '../components/q/questions';
import { useSettingsStore, type SettingsStore } from '../components/q/ui';
import { CrewPicturesSection } from '../components/ThemeSettings';
import { UpdateSettings } from '../components/UpdateSettings';
import { SkillsSettings } from '../components/SkillsSettings';

/**
 * /settings: every question from setup, each collapsed to its current answer.
 * Click one to change it. Replaces the old Providers / Pipeline / Admin pages.
 *
 * No setting keys appear on this page. Engineers find them in each question's ⓘ,
 * and set anything (including the options this page doesn't ask about) in `.env`.
 */
export function Settings() {
  const store = useSettingsStore();
  const { hash } = useLocation();
  const [open, setOpen] = useState<string | null>(null);
  const [toast, setToast] = useState(false);

  // /settings#ai opens (and scrolls to) that question — the setup checklist links here.
  useEffect(() => {
    const id = hash.replace(/^#/, '');
    if (!id || !store.loaded) return;
    setOpen(id);
    requestAnimationFrame(() => document.getElementById(`q-${id}`)?.scrollIntoView({ block: 'start' }));
  }, [hash, store.loaded]);

  if (!store.loaded) return <div><h2>Settings</h2><p className="muted">{store.err ? `Couldn’t load settings: ${store.err}` : 'Loading…'}</p></div>;

  const saved = () => { setOpen(null); setToast(true); setTimeout(() => setToast(false), 2000); };
  const section = (title: string, sub: string | null, qs: Question[]) => (
    <section className="tier">
      <div className="tier-head"><h3>{title}</h3>{sub && <span className="muted">{sub}</span>}</div>
      {qs.map((q) => <Row key={q.id} q={q} store={store} open={open === q.id} onToggle={() => setOpen(open === q.id ? null : q.id)} onSaved={saved} />)}
    </section>
  );

  return (
    <div className="settings-page">
      <h2>Settings</h2>
      <p className="muted" style={{ marginTop: 0 }}>Your answers from setup. Click one to change it. Changes apply to the next ticket.</p>
      <SetupNotice />

      {section('The essentials', null, ESSENTIALS)}
      {section('When you’re ready', 'Good defaults are already set', LATER)}

      <CrewPicturesSection />

      <UpdateSettings store={store} />

      <SkillsSettings />

      <section className="tier">
        <div className="tier-head"><h3>Guided setup</h3></div>
        <div className="guided">
          <span>
            <span className="q-title">Want the walkthrough again?</span>
            <span className="muted">Goes through the essentials one screen at a time, starting from your current answers. Nothing changes until you save a step.</span>
          </span>
          <Link className="btn ghost sm" to="/setup">Run setup</Link>
        </div>
      </section>

      <div className="helpbox">
        <b>Running this for your team?</b> Everything here can also be set in the server’s <span className="mono">.env</span>, and a value set there wins.
        Hover the <span className="tip-inline">i</span> next to a question to see its names. Server options that aren’t asked here (timeouts, retention,
        advanced Jira scoping, Vertex AI, Bedrock) are <span className="mono">.env</span>-only; see <span className="mono">docs/CONFIGURATION.md</span>.
      </div>
      <div className={`toast${toast ? ' on' : ''}`} role="status">Saved. Applies to the next ticket.</div>
    </div>
  );
}

function Row({ q, store, open, onToggle, onSaved }: { q: Question; store: SettingsStore; open: boolean; onToggle: () => void; onSaved: () => void }) {
  const attn = q.attention?.(store.byKey);
  return (
    <div className={`q${open ? ' open' : ''}${attn ? ' attn' : ''}`} id={`q-${q.id}`}>
      <button type="button" className="q-sum" aria-expanded={open} onClick={onToggle}>
        <span>
          <span className="q-title">{q.title}<QTip id={q.id} byKey={store.byKey} note={q.tipNote} /></span>
          <span className="ans">{q.summary(store.byKey)}</span>
        </span>
        <span className="edit">{open ? '' : 'Change'}</span>
      </button>
      {open && (
        <div className="q-body">
          <p className="why">{q.why}</p>
          {/* key = remount on open so the draft starts from the saved answer */}
          <q.Body store={store} actions={({ save, busy, error }) => (
            <>
              {error && <div className="bad" style={{ marginTop: 12 }}>{error}</div>}
              <div className="row" style={{ marginTop: 16 }}>
                <button className="btn sm" disabled={busy} onClick={async () => { if (await save()) onSaved(); }}>{busy ? 'Saving…' : 'Save'}</button>
                <button className="btn ghost sm" onClick={onToggle}>Cancel</button>
              </div>
            </>
          )} />
        </div>
      )}
    </div>
  );
}
