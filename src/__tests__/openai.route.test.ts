import { describe, expect, test } from "bun:test";
import { extractModel, resolveOpenAIPrice } from "../openai/handler.js";
import { DEFAULT_MODEL_PRICES } from "../pricing/models.js";
import { routeNeedsBody } from "../proxy/body-buffer.js";
import type { RouteConfig, TollboothConfig } from "../types.js";

// ── extractModel ─────────────────────────────────────────────────────────────

describe("extractModel", () => {
	test("extracts model from chat completions body", () => {
		expect(
			extractModel({
				model: "gpt-4o",
				messages: [{ role: "user", content: "hi" }],
			}),
		).toBe("gpt-4o");
	});

	test("extracts model from completions body", () => {
		expect(
			extractModel({
				model: "gpt-3.5-turbo",
				prompt: "Once upon a time",
			}),
		).toBe("gpt-3.5-turbo");
	});

	test("returns undefined for missing model", () => {
		expect(extractModel({ messages: [] })).toBeUndefined();
	});

	test("returns undefined for empty model string", () => {
		expect(extractModel({ model: "" })).toBeUndefined();
	});

	test("returns undefined for non-string model", () => {
		expect(extractModel({ model: 42 })).toBeUndefined();
	});

	test("returns undefined for null body", () => {
		expect(extractModel(null)).toBeUndefined();
	});

	test("returns undefined for undefined body", () => {
		expect(extractModel(undefined)).toBeUndefined();
	});

	test("returns undefined for non-object body", () => {
		expect(extractModel("string body")).toBeUndefined();
	});
});

// ── resolveOpenAIPrice ───────────────────────────────────────────────────────

describe("resolveOpenAIPrice", () => {
	const baseConfig: TollboothConfig = {
		gateway: { port: 3000, discovery: true },
		wallets: { base: "0xWALLET" },
		accepts: [{ asset: "USDC", network: "base" }],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: { openai: { url: "https://api.openai.com" } },
		routes: {},
	};

	const baseRoute: RouteConfig = {
		upstream: "openai",
		type: "token-based",
	};

	test("resolves price from default table for known model", () => {
		const result = resolveOpenAIPrice("gpt-4o", baseRoute, baseConfig);
		expect(result.model).toBe("gpt-4o");
		expect(result.amount).toBe(10000n); // $0.01 = 10000 units (USDC 6 decimals)
		expect(result.asset).toBe("USDC");
		expect(result.network).toBe("base");
	});

	test("resolves price for gpt-4o-mini from default table", () => {
		const result = resolveOpenAIPrice("gpt-4o-mini", baseRoute, baseConfig);
		expect(result.amount).toBe(1000n); // $0.001
	});

	test("user override takes precedence over default table", () => {
		const route: RouteConfig = {
			...baseRoute,
			models: { "gpt-4o": "$0.05" },
		};
		const result = resolveOpenAIPrice("gpt-4o", route, baseConfig);
		expect(result.amount).toBe(50000n); // $0.05
	});

	test("user can add pricing for custom/unknown models", () => {
		const route: RouteConfig = {
			...baseRoute,
			models: { "my-custom-model": "$0.02" },
		};
		const result = resolveOpenAIPrice("my-custom-model", route, baseConfig);
		expect(result.amount).toBe(20000n); // $0.02
	});

	test("falls back to route.price for unknown model", () => {
		const route: RouteConfig = {
			...baseRoute,
			price: "$0.005",
		};
		const result = resolveOpenAIPrice("unknown-model-xyz", route, baseConfig);
		expect(result.amount).toBe(5000n); // $0.005
	});

	test("falls back to route.fallback for unknown model", () => {
		const route: RouteConfig = {
			...baseRoute,
			fallback: "$0.003",
		};
		const result = resolveOpenAIPrice("unknown-model-xyz", route, baseConfig);
		expect(result.amount).toBe(3000n); // $0.003
	});

	test("falls back to config.defaults.price for unknown model", () => {
		const result = resolveOpenAIPrice(
			"unknown-model-xyz",
			baseRoute,
			baseConfig,
		);
		expect(result.amount).toBe(1000n); // $0.001 (default)
	});

	test("uses route payTo when set", () => {
		const route: RouteConfig = {
			...baseRoute,
			payTo: "0xCUSTOM",
		};
		const result = resolveOpenAIPrice("gpt-4o", route, baseConfig);
		expect(result.payTo).toBe("0xCUSTOM");
	});

	test("uses wallet from config when no route payTo", () => {
		const result = resolveOpenAIPrice("gpt-4o", baseRoute, baseConfig);
		expect(result.payTo).toBe("0xWALLET");
	});
});

// ── Default pricing table ────────────────────────────────────────────────────

describe("DEFAULT_MODEL_PRICES", () => {
	test("contains common OpenAI models", () => {
		expect(DEFAULT_MODEL_PRICES["gpt-4o"]).toBeDefined();
		expect(DEFAULT_MODEL_PRICES["gpt-4o-mini"]).toBeDefined();
		expect(DEFAULT_MODEL_PRICES["gpt-3.5-turbo"]).toBeDefined();
	});

	test("all prices are valid dollar format strings", () => {
		for (const [_model, price] of Object.entries(DEFAULT_MODEL_PRICES)) {
			expect(price).toMatch(/^\$\d+\.\d+$/);
		}
	});
});

// ── routeNeedsBody ───────────────────────────────────────────────────────────

describe("routeNeedsBody for token-based", () => {
	test("returns true for token-based routes", () => {
		expect(routeNeedsBody({ upstream: "openai", type: "token-based" })).toBe(
			true,
		);
	});

	test("returns true for openai-compatible routes (deprecated alias)", () => {
		expect(
			routeNeedsBody({ upstream: "openai", type: "openai-compatible" }),
		).toBe(true);
	});

	test("returns false for standard routes without body match rules", () => {
		expect(routeNeedsBody({ upstream: "api", price: "$0.01" })).toBe(false);
	});
});

// ── Schema validation ────────────────────────────────────────────────────────

describe("config schema with token-based route", () => {
	const { tollboothConfigSchema } = require("../config/schema.js");

	const validConfig = {
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		upstreams: { openai: { url: "https://api.openai.com" } },
		routes: {
			"POST /v1/chat/completions": {
				upstream: "openai",
				type: "token-based",
			},
		},
	};

	test("accepts type: token-based", () => {
		const result = tollboothConfigSchema.safeParse(validConfig);
		expect(result.success).toBe(true);
	});

	test("accepts type: openai-compatible (deprecated alias)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"POST /v1/chat/completions": {
					upstream: "openai",
					type: "openai-compatible",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts type: token-based with models override", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"POST /v1/chat/completions": {
					upstream: "openai",
					type: "token-based",
					models: {
						"gpt-4o": "$0.05",
						"gpt-4o-mini": "$0.005",
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid type value", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"POST /v1/chat/completions": {
					upstream: "openai",
					type: "invalid-type",
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("routes without type still work (backwards compatible)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "openai",
					price: "$0.01",
				},
			},
		});
		expect(result.success).toBe(true);
	});
});
