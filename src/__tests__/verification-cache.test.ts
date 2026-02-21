import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import { MemoryVerificationCacheStore } from "../verification-cache/store.js";

// ── MemoryVerificationCacheStore ────────────────────────────────────────────

describe("MemoryVerificationCacheStore", () => {
	let store: MemoryVerificationCacheStore;

	beforeEach(() => {
		store = new MemoryVerificationCacheStore();
	});

	afterEach(() => {
		store.destroy();
	});

	test("returns undefined for unknown key", async () => {
		const result = await store.get("unknown");
		expect(result).toBeUndefined();
	});

	test("stores and retrieves entry", async () => {
		await store.set("key1", { requirementIndex: 0 }, 60_000);
		const result = await store.get("key1");
		expect(result).toEqual({ requirementIndex: 0 });
	});

	test("isolates keys from each other", async () => {
		await store.set("key1", { requirementIndex: 0 }, 60_000);
		await store.set("key2", { requirementIndex: 1 }, 60_000);

		expect(await store.get("key1")).toEqual({ requirementIndex: 0 });
		expect(await store.get("key2")).toEqual({ requirementIndex: 1 });
	});

	test("expires entries after TTL", async () => {
		await store.set("key1", { requirementIndex: 0 }, 1);
		await Bun.sleep(5);
		const result = await store.get("key1");
		expect(result).toBeUndefined();
	});

	test("overwrites existing entries", async () => {
		await store.set("key1", { requirementIndex: 0 }, 60_000);
		await store.set("key1", { requirementIndex: 2 }, 60_000);
		const result = await store.get("key1");
		expect(result).toEqual({ requirementIndex: 2 });
	});
});

// ── Integration Tests ───────────────────────────────────────────────────────

function mockFacilitator(options: {
	verify: (req: Request) => Response | Promise<Response>;
	settle: (req: Request) => Response | Promise<Response>;
}): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/verify") return options.verify(req);
			if (url.pathname === "/settle") return options.settle(req);
			return new Response("Not found", { status: 404 });
		},
	});
}

const paymentSig = btoa(
	JSON.stringify({ payload: { authorization: { from: "0xTestPayer" } } }),
);

function makeConfig(
	upstreamPort: number,
	facilitatorPort: number,
	options?: {
		settlement?: "before-response" | "after-response";
		verificationCache?: { ttl: string };
		defaultVerificationCache?: { ttl: string };
	},
): TollboothConfig {
	return {
		gateway: { port: 0, discovery: false },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: {
			price: "$0.001",
			timeout: 60,
			verificationCache: options?.defaultVerificationCache,
		},
		facilitator: `http://localhost:${facilitatorPort}`,
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /test": {
				upstream: "api",
				price: "$0.01",
				settlement: options?.settlement,
				verificationCache: options?.verificationCache,
			},
		},
	};
}

describe("verification cache", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let facilitator: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;
	let verifyCallCount: number;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
		facilitator?.stop();
	});

	function setupServers(options?: {
		settlement?: "before-response" | "after-response";
		verificationCache?: { ttl: string };
		defaultVerificationCache?: { ttl: string };
	}) {
		verifyCallCount = 0;

		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator = mockFacilitator({
			verify: () => {
				verifyCallCount++;
				return Response.json({ isValid: true, payer: "0xTestPayer" });
			},
			settle: () =>
				Response.json({
					success: true,
					payer: "0xTestPayer",
					transaction: "0xtx",
					network: "base-sepolia",
				}),
		});

		return makeConfig(upstream.port, facilitator.port, options);
	}

	// ── before-response mode ────────────────────────────────────────────

	describe("before-response mode", () => {
		test("skips verification on cache hit", async () => {
			const config = setupServers({ verificationCache: { ttl: "60s" } });
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			// First request — verify is called
			const res1 = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			expect(res1.status).toBe(200);
			expect(verifyCallCount).toBe(1);

			// Second request — verify is skipped (cache hit)
			const res2 = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			expect(res2.status).toBe(200);
			expect(verifyCallCount).toBe(1); // Still 1 — cache hit
		});

		test("still settles each request individually", async () => {
			let settleCount = 0;

			upstream = Bun.serve({
				port: 0,
				fetch: () => Response.json({ ok: true }),
			});

			facilitator = mockFacilitator({
				verify: () => Response.json({ isValid: true, payer: "0xTestPayer" }),
				settle: () => {
					settleCount++;
					return Response.json({
						success: true,
						payer: "0xTestPayer",
						transaction: `0xtx${settleCount}`,
						network: "base-sepolia",
					});
				},
			});

			const config = makeConfig(upstream.port, facilitator.port, {
				verificationCache: { ttl: "60s" },
			});
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			// Two requests — both should settle
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(settleCount).toBe(2);
		});

		test("does not cache when no verificationCache configured", async () => {
			const config = setupServers(); // No verificationCache
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(verifyCallCount).toBe(2); // Both hit the facilitator
		});

		test("returns 402 on cache hit with no payment header", async () => {
			const config = setupServers({ verificationCache: { ttl: "60s" } });
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			// Warm cache
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			// Request without payment header — should still get 402
			const res = await fetch(`http://localhost:${gateway.port}/test`);
			expect(res.status).toBe(402);
		});

		test("re-verifies after cache TTL expires", async () => {
			const config = setupServers({
				verificationCache: { ttl: "1s" },
			});
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			// First request
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			expect(verifyCallCount).toBe(1);

			// Wait for cache to expire
			await Bun.sleep(1100);

			// Second request — must re-verify
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			expect(verifyCallCount).toBe(2);
		});
	});

	// ── after-response mode ─────────────────────────────────────────────

	describe("after-response mode", () => {
		test("skips verification on cache hit", async () => {
			const config = setupServers({
				settlement: "after-response",
				verificationCache: { ttl: "60s" },
			});
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			const res1 = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			expect(res1.status).toBe(200);
			expect(verifyCallCount).toBe(1);

			const res2 = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			expect(res2.status).toBe(200);
			expect(verifyCallCount).toBe(1); // Cache hit
		});
	});

	// ── defaults-level config ───────────────────────────────────────────

	describe("defaults-level config", () => {
		test("uses global default when no route-level cache configured", async () => {
			const config = setupServers({
				defaultVerificationCache: { ttl: "60s" },
			});
			gateway = createGateway(config);
			await gateway.start({ silent: true });

			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(verifyCallCount).toBe(1); // Cache hit on second request
		});
	});

	// ── pluggable store ─────────────────────────────────────────────────

	describe("pluggable store", () => {
		test("accepts a custom store via options", async () => {
			const customStore = new MemoryVerificationCacheStore();

			const config = setupServers({ verificationCache: { ttl: "60s" } });
			gateway = createGateway(config, {
				verificationCacheStore: customStore,
			});
			await gateway.start({ silent: true });

			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});
			await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(verifyCallCount).toBe(1); // Custom store used

			customStore.destroy();
		});
	});
});

// ── Config schema validation ────────────────────────────────────────────────

describe("verificationCache config schema", () => {
	const { tollboothConfigSchema } = require("../config/schema.js");

	const validConfig = {
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		upstreams: { api: { url: "https://api.example.com" } },
		routes: {
			"GET /test": { upstream: "api", price: "$0.01" },
		},
	};

	test("accepts route with verificationCache", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					verificationCache: { ttl: "60s" },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts global default verificationCache", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			defaults: {
				verificationCache: { ttl: "5m" },
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid ttl format", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					verificationCache: { ttl: "invalid" },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("rejects extra fields in verificationCache (strict)", () => {
		const result = tollboothConfigSchema.safeParse({
			...validConfig,
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					verificationCache: { ttl: "60s", extra: true },
				},
			},
		});
		expect(result.success).toBe(false);
	});

	test("verificationCache is optional (backwards compatible)", () => {
		const result = tollboothConfigSchema.safeParse(validConfig);
		expect(result.success).toBe(true);
	});
});
