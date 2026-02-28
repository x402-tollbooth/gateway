# Tollbooth

x402 API gateway — turns any API into a paid API using the x402 protocol.

## Architecture

- `src/config/` — YAML/JSON config loading, Zod validation, env var interpolation
- `src/router/` — route matching, param extraction, path rewriting
- `src/pricing/` — price resolution (static, match rules, dynamic fn), unit conversion
- `src/x402/` — x402 protocol: 402 responses, payment verification, facilitator communication
- `src/proxy/` — upstream request forwarding, body buffering
- `src/hooks/` — lifecycle hook loading and execution
- `src/discovery/` — x402 V2 auto-discovery metadata generation
- `src/runtime/` — portable HTTP server adapter (node:http, works on both Node.js and Bun)
- `src/gateway.ts` — main server tying everything together
- `src/cli.ts` — CLI entry point

## Commands

- `npm run dev` — start with watch mode
- `npm run build` — build ESM + declarations (esbuild + tsc)
- `npm test` — run tests (vitest)
- `npm run check` — biome lint + format check
- `npm run type-check` — tsc --noEmit

## Runtime Support

- Node.js 20+ (`npx tollbooth start`)
- Bun 1.0+ (`bunx tollbooth start`)

## Key Design Decisions

- YAML-first config with `fn:` escape hatch for dynamic pricing
- Body is only buffered when a route has `body.*` match rules (perf optimization)
- Match rules evaluate top-to-bottom, first match wins
- Hooks: onRequest → onPriceResolved → onSettled → onResponse / onError
- Route-level hooks override global hooks
- Uses x402 V2 headers (PAYMENT-REQUIRED, not X-PAYMENT)
- HTTP server uses `node:http` for portability across Node.js and Bun
- Redis client uses `ioredis` for universal runtime support
