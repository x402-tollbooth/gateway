import { afterEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";

function makePaymentSignature(payer: string): string {
	return btoa(
		JSON.stringify({
			payload: {
				authorization: {
					from: payer,
				},
			},
		}),
	);
}

describe("time pricing model", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let facilitator: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
		facilitator?.stop();
	});

	test("skips settlement but still verifies for active sessions", async () => {
		let verifyCalls = 0;
		let settleCalls = 0;

		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const { pathname } = new URL(req.url);
				if (pathname === "/verify") {
					verifyCalls++;
					return Response.json({ isValid: true, payer: "0xabc" });
				}
				if (pathname === "/settle") {
					settleCalls++;
					return Response.json({
						success: true,
						payer: "0xabc",
						transaction: "0xtx",
						network: "base-sepolia",
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${facilitator.port}`,
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: {
				"GET /feed/realtime": {
					upstream: "api",
					pricing: {
						model: "time",
						price: "$0.10",
						duration: "1h",
					},
				},
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		// 1) No payment header => still requires payment
		const first = await fetch(`http://localhost:${gateway.port}/feed/realtime`);
		expect(first.status).toBe(402);

		// 2) Paid request creates session
		const paymentSignature = makePaymentSignature("0xabc");
		const paid = await fetch(`http://localhost:${gateway.port}/feed/realtime`, {
			headers: { "payment-signature": paymentSignature },
		});
		expect(paid.status).toBe(200);
		expect(verifyCalls).toBe(1);
		expect(settleCalls).toBe(1);
		expect(paid.headers.get("payment-response")).toBeTruthy();

		// 3) Active session verifies signature but skips settlement
		const active = await fetch(
			`http://localhost:${gateway.port}/feed/realtime`,
			{
				headers: { "payment-signature": paymentSignature },
			},
		);
		expect(active.status).toBe(200);
		expect(verifyCalls).toBe(2); // signature still verified
		expect(settleCalls).toBe(1); // settlement skipped
		expect(active.headers.get("payment-response")).toBeNull();
	});

	test("requires payment again after session expiry", async () => {
		let verifyCalls = 0;
		let settleCalls = 0;

		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const { pathname } = new URL(req.url);
				if (pathname === "/verify") {
					verifyCalls++;
					return Response.json({ isValid: true, payer: "0xabc" });
				}
				if (pathname === "/settle") {
					settleCalls++;
					return Response.json({
						success: true,
						payer: "0xabc",
						transaction: "0xtx",
						network: "base-sepolia",
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${facilitator.port}`,
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: {
				"GET /feed/realtime": {
					upstream: "api",
					pricing: {
						model: "time",
						price: "$0.10",
						duration: "1s",
					},
				},
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const paymentSignature = makePaymentSignature("0xabc");

		const paid = await fetch(`http://localhost:${gateway.port}/feed/realtime`, {
			headers: { "payment-signature": paymentSignature },
		});
		expect(paid.status).toBe(200);
		expect(verifyCalls).toBe(1);
		expect(settleCalls).toBe(1);

		await Bun.sleep(1_100);

		const repaid = await fetch(
			`http://localhost:${gateway.port}/feed/realtime`,
			{
				headers: { "payment-signature": paymentSignature },
			},
		);
		expect(repaid.status).toBe(200);
		expect(verifyCalls).toBe(2);
		expect(settleCalls).toBe(2);
		expect(repaid.headers.get("payment-response")).toBeTruthy();
	});

	test("rejects forged payment-signature even with active session", async () => {
		let verifyCalls = 0;
		// Track the first legitimate payment payload so we can distinguish it
		let legitimatePayload: string | null = null;

		upstream = Bun.serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});

		facilitator = Bun.serve({
			port: 0,
			fetch: async (req) => {
				const { pathname } = new URL(req.url);
				const body = (await req.json()) as Record<string, unknown>;
				if (pathname === "/verify") {
					verifyCalls++;
					const payloadStr = JSON.stringify(body.paymentPayload);
					// First call: record the legitimate payload
					if (!legitimatePayload) {
						legitimatePayload = payloadStr;
						return Response.json({ isValid: true, payer: "0xlegit" });
					}
					// Subsequent calls: only accept if payload matches the original
					if (payloadStr === legitimatePayload) {
						return Response.json({ isValid: true, payer: "0xlegit" });
					}
					return Response.json({
						isValid: false,
						invalidReason: "invalid signature",
					});
				}
				if (pathname === "/settle") {
					return Response.json({
						success: true,
						payer: "0xlegit",
						transaction: "0xtx",
						network: "base-sepolia",
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${facilitator.port}`,
			upstreams: { api: { url: `http://localhost:${upstream.port}` } },
			routes: {
				"GET /feed/realtime": {
					upstream: "api",
					pricing: {
						model: "time",
						price: "$0.10",
						duration: "1h",
					},
				},
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		// 1) Legitimate payment creates a session for 0xlegit
		const legitSignature = makePaymentSignature("0xlegit");
		const paid = await fetch(`http://localhost:${gateway.port}/feed/realtime`, {
			headers: { "payment-signature": legitSignature },
		});
		expect(paid.status).toBe(200);
		expect(verifyCalls).toBe(1);

		// 2) Attacker forges a different payment-signature claiming to be 0xlegit
		// In reality, forged signatures differ from the original — the facilitator
		// performs cryptographic verification and rejects them.
		const forgedSignature = btoa(
			JSON.stringify({
				payload: { authorization: { from: "0xlegit" } },
				forged: true,
			}),
		);
		const forged = await fetch(
			`http://localhost:${gateway.port}/feed/realtime`,
			{
				headers: { "payment-signature": forgedSignature },
			},
		);
		// Session exists for 0xlegit but facilitator rejects the forged signature
		expect(forged.status).toBe(402);
		expect(verifyCalls).toBe(2); // both requests were verified by facilitator
	});
});
