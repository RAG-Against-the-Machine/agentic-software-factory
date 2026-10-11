import {
  CLASSIC_THEME, THEME_DECOR_PATTERNS, fillLine, isThemeSlot, pickLine,
  type ThemeDecorPattern, type ThemeManifest, type ThemeMood, type ThemeSlot,
} from '@asf/shared/ui';
import { stageLabel } from './words';

/**
 * How the active theme turns into words on screen (M12). Pure: no React, no DOM.
 * Every helper falls back to the classic theme, so a theme that leaves something
 * out (or a role that is not one of the five slots) still reads sensibly.
 */

/** The crew's name in place of "Team" ("The Hive"). */
export const crewName = (m: ThemeManifest): string => m.crew.name;

/** The member's name for a role, or null for anything that is not a theme slot (e.g. `publish:push`). */
export function memberName(m: ThemeManifest, role: string): string | null {
  return isThemeSlot(role) ? m.members[role].name : null;
}

/**
 * A lane's label. Where the member's name is just classic's name for that slot,
 * the label is the plain stage ("Write code", exactly as before). Otherwise the
 * name comes first so people see who is working: "Builder · Write code".
 */
export function laneLabel(m: ThemeManifest, role: string): string {
  const name = memberName(m, role);
  const stage = stageLabel(role);
  if (!name || !isThemeSlot(role) || name === CLASSIC_THEME.members[role].name) return stage;
  return `${name} · ${stage}`;
}

/** The rotating "what is it up to" line for `role` at `tick` (e.g. seconds / 6). */
export function quipFor(m: ThemeManifest, role: string, tick: number): string {
  const slot: ThemeSlot = isThemeSlot(role) ? role : 'orchestrator';
  const list = m.quips?.[slot]?.length ? m.quips[slot]! : CLASSIC_THEME.quips![slot]!;
  return pickLine(list, tick);
}

/** A stage-line caption for a mood, placeholders filled in, plain text. */
export function moodLine(m: ThemeManifest, mood: ThemeMood, vars: { member?: string; ticket?: string }, tick = 0): string {
  const list = m.moods?.[mood]?.length ? m.moods[mood]! : CLASSIC_THEME.moods![mood]!;
  return fillLine(pickLine(list, tick), { orchestrator: m.members.orchestrator.name, crew: m.crew.name, ...vars });
}

/**
 * The theme's accent colour, or null to keep the app's own. Re-checked here
 * because it lands in a style attribute: only `#rrggbb` gets through.
 */
export function accentOf(m: ThemeManifest): string | null {
  return m.accent && /^#[0-9a-fA-F]{6}$/.test(m.accent) ? m.accent : null;
}

/** The product name to show (sidebar, browser tab). Falls back to classic's. */
export function appTitleOf(m: ThemeManifest): string {
  return m.appTitle?.trim() || CLASSIC_THEME.appTitle!;
}

/** Short initials of the product name for the mobile top bar: "ASF", "THM". */
export function appInitialsOf(m: ThemeManifest): string {
  return appTitleOf(m).split(/\s+/).map((w) => w[0]).join('').slice(0, 4).toUpperCase();
}

const hexOrNull = (v: string | undefined): string | null => (v && /^#[0-9a-fA-F]{6}$/.test(v) ? v : null);

/** The theme's page background, or null to keep the app's own. Re-checked like the accent. */
export const backgroundOf = (m: ThemeManifest): string | null => hexOrNull(m.background);

/** The theme's text colour, or null to keep the app's own. Re-checked like the accent. */
export const textOf = (m: ThemeManifest): string | null => hexOrNull(m.text);

/**
 * The placeholder picture a member shows when it has none of its own: only the
 * built-in classic theme has them (web assets under /themes/classic/). An
 * uploaded theme that reuses the id `classic` can't exist, but `builtIn` is
 * checked anyway so nothing else ever picks them up.
 */
export function defaultPictureFor(themeId: string, builtIn: boolean, slot: string): string | null {
  return builtIn && themeId === CLASSIC_THEME.id && isThemeSlot(slot) ? `/themes/classic/${slot}.svg` : null;
}

/** The theme's corner pattern, or null for none. Re-checked like the accent: only a known pattern gets through. */
export function decorOf(m: ThemeManifest): ThemeDecorPattern | null {
  const d: unknown = m.decor;
  return typeof d === 'string' && (THEME_DECOR_PATTERNS as readonly string[]).includes(d) ? (d as ThemeDecorPattern) : null;
}
