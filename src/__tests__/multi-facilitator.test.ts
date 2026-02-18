import { describe, expect, test } from "bun:test";
import { tollboothConfigSchema } from "../config/schema.js";
import { generateDiscoveryMetadata } from "../discovery/metadata.js";
import type { TollboothConfig } from "../types.js";
import { resolveFacilitatorUrl } from "../x402/facilitator.js";

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
