import { z } from 'zod';

/**
 * Themes (M12): how the agent crew looks and talks. A theme is text only (names,
 * quips, mood lines, an accent colour) plus one picture per slot. The orchestrator
 * is a crew member too, so a run reads as a crew handing work to one another.
 *
 * Browser-safe (exported from `@asf/shared/ui`); the zip reader for theme packs is
 * node-only and lives in theme-pack.ts.
 *
 * Every string here is rendered as React text, never as HTML, and the only style
 * inputs are strict hex colours (accent, background, text), so an uploaded theme
 * cannot inject markup or CSS.
 */
export const THEME_SLOTS = ['orchestrator', 'planner', 'implementer', 'tester', 'reviewer'] as const;
export type ThemeSlot = (typeof THEME_SLOTS)[number];
export const isThemeSlot = (s: string): s is ThemeSlot => (THEME_SLOTS as readonly string[]).includes(s);
/** The slots that are agent roles (everything but the orchestrator). */
export const THEME_ROLE_SLOTS = THEME_SLOTS.filter((s) => s !== 'orchestrator') as Exclude<ThemeSlot, 'orchestrator'>[];

/** What the crew is doing right now, as the run page's stage line describes it. */
export const THEME_MOODS = ['handoff', 'working', 'gate', 'question', 'conflict', 'delivering', 'delivered', 'failed', 'idle'] as const;
export type ThemeMood = (typeof THEME_MOODS)[number];

/** The placeholders a quip or mood line may use. Anything else is left as typed. */
export const THEME_PLACEHOLDERS = ['orchestrator', 'member', 'crew', 'ticket'] as const;
export type ThemePlaceholder = (typeof THEME_PLACEHOLDERS)[number];

/** Built-in corner patterns a theme may ask for. The web draws them; a theme only names one. */
export const THEME_DECOR_PATTERNS = ['honeycomb'] as const;
export type ThemeDecorPattern = (typeof THEME_DECOR_PATTERNS)[number];

export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
const text = (max: number) => z.string().trim().min(1).max(max);
const lines = (maxItems: number) => z.array(text(120)).min(1).max(maxItems);
const member = z.object({ name: text(40) }).strict();
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const hex = (example: string) => z.string().regex(HEX_RE, `use a hex colour like ${example}`);

/** The app's own dark colours, used for whichever of background/text a theme leaves out. */
export const DEFAULT_THEME_BACKGROUND = '#0f1115';
export const DEFAULT_THEME_TEXT = '#e6e8ec';
/** The least text/background contrast a theme may set (WCAG AA for body text). */
export const MIN_THEME_CONTRAST = 4.5;

function luminance(hexColour: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hexColour.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours, from 1 (same) to 21 (black on white). */
export function contrastRatio(hexA: string, hexB: string): number {
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

function partialRecord<K extends string, V extends z.ZodTypeAny>(keys: readonly [K, ...K[]], value: V) {
  return z.object(Object.fromEntries(keys.map((k) => [k, value.optional()])) as Record<K, z.ZodOptional<V>>).strict();
}

export const themeManifestSchema = z.object({
  id: z.string().regex(THEME_ID_RE, 'use 2–32 lower-case letters, digits or dashes'),
  name: text(40),
  description: text(200).optional(),
  crew: z.object({ name: text(40) }).strict(),
  members: z.object({
    orchestrator: member,
    planner: member,
    implementer: member,
    tester: member,
    reviewer: member,
  }).strict(),
  /** Rotating "what is it up to" lines per slot. A slot without its own falls back to the classic quips. */
  quips: partialRecord(THEME_SLOTS, lines(12)).optional(),
  /** Stage-line captions per mood. A mood without its own falls back to the classic lines. */
  moods: partialRecord(THEME_MOODS, lines(8)).optional(),
  accent: hex('#e0a526').optional(),
  /** A short emoji or symbol that travels from the orchestrator to whoever takes the work. */
  handoffGlyph: z.string().trim().min(1).max(8).optional(),
  /** The product name shown in the UI (sidebar, browser tab). Without one the classic name is used. */
  appTitle: text(40).optional(),
  /** Page background and text colours. Either may be left out; the app's own dark colour fills in. */
  background: hex('#1a140c').optional(),
  text: hex('#f3e9d2').optional(),
  /** A built-in pattern drawn faintly in the page corner in the accent colour. Only the names in THEME_DECOR_PATTERNS. */
  decor: z.enum(THEME_DECOR_PATTERNS).optional(),
}).strict().superRefine((m, ctx) => {
  if (!m.background && !m.text) return;
  const bg = m.background ?? DEFAULT_THEME_BACKGROUND;
  const fg = m.text ?? DEFAULT_THEME_TEXT;
  if (!HEX_RE.test(bg) || !HEX_RE.test(fg)) return; // the field's own error already says why
  const ratio = contrastRatio(bg, fg);
  if (ratio < MIN_THEME_CONTRAST) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [m.text ? 'text' : 'background'],
      message: `text ${fg} on background ${bg} has contrast ${ratio.toFixed(2)}:1; it needs at least ${MIN_THEME_CONTRAST}:1 to be readable`,
    });
  }
});
export type ThemeManifest = z.infer<typeof themeManifestSchema>;

/**
 * Fill `{orchestrator}`, `{member}`, `{crew}` and `{ticket}` in a line. Unknown or
 * unfilled placeholders are left exactly as written; the result is plain text.
 */
export function fillLine(line: string, vars: Partial<Record<ThemePlaceholder, string>>): string {
  return line.replace(/\{([a-z]+)\}/g, (whole, key: string) => {
    const v = (THEME_PLACEHOLDERS as readonly string[]).includes(key) ? vars[key as ThemePlaceholder] : undefined;
    return v ?? whole;
  });
}

// --- wire (registry ⇄ api ⇄ web) ---

export const THEME_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

/**
 * Crew picture states (M13). A member can have a picture per state: `idle` (not
 * started yet), `working` (has the work), `done` (finished). `any` is the plain
 * picture, which covers every state that has no picture of its own.
 */
export const THEME_PICTURE_STATES = ['idle', 'working', 'done'] as const;
export type ThemePictureState = (typeof THEME_PICTURE_STATES)[number];
export const THEME_IMAGE_STATES = ['any', ...THEME_PICTURE_STATES] as const;
export type ThemeImageState = (typeof THEME_IMAGE_STATES)[number];
export const isThemePictureState = (s: string): s is ThemePictureState => (THEME_PICTURE_STATES as readonly string[]).includes(s);

/**
 * The decor picture: one picture for the whole theme, not a crew member. It has
 * no states, so it is only ever stored with the state `any`. Crew code (THEME_SLOTS)
 * never sees it.
 */
export const THEME_DECOR_SLOT = 'decor' as const;
/** Every slot a stored picture can have: the crew members plus decor. */
export const THEME_IMAGE_SLOTS = [...THEME_SLOTS, THEME_DECOR_SLOT] as const;
export type ThemeImageSlot = (typeof THEME_IMAGE_SLOTS)[number];
export const isThemeImageSlot = (s: string): s is ThemeImageSlot => (THEME_IMAGE_SLOTS as readonly string[]).includes(s);

/** The most pictures one theme can hold: every member, every state, plus the plain one, plus decor. */
export const THEME_MAX_PICTURES = THEME_SLOTS.length * THEME_IMAGE_STATES.length + 1;

export const themeImageInputSchema = z.object({
  slot: z.enum(THEME_IMAGE_SLOTS),
  /** Left out means `any`, the plain picture (every M12 caller). */
  state: z.enum(THEME_IMAGE_STATES).optional(),
  mime: z.enum(THEME_IMAGE_MIME),
  contentBase64: z.string().min(1),
}).refine((i) => i.slot !== THEME_DECOR_SLOT || (i.state ?? 'any') === 'any', {
  path: ['state'], message: 'the decor picture has no states',
});
export type ThemeImageInput = z.infer<typeof themeImageInputSchema>;

/** One stored picture without its bytes. `version` changes on every replace, so a URL carrying it can be cached for good. */
export interface ThemeImageMetaWire {
  themeId: string; slot: ThemeImageSlot; state: ThemeImageState; mime: (typeof THEME_IMAGE_MIME)[number]; size: number;
  version: string; updatedBy: string | null; updatedAt: string;
}

/**
 * Which stored picture shows for a member in a state: its own state picture,
 * else the plain one. With no state asked (a thumbnail, a picker card), the
 * plain picture, else idle, working, done. Null when the member has none.
 */
export function pickThemeImage<T>(pictures: Partial<Record<ThemeImageState, T>> | undefined, state?: ThemePictureState): T | null {
  if (!pictures) return null;
  if (state) return pictures[state] ?? pictures.any ?? null;
  return pictures.any ?? pictures.idle ?? pictures.working ?? pictures.done ?? null;
}
export interface ThemeImageWire extends ThemeImageMetaWire { contentBase64: string }

/** A custom (uploaded) theme as stored. Built-in themes are never stored. */
export interface ThemeRecordWire { manifest: ThemeManifest; updatedBy: string | null; updatedAt: string }

/** A picture as the browser should load it: same-origin URL with the version baked in. */
export interface ThemeImageRef { url: string; version: string }

/** One entry in the theme picker. */
export interface ThemeSummaryWire {
  id: string; name: string; description: string | null; crewName: string; builtIn: boolean; active: boolean;
  images: Partial<Record<ThemeSlot, ThemeImageRef>>;
}

/** Every stored picture of a theme, by member and state (`any` = the plain picture). */
export type ThemeStateImages = Partial<Record<ThemeSlot, Partial<Record<ThemeImageState, ThemeImageRef>>>>;

/**
 * GET /api/theme: what the web renders with. `images` is each member's default
 * picture (see pickThemeImage); `stateImages` has all of them, so the web can
 * show a member's idle, working or done picture. `requested` is set when THEME
 * names a theme that does not exist (classic is served instead).
 */
export interface ActiveThemeWire {
  manifest: ThemeManifest; builtIn: boolean;
  images: Partial<Record<ThemeSlot, ThemeImageRef>>;
  /** Absent from an api older than M13. */
  stateImages?: ThemeStateImages;
  /** The theme's decor picture, or null without one. Absent from an api that predates decor pictures. */
  decorImage?: ThemeImageRef | null;
  requested: string | null;
}

/** One line from `list` for `tick` (e.g. seconds / 6). Deterministic and wraps around. */
export function pickLine(list: readonly string[], tick: number): string {
  const i = ((Math.floor(tick) % list.length) + list.length) % list.length;
  return list[i];
}
