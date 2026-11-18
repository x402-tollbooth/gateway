import { afterEach, describe, expect, test } from "vitest";
import { createGateway } from "../gateway.js";
import { getEffectiveRoutePricing } from "../pricing/config.js";
import { extractPricePeriod } from "../pricing/parser.js";
import { interpolateMemo, TempoSettlement } from "../settlement/tempo.js";
import type {
	PaymentRequirementsPayload,
	TollboothConfig,
	TollboothGateway,
} from "../types.js";
import {
	mockFacilitator,
	serve,
	type TestServer,
} from "./helpers/test-server.js";

const paymentSig = btoa(
	JSON.stringify({ x402Version: 2, payload: "mock", from: "0xCustomer" }),
);

let upstream: TestServer;
let facilitator: TestServer;
let gw: TollboothGateway;

afterEach(async () => {
	await gw?.stop();
	await upstream?.stop();
	await facilitator?.stop();
});

function makeRequirement(
	overrides: Partial<PaymentRequirementsPayload> = {},
): PaymentRequirementsPayload {
	return {
		scheme: "exact",
		network: "tempo-mainnet",
		maxAmountRequired: "10000000",
		resource: "/api/premium",
		description: "Premium API",
		payTo: "0xMerchant",
		maxTimeoutSeconds: 60,
		asset: "pathUSD",
		...overrides,
	};
}

describe("extractPricePeriod", () => {
	test("returns just amount when no period suffix", () => {
		expect(extractPricePeriod("$0.01")).toEqual({ amount: "$0.01" });
	});

	test("parses '$10/month' into amount + duration", () => {
		expect(extractPricePeriod("$10/month")).toEqual({
			amount: "$10",
			period: "month",
			duration: "30d",
		});
	});

	test("parses '$0.001/request' as per-request", () => {
		expect(extractPricePeriod("$0.001/request").duration).toBe("request");
	});

	test("throws on unknown period", () => {
		expect(() => extractPricePeriod("$10/fortnight")).toThrow(/period/i);
	});
});

describe("getEffectiveRoutePricing — periodic price", () => {
	test("derives time-based pricing from '$10/month'", () => {
		const eff = getEffectiveRoutePricing({
			upstream: "api",
			price: "$10/month",
		});
		expect(eff.model).toBe("time");
		expect(eff.duration).toBe("30d");
		expect(eff.price).toBe("$10");
	});

	test("explicit pricing.model wins over derived suffix", () => {
		const eff = getEffectiveRoutePricing({
			upstream: "api",
			price: "$10/month",
			pricing: { model: "request" },
		});
		expect(eff.model).toBe("request");
	});
});

describe("interpolateMemo", () => {
	test("substitutes known tokens", () => {
		const out = interpolateMemo(
			{ invoice_id: "{customerId}-{period}" },
			{ customerId: "0xabc", period: "month" },
		);
		expect(out.invoice_id).toBe("0xabc-month");
	});

	test("snake_case {customer_id} placeholder works in templates", () => {
		const out = interpolateMemo(
			{ invoice_id: "{customer_id}-{period}" },
			{ customer_id: "0xabc", period: "month" },
		);
		expect(out.invoice_id).toBe("0xabc-month");
	});

	test("leaves unknown tokens as-is", () => {
		const out = interpolateMemo(
			{ note: "{customerId} on {chain}" },
			{ customerId: "0xabc" },
		);
		expect(out.note).toBe("0xabc on {chain}");
	});

	test("returns empty object for empty template", () => {
		expect(interpolateMemo({}, { customerId: "0xabc" })).toEqual({});
	});
});

describe("TempoSettlement — strategy unit", () => {
	test("settle() attaches customerId, memo, attribution to SettlementInfo", async () => {
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xCustomer" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xCustomer",
					transaction: "0xTempoTx",
					network: "tempo-mainnet",
				}),
		});

		const strategy = new TempoSettlement({
			network: "mainnet",
			recipient: "0xMerchant",
			token: "pathUSD",
			url: `http://localhost:${facilitator.port}`,
			recurring: { interval: "monthly", autoPay: true },
			memo: { invoice_id: "{customerId}-{period}" },
		});

		const verification = await strategy.verify(
			{ x402Version: 2, payload: "mock", from: "0xCustomer" },
			[makeRequirement()],
		);
		const settlement = await strategy.settle(verification);

		expect(settlement.payer).toBe("0xCustomer");
		expect(settlement.transaction).toBe("0xTempoTx");
		expect(settlement.customerId).toBe("0xcustomer");
		expect(settlement.memo).toEqual({ invoice_id: "0xcustomer-month" });
		expect(settlement.attribution).toEqual({
			recipient: "0xMerchant",
			token: "pathUSD",
			network: "mainnet",
			recurring: { interval: "monthly", autoPay: true },
		});
	});

	test("constructor throws when recipient missing", () => {
		expect(() => new TempoSettlement({ recipient: "" } as never)).toThrow(
			/recipient/i,
		);
	});

	test("settle() omits memo when template is empty", async () => {
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xCustomer" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xCustomer",
					transaction: "0xTx",
					network: "tempo-mainnet",
				}),
		});

		const strategy = new TempoSettlement({
			recipient: "0xMerchant",
			url: `http://localhost:${facilitator.port}`,
		});

		const v = await strategy.verify(
			{ x402Version: 2, payload: "mock", from: "0xCustomer" },
			[makeRequirement()],
		);
		const s = await strategy.settle(v);

		expect(s.memo).toBeUndefined();
		expect(s.attribution).toBeDefined();
	});
});

describe("Tempo settlement — config validation", () => {
	test("rejects tempo strategy without recipient", async () => {
		const { tollboothConfigSchema } = await import("../config/schema.js");

		const result = tollboothConfigSchema.safeParse({
			gateway: { port: 3000 },
			wallets: { "tempo-mainnet": "0xtest" },
			accepts: [{ asset: "pathUSD", network: "tempo-mainnet" }],
			defaults: { price: "$0.001", timeout: 60 },
			upstreams: { api: { url: "http://localhost:8080" } },
			routes: { "GET /test": { upstream: "api" } },
			settlement: { strategy: "tempo" },
		});
		expect(result.success).toBe(false);
	});

	test("accepts a complete tempo config", async () => {
		const { tollboothConfigSchema } = await import("../config/schema.js");

		const result = tollboothConfigSchema.safeParse({
			gateway: { port: 3000 },
			wallets: { "tempo-mainnet": "0xtest" },
			accepts: [{ asset: "pathUSD", network: "tempo-mainnet" }],
			defaults: { price: "$0.001", timeout: 60 },
			upstreams: { api: { url: "http://localhost:8080" } },
			routes: {
				"GET /api/premium": { upstream: "api", price: "$10/month" },
			},
			settlement: {
				strategy: "tempo",
				tempo: {
					network: "mainnet",
					token: "pathUSD",
					recipient: "0xMerchant",
					recurring: { interval: "monthly", autoPay: true },
					memo: { invoice_id: "{customerId}-{period}" },
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("rejects unknown recurring interval", async () => {
		const { tollboothConfigSchema } = await import("../config/schema.js");

		const result = tollboothConfigSchema.safeParse({
			gateway: { port: 3000 },
			wallets: { "tempo-mainnet": "0xtest" },
			accepts: [{ asset: "pathUSD", network: "tempo-mainnet" }],
			defaults: { price: "$0.001", timeout: 60 },
			upstreams: { api: { url: "http://localhost:8080" } },
			routes: { "GET /api/premium": { upstream: "api" } },
			settlement: {
				strategy: "tempo",
				tempo: {
					recipient: "0xMerchant",
					recurring: { interval: "fortnightly" },
				},
			},
		});
		expect(result.success).toBe(false);
	});
});

describe("Tempo settlement — end-to-end via gateway", () => {
	test("first request settles, repeat within window skips settle", async () => {
		let settleCalls = 0;
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xCustomer" }),
			settle: () => {
				settleCalls++;
				return Response.json({
					success: true,
					payer: "0xCustomer",
					transaction: "0xTempoTx",
					network: "tempo-mainnet",
				});
			},
		});

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "tempo-mainnet": "0xMerchant" },
			accepts: [{ asset: "pathUSD", network: "tempo-mainnet" }],
			defaults: { price: "$0.001", timeout: 60 },
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: {
				"GET /api/premium": { upstream: "api", price: "$10/month" },
			},
			settlement: {
				strategy: "tempo",
				tempo: {
					network: "mainnet",
					recipient: "0xMerchant",
					url: `http://localhost:${facilitator.port}`,
					recurring: { interval: "monthly", autoPay: true },
					memo: { invoice_id: "{customerId}-{period}" },
				},
			},
		};

		gw = createGateway(config);
		await gw.start({ silent: true });

		const first = await fetch(`http://localhost:${gw.port}/api/premium`, {
			headers: { "payment-signature": paymentSig },
		});
		expect(first.status).toBe(200);
		expect(settleCalls).toBe(1);

		const second = await fetch(`http://localhost:${gw.port}/api/premium`, {
			headers: { "payment-signature": paymentSig },
		});
		expect(second.status).toBe(200);
		// Recurring window still active — no second settle call.
		expect(settleCalls).toBe(1);
	});
});
