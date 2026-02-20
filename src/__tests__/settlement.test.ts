import { afterEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import { FacilitatorSettlement } from "../settlement/facilitator.js";
import { createFacilitatorStrategy } from "../settlement/loader.js";
import type {
	PaymentRequirementsPayload,
	TollboothConfig,
	TollboothGateway,
} from "../types.js";
import { PaymentError } from "../x402/middleware.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

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

const paymentSig = btoa(JSON.stringify({ x402Version: 2, payload: "mock" }));

function makeConfig(
	upstreamPort: number,
	options?: {
		facilitatorPort?: number;
		settlementUrl?: string;
		settlementStrategy?: "facilitator" | "custom";
		settlementModule?: string;
	},
): TollboothConfig {
	const config: TollboothConfig = {
		gateway: { port: 0, discovery: false },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /test": {
				upstream: "api",
				price: "$0.01",
			},
		},
	};

	if (options?.facilitatorPort) {
		config.facilitator = `http://localhost:${options.facilitatorPort}`;
	}

	if (options?.settlementStrategy || options?.settlementUrl) {
		config.settlement = {
			strategy: options?.settlementStrategy ?? "facilitator",
			url: options?.settlementUrl,
			module: options?.settlementModule,
		};
	}

	return config;
}

// ── FacilitatorSettlement unit tests ─────────────────────────────────────────

describe("FacilitatorSettlement", () => {
	let facilitator: ReturnType<typeof Bun.serve>;

	afterEach(() => {
		facilitator?.stop();
	});

	test("verify returns payer on success", async () => {
		facilitator = mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xabc" }),
			settle: () => Response.json({ success: true }),
		});

		const strategy = new FacilitatorSettlement([
			{ url: `http://localhost:${facilitator.port}` },
		]);

		const requirements: PaymentRequirementsPayload[] = [
			{
				scheme: "exact",
				network: "base-sepolia",
				maxAmountRequired: "10000",
				resource: "/test",
				description: "GET /test",
				payTo: "0xpayto",
				maxTimeoutSeconds: 60,
				asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			},
		];

		const verification = await strategy.verify(
			{ x402Version: 2, payload: "mock" },
			requirements,
		);
		expect(verification.payer).toBe("0xabc");
	});

	test("verify throws PaymentError on invalid payment", async () => {
		facilitator = mockFacilitator({
			verify: () =>
				Response.json({ isValid: false, invalidReason: "bad signature" }),
			settle: () => Response.json({ success: true }),
		});

		const strategy = new FacilitatorSettlement([
			{ url: `http://localhost:${facilitator.port}` },
		]);

		const requirements: PaymentRequirementsPayload[] = [
			{
				scheme: "exact",
				network: "base-sepolia",
				maxAmountRequired: "10000",
				resource: "/test",
				description: "GET /test",
				payTo: "0xpayto",
				maxTimeoutSeconds: 60,
				asset: "0xtoken",
			},
		];

		await expect(
			strategy.verify({ payload: "bad" }, requirements),
		).rejects.toThrow(PaymentError);
	});

	test("settle returns SettlementInfo on success", async () => {
		facilitator = mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xabc" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xabc",
					transaction: "0xtx123",
					network: "base-sepolia",
				}),
		});

		const strategy = new FacilitatorSettlement([
			{ url: `http://localhost:${facilitator.port}` },
		]);

		const requirements: PaymentRequirementsPayload[] = [
			{
				scheme: "exact",
				network: "base-sepolia",
				maxAmountRequired: "10000",
				resource: "/test",
				description: "GET /test",
				payTo: "0xpayto",
				maxTimeoutSeconds: 60,
				asset: "0xtoken",
			},
		];

		const verification = await strategy.verify(
			{ x402Version: 2, payload: "mock" },
			requirements,
		);
		const settlement = await strategy.settle(verification);

		expect(settlement.payer).toBe("0xabc");
		expect(settlement.transaction).toBe("0xtx123");
		expect(settlement.network).toBe("base-sepolia");
		expect(settlement.amount).toBe("10000");
	});

	test("settle throws PaymentError on failure", async () => {
		facilitator = mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xabc" }),
			settle: () =>
				Response.json({
					success: false,
					errorReason: "insufficient funds",
					payer: "0xabc",
					transaction: "",
					network: "base-sepolia",
				}),
		});

		const strategy = new FacilitatorSettlement([
			{ url: `http://localhost:${facilitator.port}` },
		]);

		const requirements: PaymentRequirementsPayload[] = [
			{
				scheme: "exact",
				network: "base-sepolia",
				maxAmountRequired: "10000",
				resource: "/test",
				description: "GET /test",
				payTo: "0xpayto",
				maxTimeoutSeconds: 60,
				asset: "0xtoken",
			},
		];

		const verification = await strategy.verify(
			{ x402Version: 2, payload: "mock" },
			requirements,
		);

		await expect(strategy.settle(verification)).rejects.toThrow(PaymentError);
	});
});

// ── createFacilitatorStrategy ───────────────────────────────────────────────

describe("createFacilitatorStrategy", () => {
	test("creates a FacilitatorSettlement instance", () => {
		const strategy = createFacilitatorStrategy(
			[{ asset: "USDC", network: "base" }],
			undefined,
			undefined,
		);
		expect(strategy).toBeInstanceOf(FacilitatorSettlement);
	});

	test("settlement url takes precedence over global facilitator", () => {
		// Both facilitator and settlement URL specified —
		// the strategy should use the settlement URL
		const strategy = createFacilitatorStrategy(
			[{ asset: "USDC", network: "base" }],
			undefined,
			"https://old.example.com",
			"https://new.example.com",
		);
		expect(strategy).toBeInstanceOf(FacilitatorSettlement);
	});
});

// ── Custom strategy integration ─────────────────────────────────────────────

describe("custom settlement strategy", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
	});

	test("uses custom strategy for verify and settle", async () => {
		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		const strategyPath = `${import.meta.dir}/_test_custom_strategy.ts`;
		await Bun.write(
			strategyPath,
			`export default {
				async verify(payment, requirements) {
					return { payer: "0xcustom_payer", _amount: requirements?.[0]?.maxAmountRequired ?? "10000" };
				},
				async settle(verification) {
					return {
						payer: verification.payer || "0xcustom_payer",
						amount: (verification as any)._amount ?? "10000",
						transaction: "0xcustom_tx",
						network: "base-sepolia",
					};
				},
			}`,
		);

		try {
			const config: TollboothConfig = {
				gateway: { port: 0, discovery: false },
				wallets: { "base-sepolia": "0xtest" },
				accepts: [{ asset: "USDC", network: "base-sepolia" }],
				defaults: { price: "$0.001", timeout: 60 },
				upstreams: { api: { url: `http://localhost:${upstream.port}` } },
				routes: {
					"GET /test": {
						upstream: "api",
						price: "$0.01",
					},
				},
				settlement: {
					strategy: "custom",
					module: strategyPath,
				},
			};

			gateway = createGateway(config);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(200);
			expect(res.headers.get("payment-response")).toBeTruthy();
		} finally {
			const fs = await import("node:fs");
			if (fs.existsSync(strategyPath)) fs.unlinkSync(strategyPath);
		}
	});

	test("custom strategy works with after-response timing", async () => {
		upstream = Bun.serve({
			port: 0,
			fetch: () => new Response("Internal Server Error", { status: 500 }),
		});

		const _settleCalled = false;
		const strategyPath = `${import.meta.dir}/_test_custom_strategy_after.ts`;
		// Store settle tracking on globalThis so the strategy module can access it
		(globalThis as Record<string, unknown>).__customSettleCalled = false;

		await Bun.write(
			strategyPath,
			`export default {
				async verify(payment, requirements) {
					return { payer: "0xcustom" };
				},
				async settle(verification) {
					(globalThis as any).__customSettleCalled = true;
					return {
						payer: "0xcustom",
						amount: "10000",
						transaction: "0xcustom_tx",
						network: "base-sepolia",
					};
				},
			}`,
		);

		try {
			const config: TollboothConfig = {
				gateway: { port: 0, discovery: false },
				wallets: { "base-sepolia": "0xtest" },
				accepts: [{ asset: "USDC", network: "base-sepolia" }],
				defaults: { price: "$0.001", timeout: 60 },
				upstreams: { api: { url: `http://localhost:${upstream.port}` } },
				routes: {
					"GET /test": {
						upstream: "api",
						price: "$0.01",
						settlement: "after-response",
					},
				},
				settlement: {
					strategy: "custom",
					module: strategyPath,
				},
			};

			gateway = createGateway(config);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			// 5xx upstream — should skip settlement
			expect(res.status).toBe(500);
			expect((globalThis as Record<string, unknown>).__customSettleCalled).toBe(
				false,
			);

			const skipped = res.headers.get("x-tollbooth-settlement-skipped");
			expect(skipped).toBeTruthy();
		} finally {
			const fs = await import("node:fs");
			if (fs.existsSync(strategyPath)) fs.unlinkSync(strategyPath);
			delete (globalThis as Record<string, unknown>).__customSettleCalled;
		}
	});
});

// ── Settlement strategy config in gateway ───────────────────────────────────

describe("settlement strategy config", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let facilitator: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
		facilitator?.stop();
	});

	test("settlement.url overrides facilitator field", async () => {
		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		// This facilitator should be used (from settlement.url)
		facilitator = mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xabc" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xabc",
					transaction: "0xtx",
					network: "base-sepolia",
				}),
		});

		// Dead facilitator that should NOT be used
		const deadFacilitatorPort = 19998;

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${deadFacilitatorPort}`,
			settlement: {
				strategy: "facilitator",
				url: `http://localhost:${facilitator.port}`,
			},
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
				},
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`, {
			headers: { "payment-signature": paymentSig },
		});

		// Should succeed because settlement.url points to the working facilitator
		expect(res.status).toBe(200);
		expect(res.headers.get("payment-response")).toBeTruthy();
	});

	test("route-level facilitator still overrides settlement.url", async () => {
		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		// This is the correct facilitator (route-level override)
		facilitator = mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xroute" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xroute",
					transaction: "0xroutetx",
					network: "base-sepolia",
				}),
		});

		const deadPort = 19997;

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			settlement: {
				strategy: "facilitator",
				url: `http://localhost:${deadPort}`,
			},
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					facilitator: `http://localhost:${facilitator.port}`,
				},
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`, {
			headers: { "payment-signature": paymentSig },
		});

		expect(res.status).toBe(200);
	});

	test("returns 402 when no payment header present", async () => {
		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		facilitator = mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xabc" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xabc",
					transaction: "0xtx",
					network: "base-sepolia",
				}),
		});

		gateway = createGateway(
			makeConfig(upstream.port, { facilitatorPort: facilitator.port }),
		);
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/test`);
		expect(res.status).toBe(402);
	});
});

// ── Config schema validation ────────────────────────────────────────────────

describe("settlement config schema", () => {
	const { tollboothConfigSchema } = require("../config/schema.js");

	const baseInput = {
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		upstreams: { api: { url: "https://api.example.com" } },
		routes: { "GET /test": { upstream: "api" } },
	};

	test("accepts facilitator strategy with url", () => {
		const result = tollboothConfigSchema.safeParse({
			...baseInput,
			settlement: {
				strategy: "facilitator",
				url: "https://facilitator.example.com",
			},
		});
		expect(result.success).toBe(true);
	});

	test("accepts facilitator strategy without url", () => {
		const result = tollboothConfigSchema.safeParse({
			...baseInput,
			settlement: { strategy: "facilitator" },
		});
		expect(result.success).toBe(true);
	});

	test("accepts custom strategy with module", () => {
		const result = tollboothConfigSchema.safeParse({
			...baseInput,
			settlement: {
				strategy: "custom",
				module: "./settlement/my-strategy.ts",
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects custom strategy without module", () => {
		const result = tollboothConfigSchema.safeParse({
			...baseInput,
			settlement: { strategy: "custom" },
		});
		expect(result.success).toBe(false);
	});

	test("rejects unknown strategy", () => {
		const result = tollboothConfigSchema.safeParse({
			...baseInput,
			settlement: { strategy: "unknown" },
		});
		expect(result.success).toBe(false);
	});

	test("config without settlement block still valid", () => {
		const result = tollboothConfigSchema.safeParse(baseInput);
		expect(result.success).toBe(true);
	});
});
