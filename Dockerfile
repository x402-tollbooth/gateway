# Stage 1: Install dependencies and build
FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ src/
COPY scripts/ scripts/
COPY tsconfig.json ./

RUN bun run build

# Stage 2: Production image
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    rm -rf /tmp/* /root/.bun/install/cache

COPY --from=builder /app/dist ./dist

EXPOSE 3000

ENTRYPOINT ["bun", "run", "dist/cli.js"]
CMD ["start"]
