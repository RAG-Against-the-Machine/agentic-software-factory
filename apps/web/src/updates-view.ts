import type { UpdateStatus } from '@asf/shared';

/**
 * Pure helpers for the Updates banner and the Settings → Updates section
 * (ADHOC-CDBC5883). No React, no DOM: storage is injected so tests can fake it.
 */

/** "1.2.0" → "v1.2.0"; "v1.2.0" and "dev" stay as they are. */
export function normaliseVersion(v: string): string {
  const t = v.trim();
  return /^\d/.test(t) ? `v${t}` : t;
}

/** "v1.2.0 → v1.3.0"; just the current version when no latest is known. */
export function versionLabel(current: string, latest: string | null): string {
  const cur = normaliseVersion(current);
  return latest ? `${cur} → ${normaliseVersion(latest)}` : cur;
}

/** Shown while an update is available and the operator hasn't dismissed this very version. */
export function bannerVisible(status: UpdateStatus | null | undefined, dismissedVersion: string | null): boolean {
  if (!status?.available || !status.latest) return false;
  return dismissedVersion === null || normaliseVersion(dismissedVersion) !== normaliseVersion(status.latest);
}

/** The minimal Storage surface we use (localStorage satisfies it). */
export interface KeyValueStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

export const dismissKey = 'asf.updates.dismissed';

/** The version the banner was dismissed for, or null. Never throws (storage may be blocked). */
export function readDismissed(store: KeyValueStore | null | undefined): string | null {
  try { return store?.getItem(dismissKey) ?? null; } catch { return null; }
}

export function writeDismissed(store: KeyValueStore | null | undefined, version: string): void {
  try { store?.setItem(dismissKey, version); } catch { /* private mode: dismissal lasts this page only */ }
}

/** Forget the dismissed version, so the banner shows again. Never throws. */
export function clearDismissed(store: { removeItem(key: string): void } | null | undefined): void {
  try { store?.removeItem(dismissKey); } catch { /* blocked storage: nothing stored to clear */ }
}

/**
 * Settings → "Check now" tells the banner about a fresh status, so it shows without a
 * reload. The target is injected (window in the app) so tests can use a plain EventTarget.
 */
export const updateStatusEvent = 'asf:update-status';

export function publishUpdateStatus(target: EventTarget, status: UpdateStatus): void {
  target.dispatchEvent(new CustomEvent<UpdateStatus>(updateStatusEvent, { detail: status }));
}

/** Calls cb with every published status; returns the unsubscribe. */
export function onUpdateStatus(target: EventTarget, cb: (status: UpdateStatus) => void): () => void {
  const handler = (e: Event) => cb((e as CustomEvent<UpdateStatus>).detail);
  target.addEventListener(updateStatusEvent, handler);
  return () => target.removeEventListener(updateStatusEvent, handler);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; "never" without a time. */
export function checkedAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** After an apply: the restart is done once the app reports a different version than before. */
export function restartDone(prevVersion: string, status: UpdateStatus | null | undefined): boolean {
  return !!status && normaliseVersion(status.current) !== normaliseVersion(prevVersion);
}
