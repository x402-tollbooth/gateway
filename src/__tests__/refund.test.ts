import { afterEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";

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

let settleCalled = false;

function mockFacilitatorTracked(network: string) {
	settleCalled = false;
	return mockFacilitator({
		verify: () => Response.json({ isValid: true, payer: "0xabc" }),
		settle: () => {
			settleCalled = true;
			return Response.json({
				success: true,
				payer: "0xabc",
				transaction: "0xsettletx",
				network,
			});
		},
	});
}

const paymentSig = btoa(JSON.stringify({ x402Version: 2, payload: "mock" }));

function makeConfig(
	upstreamPort: number,
	facilitatorPort: number,
	options?: { settlement?: "before-response" | "after-response" },
): TollboothConfig {
	return {
		gateway: { port: 0, discovery: false },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: `http://localhost:${facilitatorPort}`,
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /test": {
				upstream: "api",
				price: "$0.01",
				settlement: options?.settlement,
			},
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("settlement strategy", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let facilitator: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
		facilitator?.stop();
	});

	// ── after-response: skip settlement on 5xx ──────────────────────────

	describe("after-response mode", () => {
		test("skips settlement on upstream 500", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Internal Server Error", { status: 500 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(500);
			expect(settleCalled).toBe(false);
			const skippedHeader = res.headers.get("x-tollbooth-settlement-skipped");
			expect(skippedHeader).toBeTruthy();
			const skipped = JSON.parse(skippedHeader as string);
			expect(skipped.reason).toBe("upstream_5xx");
		});

		test("skips settlement on upstream 502", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Bad Gateway", { status: 502 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(502);
			expect(settleCalled).toBe(false);
			expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeTruthy();
		});

		test("skips settlement on upstream 503", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Service Unavailable", { status: 503 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(503);
			expect(settleCalled).toBe(false);
			expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeTruthy();
		});

		// ── after-response: settle on success ───────────────────────────

		test("settles on upstream 200", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => Response.json({ ok: true }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(200);
			expect(settleCalled).toBe(true);
			expect(res.headers.get("payment-response")).toBeTruthy();
			expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeNull();
		});

		// ── after-response: settle on 4xx (client errors) ───────────────

		test("settles on upstream 400 (client error)", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Bad Request", { status: 400 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(400);
			expect(settleCalled).toBe(true);
			expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeNull();
		});

		test("settles on upstream 404", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Not Found", { status: 404 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(404);
			expect(settleCalled).toBe(true);
		});

		test("settles on upstream 422", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Unprocessable Entity", { status: 422 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(422);
			expect(settleCalled).toBe(true);
		});

		test("settles on upstream 429 (rate limited by upstream)", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Too Many Requests", { status: 429 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(429);
			expect(settleCalled).toBe(true);
		});

		// ── after-response: upstream connection failure ──────────────────

		test("skips settlement on upstream connection failure", async () => {
			const deadUpstreamPort = 19999;
			facilitator = mockFacilitatorTracked("base-sepolia");

			const config: TollboothConfig = {
				gateway: { port: 0, discovery: false },
				wallets: { "base-sepolia": "0xtest" },
				accepts: [{ asset: "USDC", network: "base-sepolia" }],
				defaults: { price: "$0.001", timeout: 60 },
				facilitator: `http://localhost:${facilitator.port}`,
				upstreams: {
					api: { url: `http://localhost:${deadUpstreamPort}`, timeout: 2000 },
				},
				routes: {
					"GET /test": {
						upstream: "api",
						price: "$0.01",
						settlement: "after-response",
					},
				},
			};

			gateway = createGateway(config);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(502);
			expect(settleCalled).toBe(false);
			const skippedHeader = res.headers.get("x-tollbooth-settlement-skipped");
			expect(skippedHeader).toBeTruthy();
			const skipped = JSON.parse(skippedHeader as string);
			expect(skipped.reason).toBe("upstream_unreachable");
		});

		// ── after-response: onError hook receives settlementSkipped ──────

		test("onError hook receives settlementSkipped context", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Internal Server Error", { status: 500 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			const hookPath = `${import.meta.dir}/_test_settlement_hook.ts`;
			const hookCalls: unknown[] = [];
			(globalThis as Record<string, unknown>).__settlementHookCalls = hookCalls;

			await Bun.write(
				hookPath,
				`export default async function(ctx) {
					(globalThis as any).__settlementHookCalls.push({
						hasSettlement: !!ctx.settlement,
						hasSettlementSkipped: !!ctx.settlementSkipped,
						skipReason: ctx.settlementSkipped?.reason,
						errorStatus: ctx.error?.status,
					});
				}`,
			);

			try {
				const config: TollboothConfig = {
					gateway: { port: 0, discovery: false },
					wallets: { "base-sepolia": "0xtest" },
					accepts: [{ asset: "USDC", network: "base-sepolia" }],
					defaults: { price: "$0.001", timeout: 60 },
					facilitator: `http://localhost:${facilitator.port}`,
					upstreams: { api: { url: `http://localhost:${upstream.port}` } },
					routes: {
						"GET /test": {
							upstream: "api",
							price: "$0.01",
							settlement: "after-response",
							hooks: { onError: hookPath },
						},
					},
				};

				gateway = createGateway(config);
				await gateway.start({ silent: true });

				await fetch(`http://localhost:${gateway.port}/test`, {
					headers: { "payment-signature": paymentSig },
				});

				expect(hookCalls.length).toBe(1);
				const call = hookCalls[0] as Record<string, unknown>;
				expect(call.hasSettlement).toBe(false);
				expect(call.hasSettlementSkipped).toBe(true);
				expect(call.skipReason).toBe("upstream_5xx");
				expect(call.errorStatus).toBe(500);
			} finally {
				const fs = await import("node:fs");
				fs.unlinkSync(hookPath);
				delete (globalThis as Record<string, unknown>).__settlementHookCalls;
			}
		});

		// ── after-response: onResponse hook can override settlement ──────

		test("onResponse hook can skip settlement on 200 with { settle: false }", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => Response.json({ ok: true }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			const hookPath = `${import.meta.dir}/_test_skip_settle_hook.ts`;
			await Bun.write(
				hookPath,
				`export default async function(ctx) {
					return { settle: false, reason: "hook_override" };
				}`,
			);

			try {
				const config: TollboothConfig = {
					gateway: { port: 0, discovery: false },
					wallets: { "base-sepolia": "0xtest" },
					accepts: [{ asset: "USDC", network: "base-sepolia" }],
					defaults: { price: "$0.001", timeout: 60 },
					facilitator: `http://localhost:${facilitator.port}`,
					upstreams: { api: { url: `http://localhost:${upstream.port}` } },
					routes: {
						"GET /test": {
							upstream: "api",
							price: "$0.01",
							settlement: "after-response",
							hooks: { onResponse: hookPath },
						},
					},
				};

				gateway = createGateway(config);
				await gateway.start({ silent: true });

				const res = await fetch(`http://localhost:${gateway.port}/test`, {
					headers: { "payment-signature": paymentSig },
				});

				expect(res.status).toBe(200);
				expect(settleCalled).toBe(false);
				const skipped = JSON.parse(
					res.headers.get("x-tollbooth-settlement-skipped") as string,
				);
				expect(skipped.reason).toBe("hook_override");
			} finally {
				const fs = await import("node:fs");
				fs.unlinkSync(hookPath);
			}
		});

		test("onResponse hook can force settlement on 500 with { settle: true }", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Internal Server Error", { status: 500 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			const hookPath = `${import.meta.dir}/_test_force_settle_hook.ts`;
			await Bun.write(
				hookPath,
				`export default async function(ctx) {
					return { settle: true };
				}`,
			);

			try {
				const config: TollboothConfig = {
					gateway: { port: 0, discovery: false },
					wallets: { "base-sepolia": "0xtest" },
					accepts: [{ asset: "USDC", network: "base-sepolia" }],
					defaults: { price: "$0.001", timeout: 60 },
					facilitator: `http://localhost:${facilitator.port}`,
					upstreams: { api: { url: `http://localhost:${upstream.port}` } },
					routes: {
						"GET /test": {
							upstream: "api",
							price: "$0.01",
							settlement: "after-response",
							hooks: { onResponse: hookPath },
						},
					},
				};

				gateway = createGateway(config);
				await gateway.start({ silent: true });

				const res = await fetch(`http://localhost:${gateway.port}/test`, {
					headers: { "payment-signature": paymentSig },
				});

				expect(res.status).toBe(500);
				expect(settleCalled).toBe(true);
				expect(res.headers.get("payment-response")).toBeTruthy();
				expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeNull();
			} finally {
				const fs = await import("node:fs");
				fs.unlinkSync(hookPath);
			}
		});
	});

	// ── before-response mode (default) ──────────────────────────────────

	describe("before-response mode (default)", () => {
		test("settles before proxy — upstream 500 still has payment-response header", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Internal Server Error", { status: 500 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(makeConfig(upstream.port, facilitator.port));
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(500);
			expect(settleCalled).toBe(true);
			expect(res.headers.get("payment-response")).toBeTruthy();
			expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeNull();
		});

		test("settles before proxy — upstream 200 has payment-response header", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => Response.json({ ok: true }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(makeConfig(upstream.port, facilitator.port));
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(200);
			expect(settleCalled).toBe(true);
			expect(res.headers.get("payment-response")).toBeTruthy();
		});

		test("no x-tollbooth-settlement-skipped header on any status", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => new Response("Bad Gateway", { status: 502 }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(makeConfig(upstream.port, facilitator.port));
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`, {
				headers: { "payment-signature": paymentSig },
			});

			expect(res.status).toBe(502);
			expect(res.headers.get("x-tollbooth-settlement-skipped")).toBeNull();
		});
	});

	// ── Common (no payment) ─────────────────────────────────────────────

	describe("common", () => {
		test("returns 402 when no payment header is present", async () => {
			upstream = Bun.serve({
				port: 0,
				fetch: () => Response.json({ ok: true }),
			});
			facilitator = mockFacilitatorTracked("base-sepolia");

			gateway = createGateway(
				makeConfig(upstream.port, facilitator.port, {
					settlement: "after-response",
				}),
			);
			await gateway.start({ silent: true });

			const res = await fetch(`http://localhost:${gateway.port}/test`);

			expect(res.status).toBe(402);
			expect(settleCalled).toBe(false);
		});
	});
});
