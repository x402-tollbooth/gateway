import { afterEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";

function makeConfig(upstreamPort: number): TollboothConfig {
	return {
		gateway: {
			port: 0,
			discovery: true,
			cors: {
				allowedOrigins: [
					"https://app.example.com",
					"https://admin.example.com",
				],
				allowedMethods: ["GET", "POST"],
				allowedHeaders: ["content-type", "payment-signature"],
				exposedHeaders: ["payment-required", "payment-response"],
				credentials: true,
				maxAge: 600,
			},
		},
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: "http://localhost:9999", // unreachable on purpose
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes: {
			"GET /paid": { upstream: "api", price: "$0.01" },
		},
	};
}

describe("gateway CORS", () => {
	let upstream: ReturnType<typeof Bun.serve>;
	let gateway: TollboothGateway;
	const allowedOrigin = "https://app.example.com";

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
	});

	test("applies CORS headers to proxied and built-in endpoints", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const paidRes = await fetch(`http://localhost:${gateway.port}/paid`, {
			headers: { Origin: allowedOrigin },
		});
		expect(paidRes.status).toBe(402);
		expect(paidRes.headers.get("access-control-allow-origin")).toBe(
			allowedOrigin,
		);
		expect(paidRes.headers.get("access-control-expose-headers")).toContain(
			"payment-required",
		);

		const healthRes = await fetch(`http://localhost:${gateway.port}/health`, {
			headers: { Origin: allowedOrigin },
		});
		expect(healthRes.status).toBe(200);
		expect(healthRes.headers.get("access-control-allow-origin")).toBe(
			allowedOrigin,
		);

		const discoveryRes = await fetch(
			`http://localhost:${gateway.port}/.well-known/x402`,
			{ headers: { Origin: allowedOrigin } },
		);
		expect(discoveryRes.status).toBe(200);
		expect(discoveryRes.headers.get("access-control-allow-origin")).toBe(
			allowedOrigin,
		);

		const openapiRes = await fetch(
			`http://localhost:${gateway.port}/.well-known/openapi.json`,
			{ headers: { Origin: allowedOrigin } },
		);
		expect(openapiRes.status).toBe(200);
		expect(openapiRes.headers.get("access-control-allow-origin")).toBe(
			allowedOrigin,
		);
	});

	test("handles preflight OPTIONS for paywalled and gateway endpoints", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const endpoints = [
			"/paid",
			"/health",
			"/.well-known/x402",
			"/.well-known/openapi.json",
		];

		for (const path of endpoints) {
			const res = await fetch(`http://localhost:${gateway.port}${path}`, {
				method: "OPTIONS",
				headers: {
					Origin: allowedOrigin,
					"Access-Control-Request-Method": "GET",
					"Access-Control-Request-Headers": "content-type,payment-signature",
				},
			});

			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe(
				allowedOrigin,
			);
			expect(res.headers.get("access-control-allow-methods")).toContain("GET");
			expect(res.headers.get("access-control-allow-headers")).toContain(
				"payment-signature",
			);
			expect(res.headers.get("access-control-allow-credentials")).toBe("true");
			expect(res.headers.get("access-control-max-age")).toBe("600");
		}
	});

	test("rejects preflight when requested headers are not allowed", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/paid`, {
			method: "OPTIONS",
			headers: {
				Origin: allowedOrigin,
				"Access-Control-Request-Method": "GET",
				"Access-Control-Request-Headers": "x-custom-not-allowed",
			},
		});

		expect(res.status).toBe(403);
		expect(res.headers.get("access-control-allow-origin")).toBe(allowedOrigin);
	});

	test("does not set CORS headers for disallowed origins", async () => {
		upstream = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		gateway = createGateway(makeConfig(upstream.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/paid`, {
			headers: { Origin: "https://evil.example.com" },
		});

		expect(res.status).toBe(402);
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});
});
