import { THEME_DECOR_SLOT, THEME_IMAGE_STATES, THEME_PICTURE_STATES, THEME_SLOTS, themeManifestSchema, type ThemeImageSlot, type ThemeImageState, type ThemeManifest, type ThemeSlot } from './theme.js';
import { parseSlotImageZip, type SlotImage } from './avatars.js';
import { BUILT_IN_THEMES } from './themes/index.js';

/**
 * Theme packs (M12): one zip holding an optional `theme.json` manifest and
 * pictures named after the member: `planner.png` is the plain picture, and
 * (M13) `planner-idle.webp`, `planner-working.webp`, `planner-done.webp` are
 * its pictures per state. `decor.png` is the theme's decor picture (no states).
 * `queen` is accepted for the orchestrator so a Hive pack can use its own word. Node-only (the zip reader uses node:zlib).
 */
export const THEME_MANIFEST_FILE = 'theme.json';
export const THEME_MANIFEST_MAX_BYTES = 32 * 1024;
export const THEME_SLOT_ALIASES: Record<string, ThemeSlot> = { queen: 'orchestrator' };

/**
 * All the pictures in one pack together may be at most this many single
 * pictures' worth (`maxBytes` each): room for a plain picture per member, or a
 * full idle/working/done set of smaller loops, plus a decor picture.
 */
export const THEME_PACK_PICTURES_BUDGET = THEME_SLOTS.length + 1;

/** A request body big enough for a full pack (see THEME_PACK_PICTURES_BUDGET), base64 (4/3), plus 1 MiB for the manifest and framing. */
export function themeBodyLimitBytes(maxMb: number): number {
  return Math.ceil(THEME_PACK_PICTURES_BUDGET * maxMb * 1024 * 1024 * 4 / 3) + 1024 * 1024;
}

export interface ThemePackImage extends SlotImage<ThemeImageSlot> { state: ThemeImageState }
export type ThemePackResult =
  | { ok: true; manifest: ThemeManifest | null; images: ThemePackImage[] }
  | { ok: false; reason: string };

/** File-name stems a pack may use: `<member>` and `<member>-<state>`, in member then state order, then `decor` (no states). */
const STEMS: { stem: string; slot: ThemeImageSlot; state: ThemeImageState }[] = [
  ...THEME_SLOTS.flatMap((slot) =>
    THEME_IMAGE_STATES.map((state) => ({ stem: state === 'any' ? slot : `${slot}-${state}`, slot, state }))),
  { stem: THEME_DECOR_SLOT, slot: THEME_DECOR_SLOT, state: 'any' },
];
const STEM_KEYS = STEMS.map((s) => s.stem);
const STEM_OF = new Map(STEMS.map((s) => [s.stem, s]));
const STEM_ALIASES: Record<string, string> = Object.fromEntries(
  Object.entries(THEME_SLOT_ALIASES).flatMap(([alias, slot]) => [
    [alias, slot], ...THEME_PICTURE_STATES.map((st) => [`${alias}-${st}`, `${slot}-${st}`]),
  ]));

/** How to name pictures, for error messages. */
export const THEME_PICTURE_NAMING = `Name each picture after its member (${THEME_SLOTS.join(', ')}), optionally with a state (${THEME_PICTURE_STATES.join(', ')}), and a .png, .jpg, .gif or .webp extension: planner.png, or planner-idle.webp, planner-working.webp, planner-done.webp. A decor picture for the whole theme is decor.png (no states).`;

/**
 * Read a theme pack. With `requireManifest`, a pack without `theme.json` is
 * refused (a new theme needs a name); without it, pictures alone are fine
 * (replacing pictures on an existing theme). A pack with neither is refused.
 * A manifest may not take the id of a built-in theme.
 */
export function parseThemePack(buf: Buffer, opts: { maxBytes: number; requireManifest?: boolean }): ThemePackResult {
  const r = parseSlotImageZip(buf, {
    maxBytes: opts.maxBytes,
    slots: STEM_KEYS,
    aliases: STEM_ALIASES,
    extras: [THEME_MANIFEST_FILE],
    extraMaxBytes: THEME_MANIFEST_MAX_BYTES,
  });
  if (!r.ok) return r;
  const total = r.images.reduce((n, i) => n + i.bytes.length, 0);
  const budget = THEME_PACK_PICTURES_BUDGET * opts.maxBytes;
  if (total > budget) {
    const mb = (n: number) => Math.round((n / (1024 * 1024)) * 10) / 10;
    return { ok: false, reason: `The pictures add up to ${mb(total)} MB; one upload can carry at most ${mb(budget)} MB. Upload them in two zips, or make them smaller.` };
  }
  const images: ThemePackImage[] = r.images.map((i) => {
    const s = STEM_OF.get(i.slot)!;
    return { slot: s.slot, state: s.state, mime: i.mime, bytes: i.bytes };
  });
  let manifest: ThemeManifest | null = null;
  const raw = r.extras.get(THEME_MANIFEST_FILE);
  if (raw) {
    let json: unknown;
    try { json = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: `${THEME_MANIFEST_FILE} is not valid JSON.` }; }
    const parsed = themeManifestSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, reason: `${THEME_MANIFEST_FILE}: ${issue.path.join('.') || '(top level)'}: ${issue.message}` };
    }
    if (BUILT_IN_THEMES.some((t) => t.id === parsed.data.id)) {
      return { ok: false, reason: `"${parsed.data.id}" is a built-in theme. Give your theme a different id.` };
    }
    manifest = parsed.data;
  }
  if (opts.requireManifest && !manifest) return { ok: false, reason: `A new theme needs a ${THEME_MANIFEST_FILE} with its name and members.` };
  if (!manifest && images.length === 0) {
    return { ok: false, reason: `No pictures found in the zip. ${THEME_PICTURE_NAMING}` };
  }
  return { ok: true, manifest, images };
}
