import { describe, expect, test } from "bun:test";
import { extractParams, rewritePath } from "../router/rewriter.js";
import { matchRoute } from "../router/router.js";
import type { TollboothConfig } from "../types.js";

describe("extractParams", () => {
	test("extracts named params", () => {
		const result = extractParams("/data/dune/:query_id", "/data/dune/12345");
		expect(result).toEqual({ query_id: "12345" });
	});

	test("extracts multiple params", () => {
		const result = extractParams("/api/:version/:resource", "/api/v2/users");
		expect(result).toEqual({ version: "v2", resource: "users" });
	});

	test("returns null on segment count mismatch", () => {
		const result = extractParams("/data/:id", "/data/123/extra");
		expect(result).toBeNull();
	});

	test("returns null on static segment mismatch", () => {
		const result = extractParams("/data/dune/:id", "/data/other/123");
		expect(result).toBeNull();
	});

	test("matches static path with no params", () => {
		const result = extractParams("/v1/models", "/v1/models");
		expect(result).toEqual({});
	});
});

describe("rewritePath", () => {
	test("interpolates params", () => {
		const result = rewritePath(
			"/v1/query/${params.query_id}/results",
			{ query_id: "12345" },
			{},
		);
		expect(result).toBe("/v1/query/12345/results");
	});

	test("interpolates query", () => {
		const result = rewritePath("/search/${query.q}", {}, { q: "hello world" });
		expect(result).toBe("/search/hello%20world");
	});

	test("throws on missing param", () => {
		expect(() => rewritePath("/v1/${params.missing}", {}, {})).toThrow();
	});
});

describe("matchRoute", () => {
	const config: TollboothConfig = {
		gateway: { port: 3000, discovery: true },
		wallets: { base: "0xtest" },
		accepts: [{ asset: "USDC", network: "base" }],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: {
			anthropic: { url: "https://api.anthropic.com" },
			dune: { url: "https://api.dune.com" },
		},
		routes: {
			"POST /ai/claude": {
				upstream: "anthropic",
				path: "/v1/messages",
				price: "$0.01",
			},
			"GET /data/dune/:query_id": {
				upstream: "dune",
				path: "/v1/query/${params.query_id}/results",
				price: "$0.05",
			},
		},
	};

	test("matches static route", () => {
		const result = matchRoute("POST", "/ai/claude", config);
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.routeKey).toBe("POST /ai/claude");
			expect(result.upstream.url).toBe("https://api.anthropic.com");
		}
	});

	test("matches parameterized route", () => {
		const result = matchRoute("GET", "/data/dune/12345", config);
		expect(result.matched).toBe(true);
		if (result.matched) {
			expect(result.params.query_id).toBe("12345");
		}
	});

	test("returns diagnostics for unmatched path", () => {
		const result = matchRoute("GET", "/unknown", config);
		expect(result.matched).toBe(false);
		if (!result.matched) {
			expect(result.checked).toContain("POST /ai/claude");
			expect(result.checked).toContain("GET /data/dune/:query_id");
		}
	});

	test("returns diagnostics for wrong method", () => {
		const result = matchRoute("GET", "/ai/claude", config);
		expect(result.matched).toBe(false);
		if (!result.matched) {
			expect(result.checked.length).toBe(2);
		}
	});

	test("suggests close route match", () => {
		const result = matchRoute("POST", "/ai/claud", config);
		expect(result.matched).toBe(false);
		if (!result.matched) {
			expect(result.suggestion).toBe("POST /ai/claude");
		}
	});

	test("does not suggest when distance is too large", () => {
		const result = matchRoute("DELETE", "/completely/different/path", config);
		expect(result.matched).toBe(false);
		if (!result.matched) {
			expect(result.suggestion).toBeUndefined();
		}
	});
});
