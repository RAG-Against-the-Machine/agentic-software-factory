import { inflateRawSync } from 'node:zlib';
import { z } from 'zod';

/**
 * Agent avatars: one image per role for the whole factory, uploaded from
 * Settings as a zip of `<role>.<ext>` files. Only raster types are allowed; SVG
 * is left out because it is script-capable markup, not a picture. The declared
 * extension must agree with the file's magic bytes, so a renamed file is refused.
 *
 * Node-only (the zip reader uses node:zlib): the web imports TYPES from here.
 */
export const AVATAR_ROLES = ['planner', 'implementer', 'tester', 'reviewer'] as const;
export type AvatarRole = (typeof AVATAR_ROLES)[number];
export const isAvatarRole = (r: string): r is AvatarRole => (AVATAR_ROLES as readonly string[]).includes(r);

export const AVATAR_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AvatarMime = (typeof AVATAR_MIME)[number];
const EXT_MIME: Record<string, AvatarMime> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const AVATAR_EXTENSIONS = Object.keys(EXT_MIME);

/** The image type the bytes actually are, or null when they are none of the allowed ones. */
export function sniffImageMime(b: Uint8Array): AvatarMime | null {
  const at = (i: number, sig: number[]) => sig.every((v, k) => b[i + k] === v);
  const ascii = (i: number, s: string) => at(i, [...s].map((c) => c.charCodeAt(0)));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
  return null;
}

/** A request body big enough for one image per role of `maxMb` each, base64 (4/3), plus 1 MiB of framing. */
export function avatarBodyLimitBytes(maxMb: number): number {
  return Math.ceil(AVATAR_ROLES.length * maxMb * 1024 * 1024 * 4 / 3) + 1024 * 1024;
}

export interface AvatarFile { role: AvatarRole; mime: AvatarMime; bytes: Buffer }
export type AvatarZipResult = { ok: true; avatars: AvatarFile[] } | { ok: false; reason: string };

const NAMING = `Name each image after its role (${AVATAR_ROLES.join(', ')}) with a .png, .jpg, .gif or .webp extension, e.g. planner.png.`;

/**
 * Read the avatars out of a zip. An entry counts when its file name (folders
 * ignored, any case) is `<role>.<ext>`; `__MACOSX` entries and other files are
 * skipped. Refuses with a reason on a role file of a disallowed type, bytes that
 * are not the type the extension says, an image over `maxBytes`, the same role
 * twice, or no role file at all. Stored and deflated entries only, which is
 * what every common zip tool writes.
 */
export function parseAvatarZip(buf: Buffer, opts: { maxBytes: number }): AvatarZipResult {
  const r = parseSlotImageZip(buf, { maxBytes: opts.maxBytes, slots: AVATAR_ROLES, noun: 'avatar' });
  if (!r.ok) return r;
  if (r.images.length === 0) return { ok: false, reason: `No avatar images found in the zip. ${NAMING}` };
  return { ok: true, avatars: r.images.map((i) => ({ role: i.slot, mime: i.mime, bytes: i.bytes })) };
}

export interface SlotImage<S extends string> { slot: S; mime: AvatarMime; bytes: Buffer }
export type SlotImageZipResult<S extends string> =
  | { ok: true; images: SlotImage<S>[]; extras: Map<string, Buffer> }
  | { ok: false; reason: string };

/**
 * The general reader behind avatar and theme-pack uploads. An entry is an image
 * when its file name (folders ignored, any case) is `<slot>.<ext>` for one of
 * `slots`, or `<alias>.<ext>` for a key of `aliases`. Each name in `extras`
 * (lower case, matched on the file name alone) is returned as raw bytes, capped
 * at `extraMaxBytes`. Everything else is skipped. Refuses with a reason on an
 * image of a disallowed type, bytes that are not the type the extension says,
 * an image over `maxBytes`, or the same slot twice. Images come back in `slots`
 * order. Finding no images is NOT an error here; callers decide.
 */
export function parseSlotImageZip<S extends string>(buf: Buffer, opts: {
  maxBytes: number;
  slots: readonly S[];
  aliases?: Record<string, S>;
  extras?: readonly string[];
  extraMaxBytes?: number;
  noun?: string;
}): SlotImageZipResult<S> {
  const entries = readZipDirectory(buf);
  if (typeof entries === 'string') return { ok: false, reason: entries };
  const mb = (n: number) => Math.round((n / (1024 * 1024)) * 100) / 100;
  const maxMb = mb(opts.maxBytes);
  const noun = opts.noun ?? 'picture';
  const slotOf = (name: string): S | null =>
    (opts.slots as readonly string[]).includes(name) ? (name as S) : (opts.aliases?.[name] ?? null);
  const found = new Map<S, SlotImage<S>>();
  const extras = new Map<string, Buffer>();
  for (const e of entries) {
    if (e.name.endsWith('/') || e.name.split('/').some((p) => p === '__MACOSX')) continue;
    const base = e.name.split('/').pop()!;
    const lower = base.toLowerCase();
    if (opts.extras?.includes(lower)) {
      const cap = opts.extraMaxBytes ?? 64 * 1024;
      if (extras.has(lower)) return { ok: false, reason: `The zip has more than one ${lower}. Keep one.` };
      if (e.size > cap) return { ok: false, reason: `${e.name} is larger than ${Math.round(cap / 1024)} KB.` };
      const bytes = readEntry(buf, e, cap);
      if (bytes === TOO_LARGE) return { ok: false, reason: `${e.name} is larger than ${Math.round(cap / 1024)} KB.` };
      if (typeof bytes === 'string') return { ok: false, reason: `${e.name}: ${bytes}` };
      extras.set(lower, bytes);
      continue;
    }
    const dot = base.lastIndexOf('.');
    if (dot <= 0) continue;
    const slot = slotOf(base.slice(0, dot).toLowerCase());
    const ext = base.slice(dot + 1).toLowerCase();
    if (!slot) continue;
    const mime = EXT_MIME[ext];
    if (!mime) return { ok: false, reason: `${e.name}: only PNG, JPEG, GIF and WebP images can be ${noun}s (got .${ext}).` };
    if (found.has(slot)) return { ok: false, reason: `The zip has more than one ${slot} image. Keep one.` };
    if (e.size > opts.maxBytes) return { ok: false, reason: `${e.name} is larger than ${maxMb} MB.` };
    const bytes = readEntry(buf, e, opts.maxBytes);
    if (bytes === TOO_LARGE) return { ok: false, reason: `${e.name} is larger than ${maxMb} MB.` };
    if (typeof bytes === 'string') return { ok: false, reason: `${e.name}: ${bytes}` };
    if (bytes.length === 0) return { ok: false, reason: `${e.name} is empty.` };
    if (bytes.length > opts.maxBytes) return { ok: false, reason: `${e.name} is larger than ${maxMb} MB.` };
    const actual = sniffImageMime(bytes);
    if (actual !== mime) return { ok: false, reason: `${e.name} is not really a ${ext.toUpperCase()} image${actual ? ` (it is ${actual})` : ''}.` };
    found.set(slot, { slot, mime, bytes });
  }
  return { ok: true, images: opts.slots.flatMap((s) => found.get(s) ?? []), extras };
}

const TOO_LARGE = 'too large';

interface ZipEntry { name: string; method: number; flags: number; csize: number; size: number; localOffset: number }

/** The central directory, or why it cannot be read. */
function readZipDirectory(buf: Buffer): ZipEntry[] | string {
  const notZip = 'That file is not a zip archive.';
  // End of central directory: 22 bytes plus an optional comment of up to 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return notZip;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return notZip;
    const nameLen = buf.readUInt16LE(p + 28);
    entries.push({
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      name: buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/** One entry's uncompressed bytes, TOO_LARGE past maxBytes, or why it cannot be read. */
function readEntry(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer | string {
  if (e.flags & 1) return 'encrypted zip entries are not supported.';
  if (e.csize === 0xffffffff || e.size === 0xffffffff) return 'ZIP64 entries are not supported.';
  const h = e.localOffset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) return 'the zip is damaged.';
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  if (start + e.csize > buf.length) return 'the zip is damaged.';
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data;
  if (e.method !== 8) return 'only stored or deflated zip entries are supported.';
  try {
    // The cap stops a small entry that inflates to something huge (a zip bomb).
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') return TOO_LARGE;
    return 'the zip is damaged.';
  }
}

// --- wire (browser → api → registry) ---

export const avatarInputSchema = z.object({
  role: z.enum(AVATAR_ROLES),
  mime: z.enum(AVATAR_MIME),
  contentBase64: z.string().min(1),
});
export type AvatarInput = z.infer<typeof avatarInputSchema>;

/** POST /api/avatars: the zip, base64 (same approach as ad-hoc attachments, no multipart dependency). */
export const uploadAvatarsRequestSchema = z.object({ zipBase64: z.string().min(1) });

/** One stored avatar without its bytes. `version` changes on every replace, so a URL carrying it can be cached. */
export interface AvatarMetaWire { role: AvatarRole; mime: AvatarMime; size: number; version: string; updatedBy: string | null; updatedAt: string }
export interface AvatarWire extends AvatarMetaWire { contentBase64: string }
