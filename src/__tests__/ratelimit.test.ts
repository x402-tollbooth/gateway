import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	checkRateLimit,
	extractIdentity,
	resolveRateLimit,
} from "../ratelimit/check.js";
import { RedisRateLimitStore } from "../ratelimit/redis-store.js";
import { MemoryRateLimitStore, parseWindow } from "../ratelimit/store.js";
import type { RateLimitConfig, TollboothConfig } from "../types.js";
import { MockRedisClient } from "./helpers/mock-redis.js";

// ── parseWindow ──────────────────────────────────────────────────────────────

describe("parseWindow", () => {
	test("parses seconds", () => {
		expect(parseWindow("30s")).toBe(30_000);
	});

	test("parses minutes", () => {
		expect(parseWindow("5m")).toBe(300_000);
	});

	test("parses hours", () => {
		expect(parseWindow("1h")).toBe(3_600_000);
	});

	test("parses days", () => {
		expect(parseWindow("1d")).toBe(86_400_000);
	});

	test("throws on invalid format", () => {
		expect(() => parseWindow("10")).toThrow("Invalid rate limit window");
		expect(() => parseWindow("abc")).toThrow("Invalid rate limit window");
		expect(() => parseWindow("")).toThrow("Invalid rate limit window");
	});
});

// ── MemoryRateLimitStore ─────────────────────────────────────────────────────

describe("MemoryRateLimitStore", () => {
	let store: MemoryRateLimitStore;

	beforeEach(() => {
		store = new MemoryRateLimitStore();
	});

	afterEach(() => {
		store.destroy();
	});

	test("allows requests under the limit", async () => {
		const result = await store.check("key1", 3, 60_000);
		expect(result.allowed).toBe(true);
		expect(result.remaining).toBe(2);
		expect(result.limit).toBe(3);
	});

	test("tracks remaining count correctly", async () => {
		await store.check("key1", 3, 60_000);
		const r2 = await store.check("key1", 3, 60_000);
		expect(r2.remaining).toBe(1);

		const r3 = await store.check("key1", 3, 60_000);
		expect(r3.remaining).toBe(0);
		expect(r3.allowed).toBe(true);
	});

	test("denies requests over the limit", async () => {
		await store.check("key1", 2, 60_000);
		await store.check("key1", 2, 60_000);

		const r3 = await store.check("key1", 2, 60_000);
		expect(r3.allowed).toBe(false);
		expect(r3.remaining).toBe(0);
		expect(r3.resetMs).toBeGreaterThan(0);
	});

	test("isolates keys from each other", async () => {
		await store.check("key1", 1, 60_000);
		const r1denied = await store.check("key1", 1, 60_000);
		expect(r1denied.allowed).toBe(false);

		const r2allowed = await store.check("key2", 1, 60_000);
		expect(r2allowed.allowed).toBe(true);
	});

	test("expires old entries after window passes", async () => {
		// Use a very short window
		await store.check("key1", 1, 1);
		// Wait for window to expire
		await Bun.sleep(5);
		const result = await store.check("key1", 1, 1);
		expect(result.allowed).toBe(true);
	});
});

describe("RedisRateLimitStore", () => {
	let redis: MockRedisClient;
	let storeA: RedisRateLimitStore;
	let storeB: RedisRateLimitStore;

	beforeEach(() => {
		redis = new MockRedisClient();
		storeA = new RedisRateLimitStore(redis, { prefix: "test:rate" });
		storeB = new RedisRateLimitStore(redis, { prefix: "test:rate" });
	});

	afterEach(() => {
		storeA.close();
		storeB.close();
	});

	test("shares limits across store instances", async () => {
		const r1 = await storeA.check("key1", 1, 1_000);
		expect(r1.allowed).toBe(true);

		const r2 = await storeB.check("key1", 1, 1_000);
		expect(r2.allowed).toBe(false);
		expect(r2.remaining).toBe(0);
		expect(r2.resetMs).toBeGreaterThan(0);
	});

	test("expires counters after the window", async () => {
		await storeA.check("key1", 1, 10);
		await Bun.sleep(20);

		const result = await storeB.check("key1", 1, 10);
		expect(result.allowed).toBe(true);
	});
});

// ── extractIdentity ──────────────────────────────────────────────────────────

describe("extractIdentity", () => {
	test("extracts payer from payment-signature header (nested)", () => {
		const payload = {
			payload: { authorization: { from: "0xABC123" } },
		};
		const header = btoa(JSON.stringify(payload));
		const req = new Request("http://localhost/test", {
			headers: { "payment-signature": header },
		});
		expect(extractIdentity(req)).toBe("payer:0xabc123");
	});

	test("extracts payer from top-level from field", () => {
		const payload = { from: "0xDEF456" };
		const header = btoa(JSON.stringify(payload));
		const req = new Request("http://localhost/test", {
			headers: { "payment-signature": header },
		});
		expect(extractIdentity(req)).toBe("payer:0xdef456");
	});

	test("uses remote client ip by default", () => {
		const req = new Request("http://localhost/test");
		expect(extractIdentity(req, { remoteIp: "198.51.100.10" })).toBe(
			"ip:198.51.100.10",
		);
	});

	test("does not trust forwarded headers by default", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "203.0.113.50, 70.41.3.18" },
		});
		expect(extractIdentity(req, { remoteIp: "10.0.0.5" })).toBe("ip:10.0.0.5");
	});

	test("uses forwarded headers when trustProxy is enabled", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "203.0.113.50, 70.41.3.18" },
		});
		expect(
			extractIdentity(req, {
				remoteIp: "10.0.0.5",
				trustProxy: true,
			}),
		).toBe("ip:203.0.113.50");
	});

	test("returns ip:unknown when no identity available", () => {
		const req = new Request("http://localhost/test");
		expect(extractIdentity(req)).toBe("ip:unknown");
	});

	test("falls back to IP on malformed payment header", () => {
		const req = new Request("http://localhost/test", {
			headers: {
				"payment-signature": "not-valid-base64!!!",
				"x-forwarded-for": "1.2.3.4",
			},
		});
		expect(
			extractIdentity(req, {
				remoteIp: "10.0.0.5",
				trustProxy: true,
			}),
		).toBe("ip:1.2.3.4");
	});
});

// ── resolveRateLimit ─────────────────────────────────────────────────────────

describe("resolveRateLimit", () => {
	const baseConfig = {
		defaults: { price: "$0.001", timeout: 60 },
	} as TollboothConfig;

	test("returns undefined when no rate limit configured", () => {
		expect(resolveRateLimit(undefined, baseConfig)).toBeUndefined();
	});

	test("returns global default when no route override", () => {
		const config = {
			...baseConfig,
			defaults: {
				...baseConfig.defaults,
				rateLimit: { requests: 100, window: "1m" },
			},
		} as TollboothConfig;
		expect(resolveRateLimit(undefined, config)).toEqual({
			requests: 100,
			window: "1m",
		});
	});

	test("route-level overrides global default", () => {
		const config = {
			...baseConfig,
			defaults: {
				...baseConfig.defaults,
				rateLimit: { requests: 100, window: "1m" },
			},
		} as TollboothConfig;
		const routeLimit: RateLimitConfig = { requests: 10, window: "30s" };
		expect(resolveRateLimit(routeLimit, config)).toEqual({
			requests: 10,
			window: "30s",
		});
	});
});

// ── checkRateLimit ───────────────────────────────────────────────────────────

describe("checkRateLimit", () => {
	let store: MemoryRateLimitStore;

	beforeEach(() => {
		store = new MemoryRateLimitStore();
	});

	afterEach(() => {
		store.destroy();
	});

	test("composes key from route and identity", async () => {
		const rl: RateLimitConfig = { requests: 1, window: "1m" };

		// Same identity, same route — should be denied on second call
		await checkRateLimit(store, "payer:0xabc", "POST /api", rl);
		const r2 = await checkRateLimit(store, "payer:0xabc", "POST /api", rl);
		expect(r2.allowed).toBe(false);

		// Same identity, different route — should be allowed
		const r3 = await checkRateLimit(store, "payer:0xabc", "GET /other", rl);
		expect(r3.allowed).toBe(true);

		// Different identity, same route — should be allowed
		const r4 = await checkRateLimit(store, "payer:0xdef", "POST /api", rl);
		expect(r4.allowed).toBe(true);
	});
});

// ── Config schema validation ─────────────────────────────────────────────────

describe("rateLimit config schema", () => {
	const { tollboothConfigSchema } = require("../config/schema.js");

	const validConfig = {
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		upstreams: { api: { url: "https://api.example.com" } },
		routes: {
			"GET /test": { upstream: "api", price: "$0.01" },
		},
	};

	test("accepts route with rateLimit", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					rateLimit: { requests: 10, window: "1m" },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts global default rateLimit", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			defaults: {
				rateLimit: { requests: 100, window: "5m" },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid window format", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					rateLimit: { requests: 10, window: "invalid" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects non-positive requests", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					rateLimit: { requests: 0, window: "1m" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects extra fields in rateLimit (strict)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					rateLimit: { requests: 10, window: "1m", extra: true },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rateLimit is optional (backwards compatible)", () => {
		const result = tollboothConfigSchema.safeParse(validConfig);
		expect(result.success).toBe(true);
	});
});
