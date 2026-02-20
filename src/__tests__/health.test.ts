import { afterEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(
	upstreamPort: number,
	options?: { discovery?: boolean },
): TollboothConfig {
	return {
		gateway: { port: 0, discovery: options?.discovery ?? false },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: "http://localhost:9999", // unreachable on purpose
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /test": { upstream: "api", price: "$0.01" },
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("health and discovery bypass 402 gate", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
	});

	test("GET /health returns 200 without payment header", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/health`);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body).toEqual({ status: "ok" });
	});

	test("GET /.well-known/x402 returns 200 when discovery is enabled", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port, { discovery: true }));
		await gateway.start({ silent: true });

		const res = await fetch(
			`http://localhost:${gateway.port}/.well-known/x402`,
		);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.x402Version).toBe(2);
	});

	test("configured route returns 402 without payment header", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`);
		expect(res.status).toBe(402);
	});
});
