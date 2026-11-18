# x402 Tollbooth

[![npm version](https://img.shields.io/npm/v/x402-tollbooth.svg)](https://www.npmjs.com/package/x402-tollbooth)
[![Publish to npm](https://github.com/x402-tollbooth/gateway/actions/workflows/publish.yml/badge.svg)](https://github.com/x402-tollbooth/gateway/actions/workflows/publish.yml)
[![Docs](https://img.shields.io/badge/docs-tollbooth-blue)](https://docs.tollbooth.sh/)

Turn any API into a paid [x402](https://x402.org) API. One YAML config, zero code.

**[Full docs →](https://docs.tollbooth.sh/)**

Tollbooth is an API gateway that sits in front of your upstream APIs and charges callers using the x402 payment protocol. No API keys, no subscriptions — just instant USDC micropayments.

## Quickstart

```bash
bun add x402-tollbooth
```

Create `tollbooth.config.yaml`:

```yaml
wallets:
  base: "0xYourWallet"

accepts:
  - asset: USDC
    network: base

upstreams:
  myapi:
    url: "https://api.example.com"
    headers:
      authorization: "Bearer ${API_KEY}"

routes:
  "GET /data":
    upstream: myapi
    price: "$0.01"
```

```bash
npx x402-tollbooth start
```

`GET /data` now requires an x402 payment of $0.01 USDC.

## How it works

```
Client                    Tollbooth                  Upstream API
  │                          │                           │
  │  GET /data               │                           │
  │─────────────────────────>│                           │
  │                          │  (match route, price)     │
  │  402 + PAYMENT-REQUIRED  │                           │
  │<─────────────────────────│                           │
  │                          │                           │
  │  (sign USDC payment)     │                           │
  │                          │                           │
  │  GET /data               │                           │
  │  + PAYMENT-SIGNATURE     │                           │
  │─────────────────────────>│                           │
  │                          │  verify + settle          │
  │                          │  (via facilitator)        │
  │                          │                           │
  │                          │  GET /data                │
  │                          │──────────────────────────>│
  │                          │  { data: ... }            │
  │                          │<──────────────────────────│
  │  200 + data              │                           │
  │  + PAYMENT-RESPONSE      │                           │
  │<─────────────────────────│                           │
```

## Docker

```bash
docker run -v ./tollbooth.config.yaml:/app/tollbooth.config.yaml \
  ghcr.io/x402-tollbooth/gateway:latest
```

Available tags: `latest`, `0.5.0` / `0.5`, or a specific commit SHA.

## Features

- **YAML-first config** — define upstreams, routes, and pricing without code
- **Dynamic pricing** — match on body, query, headers with glob patterns; or use custom functions
- **Token-based mode** — auto-detect model from request body, built-in pricing table for LLM APIs
- **Time-based access** — pay once, access until expiry
- **Multiple upstreams** — proxy to different APIs from one gateway
- **Lifecycle hooks** — `onRequest`, `onPriceResolved`, `onSettled`, `onResponse`, `onError`
- **x402 V2** — modern headers, auto-discovery at `/.well-known/x402`
- **Multi-chain** — Base, Solana, or any supported network
- **Pluggable settlement** — default facilitator, self-hosted, Circle Nanopayments, MPP, Tempo (recurring + invoice memos), or fully custom
- **Streaming/SSE** — pass-through without buffering
- **OpenAPI import/export** — auto-generate routes from a spec
- **Prometheus metrics** — request, payment, and upstream counters/histograms
- **Env var interpolation** — `${API_KEY}` in config, secrets stay in `.env`

## CLI

```bash
tollbooth init                          # generate config interactively
tollbooth init --from openapi spec.yaml # generate from OpenAPI spec
tollbooth start [--config=path]         # start the gateway
tollbooth dev [--config=path]           # dev mode with file watching
tollbooth validate [--config=path]      # validate config
```

## Programmatic API

```ts
import { createGateway, loadConfig } from "x402-tollbooth";

const config = loadConfig("./tollbooth.config.yaml");
const gateway = createGateway(config);
await gateway.start();
```

## Deploy

| Platform | Guide |
| --- | --- |
| VPS + Nginx | [Production guide](https://docs.tollbooth.sh/deploy/production) |
| Fly.io | [Deploy guide](https://docs.tollbooth.sh/deploy/fly-io) |
| Railway | [Deploy guide](https://docs.tollbooth.sh/deploy/railway) |
| Any Docker host | Mount your config and run the image |

## Project structure

```
src/
├── config/          # YAML loading, Zod validation, env interpolation
├── router/          # Route matching, param extraction, path rewriting
├── pricing/         # Price resolution (static, match, fn), unit conversion
├── openai/          # Token-based route handler, model extraction
├── x402/            # 402 responses, facilitator verify/settle, V2 headers
├── settlement/      # Pluggable settlement strategy (facilitator, custom)
├── proxy/           # Upstream forwarding, lazy body buffering
├── hooks/           # Lifecycle hook loading and execution
├── discovery/       # V2 auto-discovery metadata
├── gateway.ts       # Main server (Bun.serve)
├── cli.ts           # CLI entry point
├── index.ts         # Public exports
└── types.ts         # Type definitions
```

## License

MIT
