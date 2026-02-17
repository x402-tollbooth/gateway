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
- `src/gateway.ts` — main server tying everything together (Bun.serve)
- `src/cli.ts` — CLI entry point

## Commands

- `bun run dev` — start with watch mode
- `bun run build` — build ESM + declarations
- `bun test` — run tests
- `bun run check` — biome lint + format check
- `bun run type-check` — tsc --noEmit

## Key Design Decisions

- YAML-first config with `fn:` escape hatch for dynamic pricing
- Body is only buffered when a route has `body.*` match rules (perf optimization)
- Match rules evaluate top-to-bottom, first match wins
- Hooks: onRequest → onPriceResolved → onSettled → onResponse / onError
- Route-level hooks override global hooks
- Uses x402 V2 headers (PAYMENT-REQUIRED, not X-PAYMENT)
