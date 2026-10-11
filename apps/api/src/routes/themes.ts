import type { FastifyInstance, FastifyReply } from 'fastify';
import { crc32 } from 'node:zlib';
import {
  BUILT_IN_THEMES, CLASSIC_THEME, builtInTheme, uploadAvatarsRequestSchema, isThemeImageSlot, isThemeSlot, parseThemePack, pickThemeImage, themeBodyLimitBytes,
  THEME_DECOR_SLOT, THEME_ID_RE, THEME_IMAGE_STATES, THEME_MANIFEST_FILE, THEME_PICTURE_STATES, THEME_SLOTS,
} from '@asf/shared';
import type { ActiveThemeWire, ThemePackImage, ThemeImageMetaWire, ThemeImageRef, ThemeImageSlot, ThemeImageState, ThemeManifest, ThemeSlot, ThemeStateImages, ThemeSummaryWire } from '@asf/shared';
import { registry } from '../registry/client.js';
import { cfg, putSetting } from '../settings.js';
import { resolveIdentity } from '../identity.js';

/**
 * Themes (M12): how the agent crew looks and talks. Built-in themes come from
 * @asf/shared; uploaded themes and every theme's pictures live in the registry.
 * The browser gets same-origin picture URLs with the version baked in, so a
 * picture is cached until it is replaced. Uploads are a zip posted as base64
 * JSON, same as avatars, and go through the same checks.
 */

/** `{ zipBase64 }`, the same body shape as avatar uploads. */
const zipBody = uploadAvatarsRequestSchema;
/** A plain picture keeps its M12 URL (no state segment); a state picture adds `/<state>`. */
const imageUrl = (themeId: string, slot: string, state: ThemeImageState, version: string) =>
  `/api/themes/${encodeURIComponent(themeId)}/images/${encodeURIComponent(slot)}${state === 'any' ? '' : `/${state}`}?v=${encodeURIComponent(version)}`;

/** Every crew picture of one theme, by member and state. Decor is not a member, so it is left out. */
function stateRefsFor(themeId: string, images: ThemeImageMetaWire[]): ThemeStateImages {
  const out: ThemeStateImages = {};
  for (const i of images) {
    if (i.themeId !== themeId || !isThemeSlot(i.slot)) continue;
    const state = i.state ?? 'any';
    (out[i.slot] ??= {})[state] = { url: imageUrl(themeId, i.slot, state, i.version), version: i.version };
  }
  return out;
}

/** The theme's decor picture, or null without one. */
function decorRefFor(themeId: string, images: ThemeImageMetaWire[]): ThemeImageRef | null {
  const i = images.find((m) => m.themeId === themeId && m.slot === THEME_DECOR_SLOT && m.state === 'any');
  return i ? { url: imageUrl(themeId, i.slot, 'any', i.version), version: i.version } : null;
}

/** One picture per member for thumbnails and the picker: the plain one, else idle, working, done. */
function refsFor(themeId: string, images: ThemeImageMetaWire[]): Partial<Record<ThemeSlot, ThemeImageRef>> {
  const all = stateRefsFor(themeId, images);
  const out: Partial<Record<ThemeSlot, ThemeImageRef>> = {};
  for (const slot of THEME_SLOTS) { const r = pickThemeImage(all[slot]); if (r) out[slot] = r; }
  return out;
}

/** The manifest for `id`, built-in or uploaded, or null when there is no such theme. */
export async function findTheme(id: string): Promise<{ manifest: ThemeManifest; builtIn: boolean } | null> {
  const b = builtInTheme(id);
  if (b) return { manifest: b, builtIn: true };
  if (!THEME_ID_RE.test(id)) return null;
  const { theme } = await registry.getTheme(id);
  return theme ? { manifest: theme.manifest, builtIn: false } : null;
}

/** The theme the factory shows right now. A THEME naming a missing theme falls back to classic and says so. */
export async function activeTheme(): Promise<ActiveThemeWire> {
  const requested = String(cfg('THEME') || CLASSIC_THEME.id).trim().toLowerCase();
  const found = await findTheme(requested).catch(() => null);
  const manifest = found?.manifest ?? CLASSIC_THEME;
  const { images } = await registry.listThemeImages(manifest.id);
  return {
    manifest, builtIn: found?.builtIn ?? true,
    images: refsFor(manifest.id, images), stateImages: stateRefsFor(manifest.id, images),
    decorImage: decorRefFor(manifest.id, images),
    requested: found ? null : requested,
  };
}

const bad = (reply: FastifyReply, code: number, error: string, reason: string) => reply.code(code).send({ error, reason });

export function registerThemeRoutes(app: FastifyInstance): void {
  const maxMb = cfg('AVATAR_MAX_MB');
  const maxBytes = maxMb * 1024 * 1024;
  const bodyLimit = themeBodyLimitBytes(maxMb);

  app.get('/api/theme', async () => activeTheme());

  // Pick the active theme. The generic PUT /api/settings/THEME works too, but this checks the theme exists.
  app.put<{ Body: { id?: unknown } }>('/api/theme', async (req, reply) => {
    const id = typeof req.body?.id === 'string' ? req.body.id.trim().toLowerCase() : '';
    if (process.env.THEME) return bad(reply, 409, 'env_pinned', 'The theme is set by your admin (THEME in the server configuration).');
    if (!(await findTheme(id))) return bad(reply, 404, 'not_found', `There is no theme called "${id}".`);
    await putSetting('THEME', id, resolveIdentity(req).user || null);
    return activeTheme();
  });

  app.get('/api/themes', async () => {
    const [{ themes }, { images }, active] = await Promise.all([registry.listThemes(), registry.listThemeImages(null), activeTheme()]);
    const summary = (m: ThemeManifest, builtIn: boolean): ThemeSummaryWire => ({
      id: m.id, name: m.name, description: m.description ?? null, crewName: m.crew.name, builtIn,
      active: m.id === active.manifest.id, images: refsFor(m.id, images),
    });
    return {
      themes: [...BUILT_IN_THEMES.map((m) => summary(m, true)), ...themes.map((t) => summary(t.manifest, false))],
      slots: THEME_SLOTS, states: THEME_PICTURE_STATES, maxMb, envPinned: Boolean(process.env.THEME),
    };
  });

  // A starter pack: the classic manifest renamed, plus a short README. Download, edit, zip, upload.
  app.get('/api/themes/template.zip', async (_req, reply) => {
    const manifest = { ...CLASSIC_THEME, id: 'my-theme', name: 'My theme', description: 'Describe your crew in a sentence.' };
    const readme = [
      'ASF theme pack',
      '',
      `Edit ${THEME_MANIFEST_FILE}: give the theme a new id (lower-case letters, digits, dashes), a name, the crew's name and a name for each member.`,
      'quips and moods are optional lines of text. {orchestrator}, {member}, {crew} and {ticket} are filled in for you.',
      'accent is a hex colour like #e0a526.',
      'appTitle is the product name shown in the app (up to 40 characters). background and text are hex page colours; they must contrast at least 4.5:1.',
      '',
      `Add one picture per member if you like: ${THEME_SLOTS.map((s) => `${s}.png`).join(', ')} (PNG, JPEG, GIF or WebP, up to ${maxMb} MB each).`,
      `A member can also have a picture per state: ${THEME_PICTURE_STATES.map((st) => `planner-${st}.webp`).join(', ')}. The plain picture covers any state without its own.`,
      'A decor picture for the whole theme is decor.png (or .jpg, .gif, .webp). It has no states.',
      'Zip the folder and upload it in Settings, under "How should the factory look?".',
      '',
    ].join('\n');
    return reply.type('application/zip').header('content-disposition', 'attachment; filename="asf-theme-template.zip"')
      .send(storedZip([{ name: `my-theme/${THEME_MANIFEST_FILE}`, data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') }, { name: 'my-theme/README.txt', data: Buffer.from(readme) }]));
  });

  // Add (or replace) an uploaded theme: a zip with theme.json and any pictures.
  app.post('/api/themes', { bodyLimit }, async (req, reply) => {
    const parsed = zipBody.safeParse(req.body);
    if (!parsed.success) return bad(reply, 400, 'bad_request', 'Send the zip as { zipBase64 }.');
    const pack = parseThemePack(Buffer.from(parsed.data.zipBase64, 'base64'), { maxBytes, requireManifest: true });
    if (!pack.ok) return bad(reply, 400, 'bad_theme', pack.reason);
    const { theme } = await registry.putTheme(pack.manifest!, pack.images.map(toInput), resolveIdentity(req).user || null);
    return reply.code(201).send({ theme, pictures: pack.images.map(pictureName) });
  });

  app.delete<{ Params: { id: string } }>('/api/themes/:id', async (req, reply) => {
    const { id } = req.params;
    if (builtInTheme(id)) return bad(reply, 400, 'bad_request', `"${id}" is a built-in theme and cannot be deleted.`);
    if ((await activeTheme()).manifest.id === id) return bad(reply, 409, 'theme_active', 'This theme is in use. Pick another theme first.');
    if (!THEME_ID_RE.test(id)) return bad(reply, 404, 'not_found', `no theme ${id}`);
    const { deleted } = await registry.deleteTheme(id);
    if (!deleted) return bad(reply, 404, 'not_found', `no theme ${id}`);
    return { ok: true };
  });

  // Replace some of a theme's pictures (any theme, built-in included). Pictures only: a theme.json here is refused.
  app.post<{ Params: { id: string } }>('/api/themes/:id/images', { bodyLimit }, async (req, reply) => {
    const { id } = req.params;
    if (!(await findTheme(id))) return bad(reply, 404, 'not_found', `no theme ${id}`);
    const parsed = zipBody.safeParse(req.body);
    if (!parsed.success) return bad(reply, 400, 'bad_request', 'Send the zip as { zipBase64 }.');
    const pack = parseThemePack(Buffer.from(parsed.data.zipBase64, 'base64'), { maxBytes });
    if (!pack.ok) return bad(reply, 400, 'bad_theme', pack.reason);
    if (pack.manifest) return bad(reply, 400, 'bad_theme', `This zip has a ${THEME_MANIFEST_FILE}. To add a theme use "Add a theme"; to change pictures, upload pictures only.`);
    const { images } = await registry.setThemeImages(id, pack.images.map(toInput), resolveIdentity(req).user || null);
    return reply.code(201).send({ images: refsFor(id, images), stateImages: stateRefsFor(id, images), decorImage: decorRefFor(id, images), replaced: pack.images.map(pictureName) });
  });

  type PicParams = { id: string; slot: string; state?: string };
  /** The picture a URL names, or why not. No state segment means the plain picture. Decor has no states. */
  const pictureOf = (p: PicParams): { id: string; slot: ThemeImageSlot; state: ThemeImageState } | null => {
    const state = p.state ?? 'any';
    if (!THEME_ID_RE.test(p.id) || !isThemeImageSlot(p.slot) || !(THEME_IMAGE_STATES as readonly string[]).includes(state)) return null;
    if (p.slot === THEME_DECOR_SLOT && p.state !== undefined) return null;
    return { id: p.id, slot: p.slot, state: state as ThemeImageState };
  };

  const servePicture = async (req: { params: PicParams; query: { v?: string }; headers: Record<string, unknown> }, reply: FastifyReply) => {
    const pic = pictureOf(req.params);
    if (!pic) return bad(reply, 400, 'bad_request', `no such picture ${req.params.id}/${req.params.slot}${req.params.state ? `/${req.params.state}` : ''}`);
    const { image } = await registry.getThemeImage(pic.id, pic.slot, pic.state);
    if (!image) return bad(reply, 404, 'not_found', `no ${pictureName(pic)} picture for ${pic.id}`);
    const etag = `"${image.version}"`;
    reply.header('x-content-type-options', 'nosniff').header('etag', etag)
      // ?v=<current version> is immutable; anything else must revalidate.
      .header('cache-control', req.query.v === image.version ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(image.mime).send(Buffer.from(image.contentBase64, 'base64'));
  };
  app.get<{ Params: PicParams; Querystring: { v?: string } }>('/api/themes/:id/images/:slot', servePicture);
  app.get<{ Params: PicParams; Querystring: { v?: string } }>('/api/themes/:id/images/:slot/:state', servePicture);

  // Without a state: every picture the member has (plain and per state). With one: just that picture.
  const deletePicture = async (req: { params: PicParams }, reply: FastifyReply) => {
    const pic = pictureOf(req.params);
    if (!pic) return bad(reply, 400, 'bad_request', `no such picture ${req.params.id}/${req.params.slot}${req.params.state ? `/${req.params.state}` : ''}`);
    const { deleted } = await registry.deleteThemeImage(pic.id, pic.slot, req.params.state ? pic.state : undefined);
    if (!deleted) return bad(reply, 404, 'not_found', `no ${req.params.state ? pictureName(pic) : pic.slot} picture for ${pic.id}`);
    return { ok: true, deleted };
  };
  app.delete<{ Params: PicParams }>('/api/themes/:id/images/:slot', deletePicture);
  app.delete<{ Params: PicParams }>('/api/themes/:id/images/:slot/:state', deletePicture);
}

const toInput = (i: ThemePackImage) =>
  ({ slot: i.slot, state: i.state, mime: i.mime, contentBase64: i.bytes.toString('base64') });
/** `planner` for the plain picture, `planner-idle` for a state picture: the name it had in the zip. */
const pictureName = (i: { slot: string; state: ThemeImageState }) => (i.state === 'any' ? i.slot : `${i.slot}-${i.state}`);

/** A minimal stored (uncompressed) zip with real CRCs, so every unzip tool accepts it. */
export function storedZip(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); // utf-8 names
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, f.data);
    centrals.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
