import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { THEME_PICTURE_STATES, THEME_SLOTS, type ThemePictureState, type ThemeSummaryWire } from '@asf/shared/ui';
import { api } from '../api';
import { useTheme } from '../useTheme';
import { defaultPictureFor, memberName } from '../theme-view';
import { stageLabel } from '../words';
import { Locked, str, type ByKey } from './q/ui';
import type { Question } from './q/questions';

/**
 * Themes in Settings (M12): the "How should the factory look?" question (a
 * picker of preview cards) and the "Crew pictures" section (the active theme's
 * five pictures, add/remove a theme).
 */

const THEMES_KEY = ['themes'];
const slotLabel = (slot: string) => (slot === 'orchestrator' ? 'Coordinator' : stageLabel(slot));
/** A member's state pictures (M13), in plain words. */
const STATE_WORDS: Record<ThemePictureState, string> = { idle: 'Idle', working: 'Working', done: 'Done' };
const STATE_WHEN: Record<ThemePictureState, string> = {
  idle: 'before its step starts', working: 'while it has the work', done: 'once its step is finished',
};

/** The file's bytes as base64 (the data: URL minus its prefix). */
export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error ?? new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

function useThemes() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: THEMES_KEY, queryFn: api.themes, staleTime: 30_000 });
  return {
    ...q,
    /** Refresh the list and the active theme everywhere in the app. */
    refresh: () => Promise.all([qc.invalidateQueries({ queryKey: THEMES_KEY }), qc.invalidateQueries({ queryKey: ['theme'] })]),
  };
}

/** One theme as a card: its crew in a row of pictures (or initials), its name and crew name. */
export function ThemeCard({ t, on, onPick, disabled }: { t: ThemeSummaryWire; on: boolean; onPick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={`choice theme-card${on ? ' on' : ''}`} disabled={disabled} onClick={onPick}>
      <span className="theme-crew" aria-hidden="true">
        {THEME_SLOTS.map((s) => {
          const url = t.images[s]?.url ?? defaultPictureFor(t.id, t.builtIn, s);
          return url
            ? <img key={s} className={`avatar${s === 'orchestrator' ? ' lead' : ''}`} src={url} alt="" />
            : <span key={s} className={`avatar-empty${s === 'orchestrator' ? ' lead' : ''}`} />;
        })}
      </span>
      <b>{t.name}{t.builtIn ? null : <em className="badge">Uploaded</em>}</b>
      <span>{t.description ?? `The crew is called ${t.crewName}.`}</span>
    </button>
  );
}

export const lookQ: Question = {
  id: 'look',
  title: 'How should the factory look?',
  why: 'Pick how the crew that works your tickets is shown on each job’s page: their names, their pictures and the little lines they say while they work.',
  summary: (b: ByKey) => <ThemeName id={str(b.THEME) || 'classic'} />,
  Body: function LookBody({ store, actions }) {
    const themes = useThemes();
    const pinned = Boolean(store.byKey.THEME?.envPinned);
    const current = themes.data?.themes.find((t) => t.active)?.id ?? 'classic';
    const [pick, setPick] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const chosen = pick ?? current;
    const save = async () => {
      if (chosen === current) return true;
      setBusy(true); setError(null);
      const res = await api.setTheme(chosen);
      setBusy(false);
      if (res.status !== 200) { setError(res.body.reason ?? `Couldn’t switch (${res.status}).`); return false; }
      await themes.refresh();
      store.reload();
      return true;
    };
    if (themes.error) return <p className="bad">Couldn’t load themes: {(themes.error as Error).message}</p>;
    if (!themes.data) return <p className="muted">Loading…</p>;
    return (
      <>
        {pinned && <Locked />}
        <div className="choices theme-cards" role="radiogroup">
          {themes.data.themes.map((t) => <ThemeCard key={t.id} t={t} on={t.id === chosen} onPick={() => setPick(t.id)} disabled={pinned} />)}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>Change the pictures, or add your own theme, under <b>Crew pictures</b> below.</p>
        {actions({ save, busy, error })}
      </>
    );
  },
};

/** The active theme's name for the collapsed row (falls back to the id until the list loads). */
function ThemeName({ id }: { id: string }) {
  const { data } = useQuery({ queryKey: THEMES_KEY, queryFn: api.themes, staleTime: 30_000 });
  const t = data?.themes.find((x) => x.active) ?? data?.themes.find((x) => x.id === id);
  return <><b>{t?.name ?? id}</b>{t && t.crewName !== 'Team' ? <> · the crew is called {t.crewName}</> : null}</>;
}

/** The theme's page decoration picture (`decor.png`): a preview and Remove, or how to add one. */
export function DecorPictureRow({ url, busy, onRemove }: { url: string | null; busy: boolean; onRemove: () => void }) {
  return (
    <div className="guided">
      <span>
        <span className="q-title">Page decoration</span>{' '}
        <span className="muted">· shown faintly in the top-right corner of every page</span>
      </span>
      {url
        ? <span className="decor-row-pic">
            <img className="decor-thumb" src={url} alt="The page decoration picture" />
            <button className="btn ghost sm" disabled={busy} onClick={onRemove}>Remove</button>
          </span>
        : <span className="muted" style={{ fontSize: 13 }}>No picture — add <span className="mono">decor.png</span> to a pictures zip</span>}
    </div>
  );
}

/**
 * Crew pictures: the active theme's five slots, each with its member's name.
 * Upload a zip of pictures (only the slots inside are replaced) or remove one.
 * Below, add a whole theme from a pack, or delete an uploaded one.
 */
export function CrewPicturesSection() {
  const themes = useThemes();
  const { theme, pictureFor, isDefaultPicture, missing, stateImages, hasStatePictures, decorImage } = useTheme();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const maxMb = themes.data?.maxMb;
  const uploaded = themes.data?.themes.filter((t) => !t.builtIn) ?? [];

  const act = async (fn: () => Promise<{ status: number; body: { reason?: string } }>, ok: (body: never) => string) => {
    setBusy(true); setMsg(null);
    try {
      const res = await fn();
      setMsg(res.status < 300 ? { ok: true, text: ok(res.body as never) } : { ok: false, text: res.body.reason ?? `That didn’t work (${res.status}).` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      await themes.refresh();
      setBusy(false);
    }
  };
  const uploadPictures = async (file: File | undefined) => file && act(
    async () => api.uploadThemePictures(theme.id, await toBase64(file)),
    (b: { replaced?: string[] }) => `Updated: ${(b.replaced ?? []).map((s) => (s === 'decor' ? 'Page decoration' : memberName(theme, s) ?? s)).join(', ')}.`,
  );
  const addTheme = async (file: File | undefined) => file && act(
    async () => api.addTheme(await toBase64(file)),
    (b: { theme?: { manifest: { name: string } }; pictures?: string[] }) =>
      `Added “${b.theme?.manifest.name}” with ${b.pictures?.length ?? 0} picture${b.pictures?.length === 1 ? '' : 's'}. Pick it under “How should the factory look?”.`,
  );
  const removeTheme = (id: string, name: string) => {
    if (!window.confirm(`Delete the theme “${name}” and its pictures?`)) return;
    void act(() => api.deleteTheme(id), () => `Deleted “${name}”.`);
  };

  return (
    <section className="tier">
      <div className="tier-head"><h3>Crew pictures</h3><span className="muted">{theme.name} · shown on each job’s page</span></div>
      {missing && <p className="warn">The theme “{missing}” no longer exists, so the factory is showing Classic. Pick a theme above.</p>}
      <div className="avatar-tiles five">
        {THEME_SLOTS.map((slot) => {
          const url = pictureFor(slot);
          const name = memberName(theme, slot) ?? slot;
          const own = hasStatePictures(slot);
          const states = stateImages[slot] ?? {};
          const count = Object.keys(states).length;
          return (
            <div className={`avatar-tile${own ? ' with-states' : ''}`} key={slot}>
              {url ? <img className={`avatar${own ? ' whole' : ''}`} src={url} alt={`${name}’s picture`} /> : <span className="avatar-empty" aria-hidden="true" />}
              <b>{name}</b>
              <span className="muted" style={{ fontSize: 12, marginTop: -6 }}>{slotLabel(slot)}</span>
              {own && (
                <div className="state-pics">
                  {THEME_PICTURE_STATES.map((st) => {
                    const ref = states[st];
                    return (
                      <span className="state-pic" key={st}>
                        {ref ? <img className="avatar whole" src={ref.url} alt={`${name}, ${STATE_WORDS[st]}`} title={`${STATE_WORDS[st]}: shown ${STATE_WHEN[st]}`} />
                          : <span className="avatar-empty" title={`No ${STATE_WORDS[st]} picture: the plain one shows`} aria-hidden="true" />}
                        <span>{STATE_WORDS[st]}</span>
                        {ref && <button className="link-btn" disabled={busy} aria-label={`Remove ${name}’s ${STATE_WORDS[st]} picture`}
                          onClick={() => void act(() => api.deleteThemePicture(theme.id, slot, st), () => `Removed ${name}’s ${STATE_WORDS[st]} picture.`)}>×</button>}
                      </span>
                    );
                  })}
                </div>
              )}
              {isDefaultPicture(slot)
                ? <span className="muted" style={{ fontSize: 13 }}>Built-in placeholder</span>
                : url
                ? <button className="btn ghost sm" disabled={busy} onClick={() => void act(() => api.deleteThemePicture(theme.id, slot), () => `Removed ${count > 1 ? `all ${count} of ${name}’s pictures` : `${name}’s picture`}.`)}>{count > 1 ? 'Remove all' : 'Remove'}</button>
                : <span className="muted" style={{ fontSize: 13 }}>No picture</span>}
            </div>
          );
        })}
      </div>
      <DecorPictureRow url={decorImage} busy={busy}
        onRemove={() => void act(() => api.deleteThemePicture(theme.id, 'decor'), () => 'Removed the page decoration picture.')} />
      <div className="avatar-upload">
        <FilePick busy={busy} label="Upload pictures…" onFile={uploadPictures} />
        <span className="muted" style={{ fontSize: 13 }}>
          A zip of pictures named after each member ({THEME_SLOTS.map((s, i) => <span key={s}>{i ? ', ' : ''}<span className="mono">{s}</span></span>)};{' '}
          <span className="mono">queen</span> works for the coordinator), as PNG, JPEG, GIF or WebP{maxMb ? `, up to ${maxMb} MB each` : ''}.
          {' '}Add <span className="mono">-idle</span>, <span className="mono">-working</span> or <span className="mono">-done</span> to the name
          (<span className="mono">planner-working.webp</span>) for a picture per state. A <span className="mono">decor.png</span> becomes the page decoration. Only the pictures in the zip are replaced.
        </span>
      </div>

      <div className="avatar-upload">
        <FilePick busy={busy} label="Add a theme…" onFile={addTheme} />
        <span className="muted" style={{ fontSize: 13 }}>
          Your own crew: names, the lines they say, a colour and pictures, in one zip.{' '}
          <a href="/api/themes/template.zip" download>Download a starter theme</a> to edit.
        </span>
      </div>
      {uploaded.length > 0 && (
        <div className="theme-list">
          {uploaded.map((t) => (
            <div className="guided" key={t.id}>
              <span><span className="q-title">{t.name}</span> <span className="muted">· {t.crewName}{t.active ? ' · in use' : ''}</span></span>
              <button className="btn ghost sm" disabled={busy || t.active} title={t.active ? 'Pick another theme first' : undefined} onClick={() => removeTheme(t.id, t.name)}>Delete</button>
            </div>
          ))}
        </div>
      )}
      {msg && <p className={msg.ok ? 'ok' : 'bad'} role="status">{msg.text}</p>}
    </section>
  );
}

function FilePick({ busy, label, onFile }: { busy: boolean; label: string; onFile: (f: File | undefined) => unknown }) {
  return (
    <label className="btn sm" aria-disabled={busy} style={busy ? { opacity: .45, cursor: 'not-allowed' } : undefined}>
      {busy ? 'Working…' : label}
      <input type="file" accept=".zip,application/zip" hidden disabled={busy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ''; }} />
    </label>
  );
}
