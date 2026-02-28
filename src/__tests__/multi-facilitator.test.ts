import { afterEach, describe, expect, test } from "vitest";
import { tollboothConfigSchema } from "../config/schema.js";
import { generateDiscoveryMetadata } from "../discovery/metadata.js";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import { resolveFacilitatorUrl } from "../x402/facilitator.js";
import { serve, mockFacilitator, type TestServer } from "./helpers/test-server.js";

// ── resolveFacilitatorUrl ──────────────────────────────────────────────────

describe("resolveFacilitatorUrl", () => {
	const HARDCODED = "https://x402.org/facilitator";

	test("returns hardcoded default when nothing configured", () => {
		expect(resolveFacilitatorUrl("base", "usdc")).toBe(HARDCODED);
	});

	test("returns global string facilitator", () => {
		expect(
			resolveFacilitatorUrl(
				"base",
				"usdc",
				undefined,
				"https://global.example.com",
			),
		).toBe("https://global.example.com");
	});

	test("route string overrides global string", () => {
		expect(
			resolveFacilitatorUrl(
				"base",
				"usdc",
				"https://route.example.com",
				"https://global.example.com",
			),
		).toBe("https://route.example.com");
	});

	test("global chain-specific overrides global default", () => {
		expect(
			resolveFacilitatorUrl("solana", "usdc", undefined, {
				default: "https://global-default.example.com",
				chains: {
					"solana/usdc": "https://solana.example.com",
				},
			}),
		).toBe("https://solana.example.com");
	});

	test("global mapping falls back to default when chain not matched", () => {
		expect(
			resolveFacilitatorUrl("ethereum", "usdc", undefined, {
				default: "https://global-default.example.com",
				chains: {
					"solana/usdc": "https://solana.example.com",
				},
			}),
		).toBe("https://global-default.example.com");
	});

	test("route chain-specific overrides everything", () => {
		expect(
			resolveFacilitatorUrl(
				"solana",
				"usdc",
				{
					default: "https://route-default.example.com",
					chains: { "solana/usdc": "https://route-solana.example.com" },
				},
				{
					default: "https://global-default.example.com",
					chains: { "solana/usdc": "https://global-solana.example.com" },
				},
			),
		).toBe("https://route-solana.example.com");
	});

	test("route default overrides global chain-specific", () => {
		expect(
			resolveFacilitatorUrl(
				"solana",
				"usdc",
				{ default: "https://route-default.example.com" },
				{
					chains: { "solana/usdc": "https://global-solana.example.com" },
				},
			),
		).toBe("https://route-default.example.com");
	});

	test("case-insensitive chain key matching", () => {
		expect(
			resolveFacilitatorUrl("Base", "USDC", undefined, {
				chains: { "base/usdc": "https://base.example.com" },
			}),
		).toBe("https://base.example.com");
	});

	test("route mapping with unmatched chain and no default falls through to global", () => {
		expect(
			resolveFacilitatorUrl(
				"ethereum",
				"usdc",
				{ chains: { "solana/usdc": "https://route-solana.example.com" } },
				{
					chains: {
						"ethereum/usdc": "https://global-eth.example.com",
					},
				},
			),
		).toBe("https://global-eth.example.com");
	});

	test("empty mapping object falls through to hardcoded default", () => {
		expect(resolveFacilitatorUrl("base", "usdc", {}, {})).toBe(HARDCODED);
	});

	test("full fallback chain: route chain → route default → global chain → global default → hardcoded", () => {
		// Only hardcoded
		expect(resolveFacilitatorUrl("base", "usdc")).toBe(HARDCODED);

		// Global default
		expect(
			resolveFacilitatorUrl("base", "usdc", undefined, {
				default: "https://g-default.example.com",
			}),
		).toBe("https://g-default.example.com");

		// Global chain overrides global default
		expect(
			resolveFacilitatorUrl("base", "usdc", undefined, {
				default: "https://g-default.example.com",
				chains: { "base/usdc": "https://g-chain.example.com" },
			}),
		).toBe("https://g-chain.example.com");

		// Route default overrides global
		expect(
			resolveFacilitatorUrl(
				"base",
				"usdc",
				{ default: "https://r-default.example.com" },
				{
					default: "https://g-default.example.com",
					chains: { "base/usdc": "https://g-chain.example.com" },
				},
			),
		).toBe("https://r-default.example.com");

		// Route chain overrides everything
		expect(
			resolveFacilitatorUrl(
				"base",
				"usdc",
				{
					default: "https://r-default.example.com",
					chains: { "base/usdc": "https://r-chain.example.com" },
				},
				{
					default: "https://g-default.example.com",
					chains: { "base/usdc": "https://g-chain.example.com" },
				},
			),
		).toBe("https://r-chain.example.com");
	});
});

// ── Config schema validation ───────────────────────────────────────────────

describe("facilitator mapping schema", () => {
	const validConfig = {
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		upstreams: { api: { url: "https://api.example.com" } },
		routes: { "GET /test": { upstream: "api", price: "$0.01" } },
	};

	test("accepts facilitator mapping at top level", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: {
				default: "https://default.example.com",
				chains: {
					"base/usdc": "https://base.example.com",
					"solana/usdc": "https://solana.example.com",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts facilitator mapping at route level", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					facilitator: {
						default: "https://route-default.example.com",
						chains: { "solana/usdc": "https://solana.example.com" },
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts string facilitator (backwards compat)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: "https://custom.example.com",
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid URL in chains mapping", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: {
				chains: { "base/usdc": "not-a-url" },
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects invalid URL in mapping default", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: { default: "not-a-url" },
		});
		expect(result.success).toBe(false);
	});

	test("accepts mapping with only chains (no default)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: {
				chains: { "base/usdc": "https://base.example.com" },
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts mapping with only default (no chains)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: { default: "https://default.example.com" },
		});
		expect(result.success).toBe(true);
	});
});

// ── Discovery metadata ─────────────────────────────────────────────────────

describe("multi-facilitator discovery metadata", () => {
	const baseConfig: TollboothConfig = {
		gateway: { port: 3000, discovery: true },
		wallets: { base: "0xtest" },
		accepts: [
			{ asset: "USDC", network: "base" },
			{ asset: "USDC", network: "solana" },
		],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: { api: { url: "https://api.example.com" } },
		routes: {
			"GET /test": { upstream: "api", price: "$0.01" },
		},
	};

	test("each accepts entry gets the correct facilitator", () => {
		const config: TollboothConfig = {
			...baseConfig,
			facilitator: {
				default: "https://default.example.com",
				chains: {
					"base/usdc": "https://base.example.com",
					"solana/usdc": "https://solana.example.com",
				},
			},
		};
		const metadata = generateDiscoveryMetadata(config);
		const ep = metadata.endpoints[0];

		const baseAccept = ep.accepts.find((a) => a.network === "base");
		const solanaAccept = ep.accepts.find((a) => a.network === "solana");

		expect(baseAccept?.facilitator).toBe("https://base.example.com");
		expect(solanaAccept?.facilitator).toBe("https://solana.example.com");
	});

	test("accepts entries fall back to default facilitator", () => {
		const config: TollboothConfig = {
			...baseConfig,
			facilitator: {
				default: "https://default.example.com",
				chains: {
					"base/usdc": "https://base.example.com",
				},
			},
		};
		const metadata = generateDiscoveryMetadata(config);
		const ep = metadata.endpoints[0];

		const solanaAccept = ep.accepts.find((a) => a.network === "solana");
		expect(solanaAccept?.facilitator).toBe("https://default.example.com");
	});

	test("route-level facilitator mapping overrides global", () => {
		const config: TollboothConfig = {
			...baseConfig,
			facilitator: {
				chains: {
					"base/usdc": "https://global-base.example.com",
					"solana/usdc": "https://global-solana.example.com",
				},
			},
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					facilitator: {
						chains: {
							"base/usdc": "https://route-base.example.com",
						},
					},
				},
			},
		};
		const metadata = generateDiscoveryMetadata(config);
		const ep = metadata.endpoints[0];

		const baseAccept = ep.accepts.find((a) => a.network === "base");
		const solanaAccept = ep.accepts.find((a) => a.network === "solana");

		// Route-level chain-specific overrides global
		expect(baseAccept?.facilitator).toBe("https://route-base.example.com");
		// No route-level for solana → falls through to global chain-specific
		expect(solanaAccept?.facilitator).toBe("https://global-solana.example.com");
	});

	test("backward compat: string facilitator still works in discovery", () => {
		const config: TollboothConfig = {
			...baseConfig,
			accepts: [{ asset: "USDC", network: "base" }],
			facilitator: "https://custom.example.com",
		};
		const metadata = generateDiscoveryMetadata(config);
		const ep = metadata.endpoints[0];

		expect(ep.facilitator).toBe("https://custom.example.com");
		expect(ep.accepts[0].facilitator).toBe("https://custom.example.com");
	});

	test("endpoint-level facilitator field uses first accept's facilitator", () => {
		const config: TollboothConfig = {
			...baseConfig,
			facilitator: {
				chains: {
					"base/usdc": "https://base.example.com",
					"solana/usdc": "https://solana.example.com",
				},
			},
		};
		const metadata = generateDiscoveryMetadata(config);
		const ep = metadata.endpoints[0];

		// Top-level facilitator is the first accept's
		expect(ep.facilitator).toBe("https://base.example.com");
	});
});

// ── Gateway integration: multi-facilitator payment flow ─────────────────────

function alwaysApprove(network: string) {
	return mockFacilitator({
		verify: () => Response.json({ isValid: true, payer: "0xabc" }),
		settle: () =>
			Response.json({
				success: true,
				payer: "0xabc",
				transaction: "0xtx",
				network,
			}),
	});
}

function alwaysReject() {
	return mockFacilitator({
		verify: () =>
			Response.json({ isValid: false, invalidReason: "wrong network" }),
		settle: () => Response.json({ success: false }),
	});
}

describe("multi-facilitator gateway integration", () => {
	let upstream: TestServer;
	let facilitator1: TestServer;
	let facilitator2: TestServer;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
		facilitator1?.stop();
		facilitator2?.stop();
	});

	const paymentSig = btoa(JSON.stringify({ x402Version: 2, payload: "mock" }));

	test("payment succeeds when second facilitator verifies", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		// First facilitator rejects, second accepts
		facilitator1 = await alwaysReject();
		facilitator2 = await alwaysApprove("solana");

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { base: "0xtest", solana: "0xtest" },
			accepts: [
				{ asset: "USDC", network: "base" },
				{ asset: "USDC", network: "solana" },
			],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: {
				chains: {
					"base/usdc": `http://localhost:${facilitator1.port}`,
					"solana/usdc": `http://localhost:${facilitator2.port}`,
				},
			},
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: { "GET /test": { upstream: "api", price: "$0.01" } },
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`, {
			headers: { "payment-signature": paymentSig },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("payment-response")).toBeTruthy();
	});

	test("payment fails when all facilitators reject", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator1 = await alwaysReject();
		facilitator2 = await alwaysReject();

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { base: "0xtest", solana: "0xtest" },
			accepts: [
				{ asset: "USDC", network: "base" },
				{ asset: "USDC", network: "solana" },
			],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: {
				chains: {
					"base/usdc": `http://localhost:${facilitator1.port}`,
					"solana/usdc": `http://localhost:${facilitator2.port}`,
				},
			},
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: { "GET /test": { upstream: "api", price: "$0.01" } },
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`, {
			headers: { "payment-signature": paymentSig },
		});

		expect(res.status).toBe(402);
	});

	test("settlement failure does not try next facilitator", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		// Verifies OK but settlement fails
		facilitator1 = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xabc" }),
			settle: () =>
				Response.json({
					success: false,
					errorReason: "insufficient funds",
				}),
		});
		// Would succeed — but should never be reached
		facilitator2 = await alwaysApprove("solana");

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { base: "0xtest", solana: "0xtest" },
			accepts: [
				{ asset: "USDC", network: "base" },
				{ asset: "USDC", network: "solana" },
			],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: {
				chains: {
					"base/usdc": `http://localhost:${facilitator1.port}`,
					"solana/usdc": `http://localhost:${facilitator2.port}`,
				},
			},
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: { "GET /test": { upstream: "api", price: "$0.01" } },
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`, {
			headers: { "payment-signature": paymentSig },
		});

		// Settlement failure → 502, not retried with next facilitator
		expect(res.status).toBe(502);
	});

	test("single facilitator still works (backward compat)", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator1 = await alwaysApprove("base-sepolia");

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${facilitator1.port}`,
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: { "GET /test": { upstream: "api", price: "$0.01" } },
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`, {
			headers: { "payment-signature": paymentSig },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("payment-response")).toBeTruthy();
	});

	test("no payment header returns 402 with per-chain facilitators in discovery", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator1 = await alwaysApprove("base");

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: true },
			wallets: { base: "0xtest" },
			accepts: [{ asset: "USDC", network: "base" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: {
				chains: {
					"base/usdc": `http://localhost:${facilitator1.port}`,
				},
			},
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: { "GET /test": { upstream: "api", price: "$0.01" } },
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		// No payment header → 402
		const res = await fetch(`http://localhost:${gateway.port}/test`);
		expect(res.status).toBe(402);

		// Discovery shows per-chain facilitator
		const discovery = await fetch(
			`http://localhost:${gateway.port}/.well-known/x402`,
		);
		const meta = await discovery.json();
		expect(meta.endpoints[0].accepts[0].facilitator).toBe(
			`http://localhost:${facilitator1.port}`,
		);
	});
});
