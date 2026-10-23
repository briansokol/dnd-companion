# One build for the whole workspace, one runtime target per service:
#   docker build --target web .   |   docker build --target mcp .
# Images build natively on the machine that runs them (arm64 on the Mac,
# amd64 on Firefly), so nothing here may assume an architecture.

# Keep in sync with .nvmrc.
ARG NODE_VERSION=24.22.1

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /app
RUN corepack enable
# Install from the manifests alone so source edits don't bust the install layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/mcp/package.json packages/mcp/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
RUN pnpm --filter @dnd/mcp deploy --prod --legacy /deploy/mcp

FROM node:${NODE_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# The config loader finds the workspace root by pnpm-workspace.yaml and reads env/${APP_ENV}.env from it.
COPY pnpm-workspace.yaml ./
COPY env ./env
USER node

FROM runtime AS web
# adapter-node bundles devDependencies into build/, so no node_modules are needed.
COPY --from=build /app/apps/web/build ./apps/web/build
COPY --from=build /app/apps/web/package.json ./apps/web/
WORKDIR /app/apps/web
CMD ["node", "build"]

FROM runtime AS mcp
COPY --from=build /deploy/mcp ./packages/mcp
WORKDIR /app/packages/mcp
CMD ["node", "dist/main.js"]
