import { afterEach, describe, expect, test } from "vitest";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import { serve } from "./helpers/test-server.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(upstreamPort: number): TollboothConfig {
	return {
		gateway: { port: 0, discovery: false },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: "http://localhost:9999",
		upstreams: { blog: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /": { upstream: "blog", price: "$0" },
			"GET /free-zero": { upstream: "blog", price: "0" },
			"GET /paid": { upstream: "blog", price: "$0.01" },
			"POST /free-post": { upstream: "blog", price: "$0" },
			"GET /no-price": { upstream: "blog" },
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("zero-price routes bypass payment middleware", () => {
	let upstream: Awaited<ReturnType<typeof serve>>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
	});

	test("price: '$0' proxies without requiring payment", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => new Response("welcome"),
		});
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("welcome");
	});

	test("price: '0' (raw zero) proxies without requiring payment", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => new Response("also free"),
		});
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/free-zero`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("also free");
	});

	test("paid route still returns 402 without payment", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => new Response("content"),
		});
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/paid`);
		expect(res.status).toBe(402);
	});

	test("route without price inherits defaults.price and returns 402", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => new Response("content"),
		});
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/no-price`);
		expect(res.status).toBe(402);
	});

	test("zero-price POST route proxies body correctly", async () => {
		let receivedBody = "";
		upstream = await serve({
			port: 0,
			fetch: async (req) => {
				receivedBody = await req.text();
				return new Response("ok");
			},
		});
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/free-post`, {
			method: "POST",
			body: JSON.stringify({ hello: "world" }),
			headers: { "Content-Type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(receivedBody).toBe('{"hello":"world"}');
	});
});
