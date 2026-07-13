FROM oven/bun:1.3.9 AS dependencies

WORKDIR /app

COPY package.json ./
RUN bun install

FROM dependencies AS build

COPY . .
RUN bun run build

FROM oven/bun:1.3.9 AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends poppler-utils \
    && rm -rf /var/lib/apt/lists/*

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=3000

COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --from=build --chown=bun:bun /app/src ./src

RUN mkdir -p /app/.runtime/jobs && chown -R bun:bun /app/.runtime

USER bun

EXPOSE 3000

CMD ["bun", "run", "start"]
