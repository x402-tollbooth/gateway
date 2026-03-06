import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createGateway } from "../gateway.js";
import { MemoryRateLimitStore } from "../ratelimit/store.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import { decodePaymentRequired } from "../x402/headers.js";
import { serve, type TestServer } from "./helpers/test-server.js";

// ── Shared infrastructure ────────────────────────────────────────────────────

let upstream: TestServer;
let gateway: TollboothGateway;
let baseUrl: string;

function makeConfig(upstreamPort: number): TollboothConfig {
	return {
		gateway: {
			port: 0,
			discovery: true,
			cors: {
				allowedOrigins: ["https://app.example.com"],
				allowedMethods: ["GET", "POST"],
				allowedHeaders: ["content-type", "payment-signature"],
				exposedHeaders: ["payment-required", "payment-response"],
				credentials: true,
				maxAge: 600,
			},
		},
		wallets: { "base-sepolia": "0xTestWallet" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: "http://localhost:19999", // unreachable — only needed for actual settlement
		upstreams: {
			api: { url: `http://localhost:${upstreamPort}` },
		},
		routes: {
			"GET /free": { upstream: "api", price: "$0" },
			"POST /free-post": { upstream: "api", path: "/echo", price: "$0" },
			"GET /paid": { upstream: "api", price: "$0.01" },
			"GET /rate-limited": {
				upstream: "api",
				price: "$0",
				rateLimit: { requests: 2, window: "1m" },
			},
		},
	};
}

beforeAll(async () => {
	// Mock upstream: echoes method + path as JSON
	upstream = await serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			const body: Record<string, unknown> = {
				method: req.method,
				path: url.pathname,
			};
			if (req.method === "POST") {
				body.body = await req.text();
			}
			return Response.json(body);
		},
	});

	const config = makeConfig(upstream.port);
	const rateLimitStore = new MemoryRateLimitStore();
	gateway = createGateway(config, { rateLimitStore });
	await gateway.start({ silent: true });
	baseUrl = `http://localhost:${gateway.port}`;
});

afterAll(async () => {
	await gateway?.stop();
	upstream?.stop();
});

// ── Lifecycle ────────────────────────────────────────────────────────────────

describe("gateway lifecycle", () => {
	test("gateway acquired a port and is listening", () => {
		expect(gateway.port).toBeGreaterThan(0);
	});
});

// ── Health ────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
	test("returns 200 with status ok", async () => {
		const res = await fetch(`${baseUrl}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

// ── Discovery ────────────────────────────────────────────────────────────────

describe("GET /.well-known/x402", () => {
	test("returns discovery metadata", async () => {
		const res = await fetch(`${baseUrl}/.well-known/x402`);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.x402Version).toBe(2);
		expect(body.provider).toBe("tollbooth");
		expect(body.endpoints).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					method: "GET",
					path: "/paid",
					accepts: expect.arrayContaining([
						expect.objectContaining({
							asset: "USDC",
							network: "base-sepolia",
						}),
					]),
				}),
			]),
		);
	});
});

// ── 404 ──────────────────────────────────────────────────────────────────────

describe("unmatched routes", () => {
	test("returns 404 with error JSON", async () => {
		const res = await fetch(`${baseUrl}/does-not-exist`);
		expect(res.status).toBe(404);

		const body = await res.json();
		expect(body.error).toMatch(/route not found/i);
	});
});

// ── Zero-price proxy ─────────────────────────────────────────────────────────

describe("zero-price routes (free proxy)", () => {
	test("GET /free proxies to upstream and returns body", async () => {
		const res = await fetch(`${baseUrl}/free`);
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.method).toBe("GET");
		expect(body.path).toBe("/free");
	});

	test("POST /free-post proxies body and rewrites path", async () => {
		const res = await fetch(`${baseUrl}/free-post`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ hello: "world" }),
		});
		expect(res.status).toBe(200);

		const body = await res.json();
		expect(body.method).toBe("POST");
		expect(body.path).toBe("/echo");
		expect(body.body).toContain("hello");
	});
});

// ── Paid route without payment ───────────────────────────────────────────────

describe("paid route without payment header", () => {
	test("returns 402 with payment-required header", async () => {
		const res = await fetch(`${baseUrl}/paid`);
		expect(res.status).toBe(402);

		const header = res.headers.get("payment-required");
		expect(header).toBeTruthy();
		if (!header) throw new Error("missing header");

		const requirements = decodePaymentRequired(header) as Array<{
			scheme: string;
			network: string;
			asset: string;
			maxAmountRequired: string;
			resource: string;
			payTo: string;
		}>;
		expect(Array.isArray(requirements)).toBe(true);
		expect(requirements.length).toBeGreaterThan(0);
		expect(requirements[0].network).toBe("base-sepolia");
		// asset is the on-chain contract address, not the symbol
		expect(requirements[0].asset).toBe(
			"0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		);
		expect(requirements[0].resource).toBe("/paid");
	});
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe("CORS", () => {
	const origin = "https://app.example.com";

	test("preflight returns 204 with CORS headers", async () => {
		const res = await fetch(`${baseUrl}/free`, {
			method: "OPTIONS",
			headers: {
				Origin: origin,
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "content-type",
			},
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe(origin);
		expect(res.headers.get("access-control-allow-credentials")).toBe("true");
		expect(res.headers.get("access-control-max-age")).toBe("600");
	});

	test("normal response includes CORS headers for allowed origin", async () => {
		const res = await fetch(`${baseUrl}/health`, {
			headers: { Origin: origin },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBe(origin);
	});

	test("disallowed origin gets no CORS headers", async () => {
		const res = await fetch(`${baseUrl}/health`, {
			headers: { Origin: "https://evil.example.com" },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});

// ── Rate limiting ────────────────────────────────────────────────────────────

describe("rate limiting", () => {
	test("allows requests within limit then returns 429", async () => {
		// First two requests should succeed (limit is 2)
		const res1 = await fetch(`${baseUrl}/rate-limited`);
		expect(res1.status).toBe(200);

		const res2 = await fetch(`${baseUrl}/rate-limited`);
		expect(res2.status).toBe(200);

		// Third request should be rate-limited
		const res3 = await fetch(`${baseUrl}/rate-limited`);
		expect(res3.status).toBe(429);

		const body = await res3.json();
		expect(body.error).toMatch(/too many requests/i);
		expect(res3.headers.get("retry-after")).toBeTruthy();
	});
});
