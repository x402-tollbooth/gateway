import { afterEach, describe, expect, test } from "vitest";
import { serve, mockFacilitator } from "./helpers/test-server.js";
import { createGateway } from "../gateway.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";

function makeConfig(
	upstreamPort: number,
	facilitatorPort: number,
	options?: { includeRateLimitedRoute?: boolean },
): TollboothConfig {
	const routes: TollboothConfig["routes"] = {
		"GET /paid": {
			upstream: "api",
			price: "$0.01",
			verificationCache: { ttl: "60s" },
		},
	};

	if (options?.includeRateLimitedRoute) {
		routes["GET /limited"] = {
			upstream: "api",
			price: "$0.01",
			rateLimit: { requests: 1, window: "1m" },
		};
	}

	return {
		gateway: {
			port: 0,
			discovery: false,
			metrics: { enabled: true, path: "/metrics" },
		},
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: `http://localhost:${facilitatorPort}`,
		upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
		routes,
	};
}

function readMetric(
	body: string,
	metricName: string,
	labels?: Record<string, string>,
): number | undefined {
	for (const line of body.split("\n")) {
		if (!line.startsWith(metricName)) continue;

		const match = line.match(/^([^{\s]+)(?:\{([^}]*)\})?\s+([0-9eE+\-.]+)$/);
		if (!match) continue;
		if (match[1] !== metricName) continue;

		const parsedLabels: Record<string, string> = {};
		if (match[2]) {
			for (const entry of match[2].split(",")) {
				const eqIdx = entry.indexOf("=");
				if (eqIdx === -1) continue;
				const key = entry.slice(0, eqIdx);
				const value = entry.slice(eqIdx + 1).replace(/^"|"$/g, "");
				parsedLabels[key] = value;
			}
		}

		if (labels) {
			let matched = true;
			for (const [key, value] of Object.entries(labels)) {
				if (parsedLabels[key] !== value) {
					matched = false;
					break;
				}
			}
			if (!matched) continue;
		}

		return Number(match[3]);
	}

	return undefined;
}

const paymentSig = btoa(
	JSON.stringify({ payload: { authorization: { from: "0xTestPayer" } } }),
);

describe("prometheus metrics endpoint", () => {
	let upstream: Awaited<ReturnType<typeof serve>>;
	let facilitator: Awaited<ReturnType<typeof serve>>;
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
		upstream?.stop();
		facilitator?.stop();
	});

	test("emits counters and histograms for success, missing payment, cache, and rate limits", async () => {
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

		gateway = createGateway(
			makeConfig(upstream.port, facilitator.port, {
				includeRateLimitedRoute: true,
			}),
		);
		await gateway.start({ silent: true });

		const baseUrl = `http://localhost:${gateway.port}`;

		const paidMissing = await fetch(`${baseUrl}/paid`);
		expect(paidMissing.status).toBe(402);

		const paidFirst = await fetch(`${baseUrl}/paid`, {
			headers: { "payment-signature": paymentSig },
		});
		expect(paidFirst.status).toBe(200);

		const paidSecond = await fetch(`${baseUrl}/paid`, {
			headers: { "payment-signature": paymentSig },
		});
		expect(paidSecond.status).toBe(200);

		const limitedFirst = await fetch(`${baseUrl}/limited`);
		expect(limitedFirst.status).toBe(402);

		const limitedSecond = await fetch(`${baseUrl}/limited`);
		expect(limitedSecond.status).toBe(429);

		const metricsRes = await fetch(`${baseUrl}/metrics`);
		expect(metricsRes.status).toBe(200);
		expect(metricsRes.headers.get("content-type")).toContain(
			"text/plain; version=0.0.4",
		);

		const body = await metricsRes.text();
		expect(body).toContain("# HELP tollbooth_requests_total");
		expect(body).toContain(
			"# TYPE tollbooth_request_duration_seconds histogram",
		);

		expect(
			readMetric(body, "tollbooth_requests_total", {
				route: "GET /paid",
				method: "GET",
				status: "200",
			}),
		).toBe(2);
		expect(
			readMetric(body, "tollbooth_requests_total", {
				route: "GET /paid",
				method: "GET",
				status: "402",
			}),
		).toBe(1);
		expect(
			readMetric(body, "tollbooth_requests_total", {
				route: "GET /limited",
				method: "GET",
				status: "429",
			}),
		).toBe(1);

		expect(
			readMetric(body, "tollbooth_payments_total", {
				route: "GET /paid",
				outcome: "missing",
			}),
		).toBe(1);
		expect(
			readMetric(body, "tollbooth_payments_total", {
				route: "GET /paid",
				outcome: "success",
			}),
		).toBe(2);

		expect(
			readMetric(body, "tollbooth_settlements_total", {
				strategy: "facilitator",
				outcome: "success",
			}),
		).toBe(2);
		expect(
			readMetric(body, "tollbooth_cache_misses_total", {
				route: "GET /paid",
			}),
		).toBe(1);
		expect(
			readMetric(body, "tollbooth_cache_hits_total", {
				route: "GET /paid",
			}),
		).toBe(1);
		expect(
			readMetric(body, "tollbooth_rate_limit_blocks_total", {
				route: "GET /limited",
			}),
		).toBe(1);

		const requestDurationCount = readMetric(
			body,
			"tollbooth_request_duration_seconds_count",
			{
				route: "GET /paid",
				method: "GET",
			},
		);
		expect(requestDurationCount).toBeDefined();
		expect(requestDurationCount).toBeGreaterThan(0);
	});

	test("increments settlement failure metric when settlement fails", async () => {
		upstream = await serve({
			port: 0,
			fetch: () => Response.json({ ok: true }),
		});
		facilitator = await mockFacilitator({
			verify: () => Response.json({ isValid: true, payer: "0xTestPayer" }),
			settle: () =>
				Response.json({
					success: false,
					errorReason: "failed on purpose",
					payer: "0xTestPayer",
					transaction: "",
					network: "base-sepolia",
				}),
		});

		gateway = createGateway(makeConfig(upstream.port, facilitator.port));
		await gateway.start({ silent: true });

		const res = await fetch(`http://localhost:${gateway.port}/paid`, {
			headers: { "payment-signature": paymentSig },
		});
		expect(res.status).toBe(502);

		const metricsRes = await fetch(`http://localhost:${gateway.port}/metrics`);
		const body = await metricsRes.text();

		expect(
			readMetric(body, "tollbooth_settlements_total", {
				strategy: "facilitator",
				outcome: "failure",
			}),
		).toBe(1);
	});
});
