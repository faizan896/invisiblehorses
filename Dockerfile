# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN --mount=type=secret,id=railgate_build_ca \
    if [ -f /run/secrets/railgate_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/railgate_build_ca; fi; \
    npm install --global pnpm@10.20.0
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=railgate_build_ca \
    if [ -f /run/secrets/railgate_build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/railgate_build_ca; fi; \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 DATABASE_PATH=/var/data/railgate.sqlite
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node policies ./policies
COPY --chown=node:node examples/counterparties.json ./examples/counterparties.json
COPY --chown=node:node scripts/start-hosted.mjs scripts/restore-hosted-db.mjs scripts/hosted-entrypoint.sh ./scripts/
ENTRYPOINT ["sh", "scripts/hosted-entrypoint.sh"]
CMD ["node", "scripts/start-hosted.mjs"]
