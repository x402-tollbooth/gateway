import { describe, expect, test } from "vitest";
import {
	buildRedisStorePrefix,
	resolveRedisStoreConfig,
} from "../store/resolve.js";
import type { TollboothConfig } from "../types.js";

function makeConfig(): TollboothConfig {
	return {
		gateway: { port: 3000, discovery: false },
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: { api: { url: "https://api.example.com" } },
		routes: {
			"GET /test": { upstream: "api", price: "$0.01" },
		},
	};
}

describe("resolveRedisStoreConfig", () => {
	test("returns undefined when backend is memory", () => {
		const config = makeConfig();
		expect(resolveRedisStoreConfig(config, "rateLimit")).toBeUndefined();
	});

	test("uses global redis settings", () => {
		const config: TollboothConfig = {
			...makeConfig(),
			stores: {
				redis: {
					url: "redis://localhost:6379",
					prefix: "my-app",
					options: { connectionTimeout: 5_000 },
				},
				rateLimit: { backend: "redis" },
			},
		};

		expect(resolveRedisStoreConfig(config, "rateLimit")).toEqual({
			url: "redis://localhost:6379",
			prefix: "my-app",
			options: { connectionTimeout: 5_000 },
		});
	});

	test("allows store-level overrides", () => {
		const config: TollboothConfig = {
			...makeConfig(),
			stores: {
				redis: {
					url: "redis://localhost:6379",
					prefix: "shared",
					options: { autoReconnect: true },
				},
				verificationCache: {
					backend: "redis",
					redis: {
						url: "redis://cache.example.com:6379",
						prefix: "vc",
						options: { maxRetries: 20 },
					},
				},
			},
		};

		expect(resolveRedisStoreConfig(config, "verificationCache")).toEqual({
			url: "redis://cache.example.com:6379",
			prefix: "vc",
			options: { autoReconnect: true, maxRetries: 20 },
		});
	});

	test("throws when redis backend has no URL", () => {
		const config: TollboothConfig = {
			...makeConfig(),
			stores: {
				timeSession: { backend: "redis" },
			},
		};

		expect(() => resolveRedisStoreConfig(config, "timeSession")).toThrow(
			'stores.timeSession.backend is "redis" but no Redis URL is configured',
		);
	});
});

describe("buildRedisStorePrefix", () => {
	test("builds prefixed keys by store", () => {
		expect(buildRedisStorePrefix("tb", "rateLimit")).toBe("tb:rate-limit");
		expect(buildRedisStorePrefix("tb", "verificationCache")).toBe(
			"tb:verification-cache",
		);
		expect(buildRedisStorePrefix("tb", "timeSession")).toBe("tb:time-session");
	});
});
