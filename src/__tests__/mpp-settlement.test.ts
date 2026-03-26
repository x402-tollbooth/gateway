import { afterEach, describe, expect, test } from "vitest";
import { createGateway } from "../gateway.js";
import { base64UrlEncode } from "../mpp/headers.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import {
	mockFacilitator,
	serve,
	type TestServer,
} from "./helpers/test-server.js";

const paymentSig = btoa(
	JSON.stringify({ x402Version: 2, payload: "mock", from: "0xTestPayer" }),
);

let upstream: TestServer;
let facilitator: TestServer;
let gw: TollboothGateway;

function makeConfig(
	upstreamPort: number,
	facilitatorPort: number,
): TollboothConfig {
	return {
		gateway: { port: 0, discovery: false },
		wallets: { "base-sepolia": "0xTestWallet" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /paid": { upstream: "api", price: "$0.01" },
		},
		settlement: {
			strategy: "mpp",
			url: `http://localhost:${facilitatorPort}`,
			methods: [{ type: "tempo" }],
		},
	};
}

afterEach(async () => {
	await gw?.stop();
	await upstream?.stop();
	await facilitator?.stop();
});

describe("MPP settlement strategy", () => {
	test("402 response includes both x402 and MPP headers", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xTestPayer" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xTestPayer",
					transaction: "0xtx",
					network: "base-sepolia",
				}),
		});

		const config = makeConfig(upstream.port, facilitator.port);
		gw = createGateway(config);
		await gw.start({ silent: true });

		const res = await fetch(`http://localhost:${gw.port}/paid`);
		expect(res.status).toBe(402);

		// x402 header present
		expect(res.headers.get("payment-required")).toBeTruthy();

		// MPP header present
		const wwwAuth = res.headers.get("www-authenticate");
		expect(wwwAuth).toBeTruthy();
		expect(wwwAuth).toContain("Payment");
		expect(wwwAuth).toContain('method="tempo"');
		expect(wwwAuth).toContain('intent="charge"');
	});

	test("accepts x402 payment-signature with MPP strategy", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xTestPayer" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xTestPayer",
					transaction: "0xtx",
					network: "base-sepolia",
				}),
		});

		const config = makeConfig(upstream.port, facilitator.port);
		gw = createGateway(config);
		await gw.start({ silent: true });

		const res = await fetch(`http://localhost:${gw.port}/paid`, {
			headers: { "payment-signature": paymentSig },
		});
		expect(res.status).toBe(200);

		// Both receipt headers present
		expect(res.headers.get("payment-response")).toBeTruthy();
		expect(res.headers.get("payment-receipt")).toBeTruthy();
	});

	test("accepts MPP Authorization: Payment header", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xTestPayer" }),
			settle: () =>
				Response.json({
					success: true,
					payer: "0xTestPayer",
					transaction: "0xtx",
					network: "base-sepolia",
				}),
		});

		const config = makeConfig(upstream.port, facilitator.port);
		gw = createGateway(config);
		await gw.start({ silent: true });

		// Build an MPP credential
		const payload = base64UrlEncode(
			JSON.stringify({
				x402Version: 2,
				payload: "mock",
				from: "0xTestPayer",
			}),
		);
		const mppAuth = `Payment id="test-challenge", payload="${payload}"`;

		const res = await fetch(`http://localhost:${gw.port}/paid`, {
			headers: { Authorization: mppAuth },
		});
		expect(res.status).toBe(200);

		// Both receipt headers present
		expect(res.headers.get("payment-response")).toBeTruthy();
		expect(res.headers.get("payment-receipt")).toBeTruthy();
	});

	test("config validation requires methods for mpp strategy", async () => {
		const { tollboothConfigSchema } = await import("../config/schema.js");

		const result = tollboothConfigSchema.safeParse({
			gateway: { port: 3000 },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			upstreams: { api: { url: "http://localhost:8080" } },
			routes: { "GET /test": { upstream: "api" } },
			settlement: { strategy: "mpp" },
		});
		expect(result.success).toBe(false);
	});

	test("config validation accepts valid mpp config", async () => {
		const { tollboothConfigSchema } = await import("../config/schema.js");

		const result = tollboothConfigSchema.safeParse({
			gateway: { port: 3000 },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			upstreams: { api: { url: "http://localhost:8080" } },
			routes: { "GET /test": { upstream: "api" } },
			settlement: {
				strategy: "mpp",
				methods: [
					{ type: "tempo" },
					{ type: "stripe", secretKey: "sk_test_xxx" },
				],
			},
		});
		expect(result.success).toBe(true);
	});
});
