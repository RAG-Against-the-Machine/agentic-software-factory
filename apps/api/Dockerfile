# syntax=docker/dockerfile:1.7
# Multi-stage: build the workspace once, then copy one app's pruned production tree.
FROM node:25-slim AS build
RUN corepack enable && corepack prepare pnpm@11.20.0 --activate
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
COPY prompts ./prompts
COPY db ./db
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @asf/shared build
RUN pnpm --filter @asf/api build && pnpm --filter @asf/web build
RUN pnpm --filter @asf/api --prod deploy --legacy /out

FROM node:25-slim
WORKDIR /app
COPY --from=build /out/dist ./apps/api/dist
COPY --from=build /out/node_modules ./apps/api/node_modules
COPY --from=build /out/package.json ./apps/api/package.json
COPY --from=build /src/apps/web/dist ./web
# `pnpm deploy --legacy` symlinks @asf/shared back into /src; make the image self-contained.
COPY --from=build /src/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /src/packages/shared/dist /app/packages/shared/dist
# shared's own deps (zod) as a real, symlink-free install.
RUN cd /app/packages/shared && npm install --omit=dev --no-package-lock --no-audit --no-fund --loglevel=error
RUN rm -f apps/api/node_modules/@asf/shared && ln -s ../../../../packages/shared apps/api/node_modules/@asf/shared \
 && chown -R node:node /app
USER node
ARG ASF_BUILD_VERSION=dev
ENV ASF_BUILD_VERSION=$ASF_BUILD_VERSION
ENV NODE_ENV=production WEB_DIST=/app/web
CMD ["node", "apps/api/dist/index.js"]
