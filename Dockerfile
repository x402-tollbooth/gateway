# Stage 1: Install dependencies and build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY src/ src/
COPY scripts/ scripts/
COPY tsconfig.json vitest.config.ts ./

RUN npm run build

# Stage 2: Production image
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && \
    rm -rf /tmp/* /root/.npm/_cacache

COPY --from=builder /app/dist ./dist

EXPOSE 3000

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["start"]
