import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { interpolateEnv } from "../config/env.js";
import { tollboothConfigSchema } from "../config/schema.js";

describe("interpolateEnv", () => {
	beforeEach(() => {
		process.env.TEST_API_KEY = "sk-test-123";
		process.env.TEST_WALLET = "0xABC";
	});

	afterEach(() => {
		delete process.env.TEST_API_KEY;
		delete process.env.TEST_WALLET;
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
		expect(() => interpolateEnv("${MISSING_VAR}")).toThrow('Environment variable "MISSING_VAR" is not set');
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
		const result = tollboothConfigSchema.safeParse({ ...validConfig, accepts: [] });
		expect(result.success).toBe(false);
	});

	test("rejects invalid upstream url", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			upstreams: { api: { url: "not-a-url" } },
		});
		expect(result.success).toBe(false);
	});
});
