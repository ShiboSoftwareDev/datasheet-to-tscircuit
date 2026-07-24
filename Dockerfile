FROM oven/bun:1.3.9 AS dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile

FROM dependencies AS build

COPY . .
RUN bun run build:web

FROM oven/bun:1.3.9 AS runtime

ARG SOURCE_COMMIT=unavailable

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu ngspice poppler-utils \
    && rm -rf /var/lib/apt/lists/*

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000 \
    SOURCE_COMMIT=${SOURCE_COMMIT}

COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/src ./src
COPY --chmod=755 scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /app/.runtime/jobs && chown -R bun:bun /app/.runtime

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "run", "start:server"]
