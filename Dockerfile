FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm --filter @event-pos/contracts build && pnpm --filter @event-pos/register-web build && pnpm --filter @event-pos/server build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 POS_DATABASE_PATH=/var/lib/event-pos/event-pos.sqlite
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml /app/
COPY --from=build /workspace/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build /workspace/apps/server/dist /app/apps/server/dist
COPY --from=build /workspace/apps/server/package.json /app/apps/server/package.json
COPY --from=build /workspace/apps/register-web/dist /app/register-web
RUN pnpm install --prod --frozen-lockfile && mkdir -p /var/lib/event-pos
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
