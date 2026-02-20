# ⛩️ x402 Tollbooth

[![npm version](https://img.shields.io/npm/v/x402-tollbooth.svg)](https://www.npmjs.com/package/x402-tollbooth)
[![Publish to npm](https://github.com/Loa212/x402-tollbooth/actions/workflows/publish.yml/badge.svg)](https://github.com/Loa212/x402-tollbooth/actions/workflows/publish.yml)

Turn any API into a paid [x402](https://x402.org) API. One YAML config, zero code.

Tollbooth is an API gateway that sits in front of your upstream APIs and charges callers per-request using the x402 payment protocol. No API keys, no subscriptions — just instant USDC micropayments.

## Quickstart

```bash
bun add tollbooth
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

Start:

```bash
npx tollbooth start
```

That's it. `GET /data` now requires an x402 payment of $0.01 USDC.

## Docker

Run tollbooth without installing Bun — just mount your config:

```bash
docker run -v ./tollbooth.config.yaml:/app/tollbooth.config.yaml \
  ghcr.io/loa212/x402-tollbooth:latest
```

Pass a custom port or config path:

```bash
docker run -p 8080:8080 \
  -v ./tollbooth.config.yaml:/app/tollbooth.config.yaml \
  ghcr.io/loa212/x402-tollbooth:latest \
  start --config=/app/tollbooth.config.yaml --port=8080
```

Use env vars for secrets:

```bash
docker run -p 3000:3000 \
  -e API_KEY=sk-... \
  -v ./tollbooth.config.yaml:/app/tollbooth.config.yaml \
  ghcr.io/loa212/x402-tollbooth:latest
```

### Available tags

| Tag             | Description              |
| --------------- | ------------------------ |
| `latest`        | Latest build from `main` |
| `0.4.0` / `0.4` | Specific release version |
| `<sha>`         | Specific commit          |

## Deploy

| Platform                       | Guide                                  | Notes                                      |
| ------------------------------ | -------------------------------------- | ------------------------------------------ |
| [Fly.io](https://fly.io)       | [Deploy guide](docs/deploy/fly-io.md)  | `fly.toml` template, scale-to-zero support |
| [Railway](https://railway.com) | [Deploy guide](docs/deploy/railway.md) | Docker-based, auto-deploy from GitHub      |

All guides use the published Docker image (`ghcr.io/loa212/x402-tollbooth`). You can also deploy on any platform that runs Docker containers.

## Local Development

Try tollbooth locally with a dummy API — no wallets or real payments needed.

### 1. Install dependencies

```bash
bun install
```

### 2. Start the dummy upstream API

```bash
bun run examples/dummy-api.ts
```

This starts a fake API on `http://localhost:4000` with three endpoints:

- `GET /weather` → returns weather data
- `POST /chat` → echoes back the model name (for testing body-match pricing)
- `GET /data/:id` → returns mock query results

### 3. Start tollbooth

In a second terminal:

```bash
bun run src/cli.ts -- --config=examples/tollbooth.config.dev.yaml
```

Tollbooth starts on `http://localhost:3000` and proxies to the dummy API with x402 payment requirements.

### 4. Test the 402 flow

In a third terminal:

```bash
bun run examples/test-client.ts
```

This fires requests at tollbooth and prints the 402 responses. You should see different prices depending on the route:

| Request                            | Price          | Why                             |
| ---------------------------------- | -------------- | ------------------------------- |
| `GET /weather`                     | $0.01 (10000)  | Static price                    |
| `POST /chat` body `model: "haiku"` | $0.005 (5000)  | Body-match rule                 |
| `POST /chat` body `model: "opus"`  | $0.075 (75000) | Body-match rule                 |
| `GET /data/12345`                  | $0.05 (50000)  | Param extraction + static price |
| `GET /.well-known/x402`            | 200            | V2 discovery metadata           |
| `GET /health`                      | 200            | Health check                    |

Since no real wallet is signing payments, every request gets a 402 back with the `PAYMENT-REQUIRED` header — which is exactly what we want to verify.

## End-to-End Test with Real Payments

Run a full payment cycle on Base Sepolia testnet: `GET /weather` → 402 → sign → pay → 200 with tx hash.

### 1. Set up two wallets

You need two separate Ethereum wallets:

- **Payer wallet** — the "buyer" that signs and pays for requests. Must hold testnet USDC.
- **Gateway wallet** — the "seller" that receives USDC. Can be any address (no funds needed).

The simplest way to create a dedicated test wallet for each:

```bash
# Using cast (install Foundry: https://getfoundry.sh)
cast wallet new   # run twice, use one as payer and one as gateway
```

Or export keys from MetaMask, Coinbase Wallet, etc.

### 2. Configure your env file

Copy the example and fill in your values:

```bash
cp .env.test.example .env.test
```

```bash
# .env.test

# Payer wallet (the "buyer") — needs testnet USDC
TEST_PRIVATE_KEY=0x...          # private key of the payer wallet
TEST_WALLET_ADDRESS=0x...       # public address of the payer wallet

# Gateway wallet (the "seller") — receives USDC payments
TEST_GATEWAY_ADDRESS=0x...      # must be a different address from TEST_WALLET_ADDRESS
```

> **Never commit `.env.test`** — it contains your private key. It's already in `.gitignore`.

### 3. Get testnet USDC

The payer wallet needs USDC on Base Sepolia. The x402 facilitator sponsors gas, so you only need USDC — no ETH required.

1. Go to the [Circle USDC Faucet](https://faucet.circle.com)
2. Select **Base Sepolia** as the network
3. Paste your **payer** wallet address (`TEST_WALLET_ADDRESS`) and request USDC

You'll receive testnet USDC at `0x036CbD53842c5426634e7929541eC2318f3dCF7e`.

### 4. Run the test

```bash
bun install   # installs viem and other deps
```

Open three terminals:

**Terminal 1 — dummy upstream:**

```bash
bun run examples/dummy-api.ts
```

**Terminal 2 — tollbooth gateway:**

```bash
bun run --env-file=.env.test src/cli.ts start --config=examples/tollbooth.config.e2e.yaml
```

**Terminal 3 — e2e test:**

```bash
bun run --env-file=.env.test examples/e2e-payment.ts
```

### Expected output

```
🔑 Payer wallet:   0xYourPayerAddress
   Network:        Base Sepolia (chain 84532)
   USDC contract:  0x036CbD53842c5426634e7929541eC2318f3dCF7e
   Gateway:        http://localhost:3000

── Step 1: GET /weather (expect 402) ──
✓ Got 402 with payment requirements:
  scheme:             exact
  network:            base-sepolia
  asset:              0x036CbD53842c5426634e7929541eC2318f3dCF7e
  maxAmountRequired:  1000 (0.001 USDC)
  payTo:              0xYourGatewayAddress
  maxTimeoutSeconds:  300

── Step 2: Sign EIP-3009 transferWithAuthorization ──
✓ Payment signed:
  from:         0xYourPayerAddress
  to:           0xYourGatewayAddress
  value:        1000 (0.001 USDC)
  ...

── Step 3: Resend GET /weather + payment-signature (expect 200) ──
Status: 200

── Step 4: Verify payment-response header ──

✅ E2E test passed!
──────────────────────────────────────────────────────────────
  Tx hash:  0xabc123...
  Network:  base-sepolia
  Payer:    0xYourPayerAddress
  Amount:   1000 raw units
──────────────────────────────────────────────────────────────

🔗 View on Basescan: https://sepolia.basescan.org/tx/0xabc123...
```

### How signing works

The x402 `exact` scheme uses EIP-3009 `transferWithAuthorization` — a signed permit for USDC that lets the facilitator pull payment from the payer's wallet without the payer broadcasting a transaction. The flow:

1. Tollbooth returns a 402 with the `payment-required` header (base64-encoded requirements)
2. The client signs a `TransferWithAuthorization` EIP-712 typed-data message
3. The signed payload is sent back in the `payment-signature` header
4. Tollbooth forwards it to `https://x402.org/facilitator`, which verifies the signature and settles the on-chain transfer
5. Tollbooth proxies to the upstream and returns 200 with a `payment-response` header containing the tx hash

## Features

- **YAML-first config** — define upstreams, routes, and pricing without code
- **Token-based mode** — auto-detect model from request body, built-in pricing table
- **Dynamic pricing** — match on body fields, query params, headers with glob patterns
- **Multiple upstreams** — proxy to different APIs from one gateway
- **Custom pricing functions** — `fn:` escape hatch for complex pricing logic
- **Lifecycle hooks** — `onRequest`, `onPriceResolved`, `onSettled`, `onResponse`, `onError`
- **x402 V2** — modern headers, auto-discovery at `/.well-known/x402`
- **Multi-chain** — accept payments on Base, Solana, or any supported network
- **Path rewriting** — your public API shape doesn't need to match upstream
- **Env var interpolation** — `${API_KEY}` in config, secrets stay in `.env`
- **Custom facilitator** — point to a self-hosted or alternative facilitator

## Custom Facilitator

By default, tollbooth uses `https://x402.org/facilitator`. You can override this globally or per-route:

```yaml
# Use a custom facilitator for all routes
facilitator: https://custom-facilitator.example.com

upstreams:
  myapi:
    url: https://api.example.com

routes:
  "GET /data":
    upstream: myapi
    price: "$0.01"

  "POST /special":
    upstream: myapi
    price: "$0.05"
    facilitator: https://other-facilitator.example.com # per-route override
```

Route-level `facilitator` takes precedence over the top-level setting. If neither is specified, the default `https://x402.org/facilitator` is used.

## Token-Based Routes

For proxying token-based LLM APIs (OpenAI, Anthropic, Google, OpenRouter, LiteLLM, Ollama, etc.), use `type: token-based` to get automatic model-based pricing without writing match rules:

> `type: openai-compatible` still works as a deprecated alias.

```yaml
upstreams:
  openai:
    url: "https://api.openai.com"
    headers:
      authorization: "Bearer ${OPENAI_API_KEY}"

routes:
  "POST /v1/chat/completions":
    upstream: openai
    type: token-based

  "POST /v1/completions":
    upstream: openai
    type: token-based
```

The gateway auto-extracts the `model` field from the JSON request body and prices the request from a built-in table of common models (GPT-4o, Claude, Gemini, Llama, Mistral, DeepSeek, etc.).

### Override or extend model pricing

Add a `models` map to set custom prices or add models not in the default table:

```yaml
routes:
  "POST /v1/chat/completions":
    upstream: openai
    type: token-based
    models:
      gpt-4o: "$0.05" # override default
      gpt-4o-mini: "$0.005" # override default
      my-fine-tune: "$0.02" # custom model
    fallback: "$0.01" # price for models not in any table
```

**Price resolution order:**

1. `models` (your overrides) — exact match
2. Built-in default table — exact match
3. `price` / `fallback` / `defaults.price` — standard fallback chain

Streaming responses (SSE) work out of the box — the gateway preserves the `ReadableStream` without buffering.

## Dynamic Pricing

Match on request content for per-model, per-param pricing:

```yaml
routes:
  "POST /ai/claude":
    upstream: anthropic
    path: "/v1/messages"
    match:
      - where: { body.model: "claude-haiku-*" }
        price: "$0.005"
      - where: { body.model: "claude-sonnet-*" }
        price: "$0.015"
      - where: { body.model: "claude-opus-*" }
        price: "$0.075"
    fallback: "$0.015"
```

Rules evaluate top-to-bottom. First match wins. `where` supports `body.*`, `query.*`, `headers.*`, and `params.*` with glob matching.

For complex pricing, use a function:

```yaml
routes:
  "POST /ai/completions":
    upstream: anthropic
    price:
      fn: "pricing/completions.ts"
```

```ts
// pricing/completions.ts
import type { PricingFn } from "tollbooth";

export default: PricingFn = ({ body }) => {
  const model = (body as any)?.model ?? "claude-sonnet";
  const maxTokens = (body as any)?.max_tokens ?? 1024;
  const rate = model.includes("opus") ? 0.015 : 0.003;
  return rate * Math.ceil(maxTokens / 1000);
};
```

## Multiple Upstreams

Proxy to different APIs from a single gateway:

```yaml
upstreams:
  anthropic:
    url: "https://api.anthropic.com"
    headers:
      x-api-key: "${ANTHROPIC_API_KEY}"
      anthropic-version: "2023-06-01"

  openai:
    url: "https://api.openai.com"
    headers:
      authorization: "Bearer ${OPENAI_API_KEY}"

  dune:
    url: "https://api.dune.com/api"
    headers:
      x-dune-api-key: "${DUNE_API_KEY}"

routes:
  "POST /ai/claude":
    upstream: anthropic
    path: "/v1/messages"
    price: "$0.015"

  "POST /ai/gpt":
    upstream: openai
    path: "/v1/chat/completions"
    price: "$0.01"

  "GET /data/dune/:query_id":
    upstream: dune
    path: "/v1/query/${params.query_id}/results"
    price: "$0.05"
```

Agents hit one gateway, pay with USDC, and get routed to the right upstream. No API keys needed on the caller side.

## Hooks

Hook into the request lifecycle for logging, analytics, or custom logic:

```yaml
hooks:
  onRequest: "hooks/on-request.ts"
  onSettled: "hooks/log-payment.ts"
  onError: "hooks/handle-error.ts"

routes:
  "POST /ai/claude":
    upstream: anthropic
    hooks:
      onResponse: "hooks/track-usage.ts" # per-route override
```

Available hooks:

| Hook              | When                      | Use case                        |
| ----------------- | ------------------------- | ------------------------------- |
| `onRequest`       | Before anything           | Block abusers, rate limit       |
| `onPriceResolved` | After price is calculated | Override or log pricing         |
| `onSettled`       | After payment confirmed   | Log payments to DB              |
| `onResponse`      | After upstream responds   | Transform response, track usage |
| `onError`         | When upstream fails       | Trigger refunds                 |

## Programmatic API

```ts
import { createGateway, loadConfig } from "tollbooth";

const config = loadConfig("./tollbooth.config.yaml");
const gateway = createGateway(config);
await gateway.start();
```

## CLI

```bash
tollbooth start [--config=path]     # start the gateway
tollbooth dev [--config=path]       # start with watch mode
tollbooth validate [--config=path]  # validate config
```

## How It Works

```
Client                    Tollbooth                  Upstream API
  │                          │                           │
  │  GET /weather            │                           │
  │─────────────────────────>│                           │
  │                          │  (match route, resolve    │
  │                          │   price: $0.01)           │
  │  402 + PAYMENT-REQUIRED  │                           │
  │<─────────────────────────│                           │
  │                          │                           │
  │  (sign USDC payment)     │                           │
  │                          │                           │
  │  GET /weather            │                           │
  │  + PAYMENT-SIGNATURE     │                           │
  │─────────────────────────>│                           │
  │                          │  verify + settle          │
  │                          │  (via facilitator)        │
  │                          │                           │
  │                          │  GET /weather             │
  │                          │──────────────────────────>│
  │                          │                           │
  │                          │  { temp: 22, city: ... }  │
  │                          │<──────────────────────────│
  │  200 + data              │                           │
  │  + PAYMENT-RESPONSE      │                           │
  │<─────────────────────────│                           │
```

## Project Structure

```
src/
├── config/          # YAML loading, Zod validation, env interpolation
├── router/          # Route matching, param extraction, path rewriting
├── pricing/         # Price resolution (static, match, fn), unit conversion
├── openai/          # Token-based route handler, model extraction
├── x402/            # 402 responses, facilitator verify/settle, V2 headers
├── proxy/           # Upstream forwarding, lazy body buffering
├── hooks/           # Lifecycle hook loading and execution
├── discovery/       # V2 auto-discovery metadata
├── __tests__/       # Unit tests
├── gateway.ts       # Main server (Bun.serve)
├── cli.ts           # CLI entry point
├── index.ts         # Public exports
└── types.ts         # Type definitions
```

## License

MIT
