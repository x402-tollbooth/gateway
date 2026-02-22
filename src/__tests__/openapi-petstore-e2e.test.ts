import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	buildExportSpec,
	fetchOpenAPISpec,
	importOpenAPIRoutes,
} from "../openapi/spec.js";
import type { TollboothConfig } from "../types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const PETSTORE_URL = "https://petstore3.swagger.io/api/v3/openapi.json";

function makeConfig(
	specUrl: string,
	routeOverrides?: TollboothConfig["routes"],
): TollboothConfig {
	return {
		gateway: { port: 0, discovery: true },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: "https://x402.org/facilitator",
		upstreams: {
			petstore: {
				url: "http://localhost:9999",
				openapi: specUrl,
				defaultPrice: "$0.10",
			},
		},
		routes: routeOverrides ?? {},
	};
}

// ── Setup: fetch spec once, serve locally ────────────────────────────────────

let petstoreSpec: Record<string, unknown> | null = null;
let localServer: ReturnType<typeof Bun.serve> | null = null;
let specUrl: string;

beforeAll(async () => {
	try {
		petstoreSpec = await fetchOpenAPISpec(PETSTORE_URL);
		localServer = Bun.serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(petstoreSpec), {
					headers: { "Content-Type": "application/json" },
				}),
		});
		specUrl = `http://localhost:${localServer.port}/openapi.json`;
	} catch {
		// Offline — tests will be skipped
		petstoreSpec = null;
	}
});

afterAll(() => {
	localServer?.stop();
});

function skipIfOffline() {
	if (!petstoreSpec) {
		throw new Error(
			"Skipped: could not fetch Petstore spec (network unavailable)",
		);
	}
}

// ── Spec validation ──────────────────────────────────────────────────────────

describe("Petstore E2E — spec validation", () => {
	test("fetched spec is valid OpenAPI 3.x", () => {
		skipIfOffline();
		const version = (petstoreSpec as { openapi?: string }).openapi;
		expect(version).toBeDefined();
		expect(version).toMatch(/^3\./);
	});

	test("spec has paths with operations", () => {
		skipIfOffline();
		const paths = petstoreSpec?.paths as Record<string, unknown>;
		expect(paths).toBeDefined();
		expect(Object.keys(paths).length).toBeGreaterThan(5);
	});
});

// ── importOpenAPIRoutes ──────────────────────────────────────────────────────

describe("Petstore E2E — importOpenAPIRoutes", () => {
	test("populates config.routes from real Petstore spec", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);

		const routeKeys = Object.keys(config.routes);
		expect(routeKeys.length).toBeGreaterThanOrEqual(15);
	});

	test("known Petstore routes are imported", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);

		// Core pet operations
		expect(config.routes["GET /pet/:petId"]).toBeDefined();
		expect(config.routes["POST /pet"]).toBeDefined();
		expect(config.routes["PUT /pet"]).toBeDefined();
		expect(config.routes["DELETE /pet/:petId"]).toBeDefined();
		expect(config.routes["GET /pet/findByStatus"]).toBeDefined();

		// User operations
		expect(config.routes["POST /user"]).toBeDefined();
		expect(config.routes["GET /user/:username"]).toBeDefined();

		// Store operations
		expect(config.routes["GET /store/inventory"]).toBeDefined();
		expect(config.routes["POST /store/order"]).toBeDefined();
	});

	test("every imported route has upstream and price", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);

		for (const [_key, route] of Object.entries(config.routes)) {
			expect(route.upstream).toBe("petstore");
			expect(route.price).toBe("$0.10");
		}
	});

	test("path params are converted from {param} to :param", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);

		const routeKeys = Object.keys(config.routes);
		// No route should contain {braces}
		for (const key of routeKeys) {
			expect(key).not.toMatch(/\{[^}]+\}/);
		}
		// But :param routes should exist
		expect(routeKeys.some((k) => k.includes(":petId"))).toBe(true);
		expect(routeKeys.some((k) => k.includes(":username"))).toBe(true);
	});

	test("summaries are preserved from spec", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);

		// Petstore operations have summaries
		const getPet = config.routes["GET /pet/:petId"];
		expect(getPet.metadata?.summary).toBeDefined();
		expect(typeof getPet.metadata?.summary).toBe("string");
		expect((getPet.metadata?.summary as string).length).toBeGreaterThan(0);
	});

	test("config-defined routes take precedence over imported ones", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl, {
			"GET /pet/:petId": {
				upstream: "petstore",
				price: "$9.99",
				metadata: { summary: "My custom summary" },
			},
		});
		await importOpenAPIRoutes(config);

		// Should NOT be overwritten
		expect(config.routes["GET /pet/:petId"].price).toBe("$9.99");
		expect(config.routes["GET /pet/:petId"].metadata?.summary).toBe(
			"My custom summary",
		);

		// Other routes should still be imported
		expect(config.routes["POST /pet"]).toBeDefined();
	});
});

// ── buildExportSpec ──────────────────────────────────────────────────────────

describe("Petstore E2E — buildExportSpec", () => {
	test("exported spec is OpenAPI 3.1.0", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);
		const spec = await buildExportSpec(config);

		expect(spec.openapi).toBe("3.1.0");
	});

	test("preserves upstream spec info (not generic Tollbooth title)", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);
		const spec = await buildExportSpec(config);

		const info = spec.info as Record<string, string>;
		expect(info.title).not.toBe("Tollbooth API");
		expect(info.title.toLowerCase()).toContain("pet");
	});

	test("has top-level x-x402 extension", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);
		const spec = await buildExportSpec(config);

		const x402 = (spec as Record<string, unknown>)["x-x402"] as Record<
			string,
			unknown
		>;
		expect(x402).toBeDefined();
		expect(x402.version).toBe(2);
		expect(x402.provider).toBe("tollbooth");
	});

	test("every operation has x-x402-price and x-x402-accepts", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);
		const spec = await buildExportSpec(config);

		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		const httpMethods = [
			"get",
			"post",
			"put",
			"delete",
			"patch",
			"options",
			"head",
		];
		let operationCount = 0;

		for (const [, methods] of Object.entries(paths)) {
			for (const [method, operation] of Object.entries(methods)) {
				if (!httpMethods.includes(method)) continue;
				operationCount++;
				expect(operation["x-x402-price"]).toBeDefined();
				expect(operation["x-x402-accepts"]).toBeDefined();
			}
		}

		expect(operationCount).toBeGreaterThanOrEqual(15);
	});

	test("operations have 402 responses", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);
		const spec = await buildExportSpec(config);

		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		// Spot-check a few operations
		const getPet = paths["/pet/{petId}"]?.get;
		expect(getPet).toBeDefined();
		const responses = getPet.responses as Record<string, unknown>;
		expect(responses["402"]).toBeDefined();
	});

	test("exported paths use {param} format (not :param)", async () => {
		skipIfOffline();
		const config = makeConfig(specUrl);
		await importOpenAPIRoutes(config);
		const spec = await buildExportSpec(config);

		const paths = Object.keys(spec.paths as Record<string, unknown>);
		for (const path of paths) {
			expect(path).not.toMatch(/:\w+/);
		}
		// Should have {petId} style params
		expect(paths.some((p) => p.includes("{petId}"))).toBe(true);
	});
});
