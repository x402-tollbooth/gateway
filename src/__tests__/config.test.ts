import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { interpolateEnv } from "../config/env.js";
import { loadConfig } from "../config/loader.js";
import { tollboothConfigSchema } from "../config/schema.js";

describe("interpolateEnv", () => {
	beforeEach(() => {
		process.env.TEST_API_KEY = "sk-test-123";
		process.env.TEST_WALLET = "0xABC";
	});

	afterEach(() => {
		process.env.TEST_API_KEY = undefined;
		process.env.TEST_WALLET = undefined;
	});

	test("interpolates env vars in strings", () => {
		const result = interpolateEnv("Bearer ${TEST_API_KEY}");
		expect(result).toBe("Bearer sk-test-123");
	});

	test("interpolates env vars in nested objects", () => {
		const result = interpolateEnv({
			headers: { authorization: "Bearer ${TEST_API_KEY}" },
			wallet: "${TEST_WALLET}",
		});
		expect(result).toEqual({
			headers: { authorization: "Bearer sk-test-123" },
			wallet: "0xABC",
		});
	});

	test("throws on missing env var", () => {
		expect(() => interpolateEnv("${MISSING_VAR}")).toThrow(
			'Environment variable "MISSING_VAR" is not set',
		);
	});

	test("passes through non-string values", () => {
		expect(interpolateEnv(42)).toBe(42);
		expect(interpolateEnv(true)).toBe(true);
		expect(interpolateEnv(null)).toBe(null);
	});
});

describe("tollboothConfigSchema", () => {
	const validConfig = {
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		upstreams: {
			api: { url: "https://api.example.com" },
		},
		routes: {
			"GET /test": {
				upstream: "api",
				price: "$0.01",
			},
		},
	};

	test("validates a minimal valid config", () => {
		const result = tollboothConfigSchema.safeParse(validConfig);
		expect(result.success).toBe(true);
	});

	test("applies defaults", () => {
		const result = tollboothConfigSchema.parse(validConfig);
		expect(result.gateway.port).toBe(3000);
		expect(result.gateway.discovery).toBe(true);
		expect(result.defaults.price).toBe("$0.001");
		expect(result.defaults.timeout).toBe(60);
	});

	test("rejects missing wallets", () => {
		const { wallets, ...noWallets } = validConfig;
		const result = tollboothConfigSchema.safeParse(noWallets);
		expect(result.success).toBe(false);
	});

	test("rejects empty accepts", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			accepts: [],
		});
		expect(result.success).toBe(false);
	});

	test("accepts route with freeform metadata", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					metadata: {
						category: "medical",
						capabilities: ["diagnosis", "drug-interaction"],
						model: "llama-3-medical",
						sla: { avg_response_ms: 2000 },
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid upstream url", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			upstreams: { api: { url: "not-a-url" } },
		});
		expect(result.success).toBe(false);
	});

	test("accepts top-level facilitator url", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: "https://custom-facilitator.example.com",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.facilitator).toBe(
				"https://custom-facilitator.example.com",
			);
		}
	});

	test("accepts route-level facilitator url", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					facilitator: "https://route-facilitator.example.com",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid facilitator url at top level", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			facilitator: "not-a-url",
		});
		expect(result.success).toBe(false);
	});

	test("rejects invalid facilitator url at route level", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					facilitator: "not-a-url",
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("facilitator is optional (backwards compatible)", () => {
		const result = tollboothConfigSchema.safeParse(validConfig);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.facilitator).toBeUndefined();
		}
	});
});

describe("loadConfig error formatting", () => {
	test("formats missing required field with suggestion", () => {
		expect(() => loadConfig("/dev/null")).toThrow(/Invalid tollbooth config/);
	});

	test("formats invalid URL with suggestion", () => {
		const { mkdtempSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const dir = mkdtempSync(join(require("node:os").tmpdir(), "tb-"));
		const file = join(dir, "tollbooth.config.json");
		writeFileSync(
			file,
			JSON.stringify({
				wallets: { base: "0xtest" },
				accepts: [{ asset: "USDC", network: "base" }],
				upstreams: { api: { url: "not-a-url" } },
				routes: { "GET /test": { upstream: "api" } },
			}),
		);
		try {
			loadConfig(file);
		} catch (e: unknown) {
			const msg = (e as Error).message;
			expect(msg).toContain("upstreams.api.url");
			expect(msg).toContain("→");
			expect(msg).toContain("valid URL");
		}
	});

	test("formats empty accepts array with suggestion", () => {
		const { mkdtempSync, writeFileSync } = require("node:fs");
		const { join } = require("node:path");
		const dir = mkdtempSync(join(require("node:os").tmpdir(), "tb-"));
		const file = join(dir, "tollbooth.config.json");
		writeFileSync(
			file,
			JSON.stringify({
				wallets: { base: "0xtest" },
				accepts: [],
				upstreams: { api: { url: "https://api.example.com" } },
				routes: { "GET /test": { upstream: "api" } },
			}),
		);
		try {
			loadConfig(file);
		} catch (e: unknown) {
			const msg = (e as Error).message;
			expect(msg).toContain("accepts");
			expect(msg).toContain("→");
			expect(msg).toContain("at least");
		}
	});
});
