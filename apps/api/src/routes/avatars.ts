import type { FastifyInstance } from 'fastify';
import { AVATAR_ROLES, avatarBodyLimitBytes, isAvatarRole, parseAvatarZip, uploadAvatarsRequestSchema } from '@asf/shared';
import { registry } from '../registry/client.js';
import { cfg } from '../settings.js';
import { resolveIdentity } from '../identity.js';

/**
 * Agent avatars: one image per role for the whole factory. The browser posts a
 * zip as base64 JSON (same approach as ad-hoc attachments, no multipart
 * dependency); only the roles inside it are replaced. Images are served with
 * their real type and `nosniff`, and a URL carrying the current version may be
 * cached for good.
 */
export function registerAvatarRoutes(app: FastifyInstance): void {
  const maxMb = cfg('AVATAR_MAX_MB');

  app.get('/api/avatars', async () => ({ roles: AVATAR_ROLES, maxMb, ...(await registry.listAvatars()) }));

  app.post('/api/avatars', { bodyLimit: avatarBodyLimitBytes(maxMb) }, async (req, reply) => {
    const parsed = uploadAvatarsRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request', reason: 'Send the zip as { zipBase64 }.' });
    const got = parseAvatarZip(Buffer.from(parsed.data.zipBase64, 'base64'), { maxBytes: maxMb * 1024 * 1024 });
    if (!got.ok) return reply.code(400).send({ error: 'bad_avatar', reason: got.reason });
    const { avatars } = await registry.setAvatars(
      got.avatars.map((a) => ({ role: a.role, mime: a.mime, contentBase64: a.bytes.toString('base64') })),
      resolveIdentity(req).user || null,
    );
    return reply.code(201).send({ avatars, replaced: got.avatars.map((a) => a.role) });
  });

  app.get<{ Params: { role: string }; Querystring: { v?: string } }>('/api/avatars/:role', async (req, reply) => {
    const { role } = req.params;
    if (!isAvatarRole(role)) return reply.code(400).send({ error: 'bad_request', reason: `no such role ${role}` });
    const { avatar } = await registry.getAvatar(role);
    if (!avatar) return reply.code(404).send({ error: 'not_found', reason: `no avatar for ${role}` });
    const etag = `"${avatar.version}"`;
    reply.header('x-content-type-options', 'nosniff').header('etag', etag)
      // ?v=<current version> is immutable; anything else must revalidate.
      .header('cache-control', req.query.v === avatar.version ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type(avatar.mime).send(Buffer.from(avatar.contentBase64, 'base64'));
  });

  app.delete<{ Params: { role: string } }>('/api/avatars/:role', async (req, reply) => {
    const { role } = req.params;
    if (!isAvatarRole(role)) return reply.code(400).send({ error: 'bad_request', reason: `no such role ${role}` });
    const { deleted } = await registry.deleteAvatar(role);
    if (!deleted) return reply.code(404).send({ error: 'not_found', reason: `no avatar for ${role}` });
    return { ok: true };
  });
}
