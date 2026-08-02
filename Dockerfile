FROM node:24-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile \
  && pnpm --filter @event-pos/contracts build \
  && pnpm --filter @event-pos/receipt-ir build \
  && pnpm --filter @event-pos/escpos build \
  && pnpm --filter @event-pos/receipt-template build \
  && pnpm --filter @event-pos/register-web build \
  && pnpm --filter @event-pos/server build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 POS_DATABASE_PATH=/var/lib/event-pos/event-pos.sqlite
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY --from=build /workspace/package.json /workspace/pnpm-lock.yaml /workspace/pnpm-workspace.yaml /app/
COPY --from=build /workspace/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=build /workspace/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build /workspace/packages/receipt-ir/package.json /app/packages/receipt-ir/package.json
COPY --from=build /workspace/packages/receipt-ir/dist /app/packages/receipt-ir/dist
COPY --from=build /workspace/packages/escpos/package.json /app/packages/escpos/package.json
COPY --from=build /workspace/packages/escpos/dist /app/packages/escpos/dist
COPY --from=build /workspace/packages/receipt-template/package.json /app/packages/receipt-template/package.json
COPY --from=build /workspace/packages/receipt-template/dist /app/packages/receipt-template/dist
COPY --from=build /workspace/apps/server/dist /app/apps/server/dist
COPY --from=build /workspace/apps/server/package.json /app/apps/server/package.json
COPY --from=build /workspace/apps/register-web/dist /app/register-web
RUN node -e "const fs=require('fs'); for (const name of ['contracts','receipt-ir','escpos','receipt-template']) { const p='/app/packages/'+name+'/package.json'; const j=JSON.parse(fs.readFileSync(p,'utf8')); j.exports['.'].default='./dist/index.js'; fs.writeFileSync(p, JSON.stringify(j)+'\n'); }"
RUN pnpm install --prod --frozen-lockfile && mkdir -p /var/lib/event-pos
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
