import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@asf/shared';
import { api } from '../api';
import type { SettingsStore } from './q/ui';
import { checkedAgo, normaliseVersion, publishUpdateStatus } from '../updates-view';

/**
 * Settings → Updates (ADHOC-CDBC5883): this build's version, the latest release,
 * when it was last checked (or why the check failed), the daily-check switch and
 * a "Check now" button. Applying an update lives in the banner.
 */
export function UpdateSettings({ store }: { store: SettingsStore }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  useEffect(() => {
    api.updates().then(setStatus, (e) => setLoadErr(String((e as Error).message ?? e)));
  }, []);

  const setting = store.byKey.UPDATE_CHECK_ENABLED;
  const enabled = setting ? setting.value !== false : true;
  const pinned = !!setting?.envPinned;

  const toggle = async () => {
    setSaving(true); setSaveErr(null);
    const err = await store.saveMany([['UPDATE_CHECK_ENABLED', !enabled]]);
    setSaving(false);
    if (err) setSaveErr(err);
  };

  const check = async () => {
    setChecking(true); setCheckErr(null);
    try {
      const s = await api.checkUpdates();
      setStatus(s);
      publishUpdateStatus(window, s);
    } catch (e) { setCheckErr((e as Error).message); }
    setChecking(false);
  };

  return (
    <section className="tier" aria-labelledby="updates-head">
      <div className="tier-head"><h3 id="updates-head">Updates</h3></div>
      <div className="guided">
        <span>
          <span className="q-title">This version: <span className="mono">{status ? normaliseVersion(status.current) : '…'}</span></span>
          {loadErr ? <span className="bad" role="alert">Couldn’t load update status: {loadErr}</span> : status && (
            <>
              <span className="muted">
                Latest release: <span className="mono">{status.latest ? normaliseVersion(status.latest) : 'unknown'}</span>
                {status.available ? ' (update available)' : status.latest ? ' (up to date)' : ''}
              </span>
              {status.error
                ? <span className="bad">Last check failed: {status.error}</span>
                : <span className="muted">Last checked {checkedAgo(status.checkedAt)}</span>}
            </>
          )}
          {checkErr && <span className="bad" role="alert">Check failed: {checkErr}</span>}
        </span>
        <button type="button" className="btn ghost sm" disabled={checking} onClick={check}>{checking ? 'Checking…' : 'Check now'}</button>
      </div>
      <div className="guided">
        <span>
          <span className="q-title" id="updates-auto">Check for updates every day</span>
          <span className="muted">Only reads the list of published releases. Nothing is installed without you.</span>
          {pinned && <span className="muted">Set in the server’s <span className="mono">.env</span>, so it can’t be changed here.</span>}
          {saveErr && <span className="bad" role="alert">{saveErr}</span>}
        </span>
        <button type="button" role="switch" className="switch" aria-checked={enabled} aria-labelledby="updates-auto"
          disabled={pinned || saving || !setting} onClick={toggle}>
          <span className="switch-knob" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
