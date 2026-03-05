import { afterEach, describe, expect, test } from "vitest";
import { createGateway } from "../gateway.js";
import {
	buildExportSpec,
	buildOpenAPISpec,
	importOpenAPIRoutes,
	mergeOpenAPISpec,
} from "../openapi/spec.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import { serve, type TestServer } from "./helpers/test-server.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<TollboothConfig>): TollboothConfig {
	return {
		gateway: { port: 0, discovery: true },
		wallets: { "base-sepolia": "0xtest" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		facilitator: "https://x402.org/facilitator",
		upstreams: {
			api: { url: "http://localhost:9999" },
		},
		routes: {
			"GET /pets": {
				upstream: "api",
				price: "$0.01",
				metadata: { summary: "List all pets" },
			},
			"POST /pets": {
				upstream: "api",
				price: "$0.05",
			},
			"GET /pets/:petId": {
				upstream: "api",
				price: "$0.02",
			},
		},
		...overrides,
	};
}

const PETSTORE_SPEC = {
	openapi: "3.0.3",
	info: { title: "Petstore", version: "1.0.0" },
	servers: [{ url: "https://petstore.example.com/v1" }],
	paths: {
		"/pets": {
			get: {
				summary: "List pets",
				responses: { "200": { description: "OK" } },
			},
			post: {
				summary: "Create pet",
				responses: { "200": { description: "OK" } },
			},
		},
		"/pets/{petId}": {
			get: {
				summary: "Get pet by ID",
				responses: { "200": { description: "OK" } },
			},
		},
	},
};

// ── buildOpenAPISpec ─────────────────────────────────────────────────────────

describe("buildOpenAPISpec", () => {
	test("builds valid OpenAPI 3.1.0 spec from config", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);

		expect(spec.openapi).toBe("3.1.0");
		expect((spec.info as Record<string, string>).title).toBe("Tollbooth API");
		expect(spec.paths).toBeDefined();
	});

	test("includes all routes as paths", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<string, Record<string, unknown>>;

		expect(paths["/pets"]).toBeDefined();
		expect(paths["/pets"].get).toBeDefined();
		expect(paths["/pets"].post).toBeDefined();
		expect(paths["/pets/{petId}"]).toBeDefined();
		expect(paths["/pets/{petId}"].get).toBeDefined();
	});

	test("converts :param to {param} in paths", () => {
		const config = makeConfig({
			routes: {
				"GET /users/:userId/posts/:postId": {
					upstream: "api",
					price: "$0.01",
				},
			},
		});
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<string, unknown>;

		expect(paths["/users/{userId}/posts/{postId}"]).toBeDefined();
	});

	test("includes x402 extensions on each operation", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		const getPets = paths["/pets"].get;
		expect(getPets["x-x402-price"]).toBe("$0.01");
		expect(getPets["x-x402-accepts"]).toBeDefined();

		const accepts = getPets["x-x402-accepts"] as Array<Record<string, string>>;
		expect(accepts[0].asset).toBe("USDC");
		expect(accepts[0].network).toBe("base-sepolia");
	});

	test("includes 402 response in every operation", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		const responses = paths["/pets"].get.responses as Record<string, unknown>;
		expect(responses["402"]).toBeDefined();
	});

	test("includes summary from route metadata", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/pets"].get.summary).toBe("List all pets");
	});

	test("includes top-level x-x402 extension", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);

		const x402 = (spec as Record<string, unknown>)["x-x402"] as Record<
			string,
			unknown
		>;
		expect(x402.version).toBe(2);
		expect(x402.provider).toBe("tollbooth");
		expect(x402.wallets).toEqual({ "base-sepolia": "0xtest" });
	});

	test("includes requestBody for POST operations", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/pets"].post.requestBody).toBeDefined();
		expect(paths["/pets"].get.requestBody).toBeUndefined();
	});

	test("includes path parameters for parameterized routes", () => {
		const config = makeConfig();
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		const params = paths["/pets/{petId}"].get.parameters as Array<
			Record<string, unknown>
		>;
		expect(params).toHaveLength(1);
		expect(params[0].name).toBe("petId");
		expect(params[0].in).toBe("path");
		expect(params[0].required).toBe(true);
	});

	test("uses default price when route has no price", () => {
		const config = makeConfig({
			routes: {
				"GET /free": { upstream: "api" },
			},
		});
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/free"].get["x-x402-price"]).toBe("$0.001");
	});

	test("uses fallback price for match routes", () => {
		const config = makeConfig({
			routes: {
				"POST /chat": {
					upstream: "api",
					match: [{ where: { "body.model": "gpt-4" }, price: "$0.01" }],
					fallback: "$0.005",
				},
			},
		});
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/chat"].post["x-x402-price"]).toBe("$0.005");
		expect(paths["/chat"].post["x-x402-pricing-type"]).toBe("match");
	});

	test("sets pricing-type to dynamic for function-based pricing", () => {
		const config = makeConfig({
			routes: {
				"POST /generate": {
					upstream: "api",
					price: { fn: "computePrice" },
				},
			},
		});
		const spec = buildOpenAPISpec(config);
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/generate"].post["x-x402-pricing-type"]).toBe("dynamic");
		expect(paths["/generate"].post["x-x402-price"]).toBe("$0.001");
	});
});

// ── mergeOpenAPISpec ─────────────────────────────────────────────────────────

describe("mergeOpenAPISpec", () => {
	test("merges upstream spec with x402 extensions", () => {
		const config = makeConfig();
		const merged = mergeOpenAPISpec(PETSTORE_SPEC, config, "api");

		expect(merged.openapi).toBe("3.1.0");
		expect((merged.info as Record<string, string>).title).toBe("Petstore");

		const paths = merged.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		const getPets = paths["/pets"].get;
		expect(getPets["x-x402-price"]).toBe("$0.01");
		expect(getPets["x-x402-accepts"]).toBeDefined();
	});

	test("adds 402 response to upstream operations", () => {
		const config = makeConfig();
		const merged = mergeOpenAPISpec(PETSTORE_SPEC, config, "api");
		const paths = merged.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		const responses = paths["/pets"].get.responses as Record<string, unknown>;
		expect(responses["402"]).toBeDefined();
		// Preserves original responses
		expect(responses["200"]).toBeDefined();
	});

	test("includes top-level x-x402 extension", () => {
		const config = makeConfig();
		const merged = mergeOpenAPISpec(PETSTORE_SPEC, config, "api");

		const x402 = (merged as Record<string, unknown>)["x-x402"] as Record<
			string,
			unknown
		>;
		expect(x402.version).toBe(2);
		expect(x402.provider).toBe("tollbooth");
	});

	test("does not mutate original spec", () => {
		const config = makeConfig();
		const original = structuredClone(PETSTORE_SPEC);
		mergeOpenAPISpec(PETSTORE_SPEC, config, "api");

		expect(PETSTORE_SPEC).toEqual(original);
	});

	test("uses upstream defaultPrice for unmatched routes", () => {
		const config = makeConfig({
			upstreams: {
				api: {
					url: "http://localhost:9999",
					defaultPrice: "$0.99",
				},
			},
			routes: {}, // No explicit routes
		});

		const merged = mergeOpenAPISpec(PETSTORE_SPEC, config, "api");
		const paths = merged.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/pets"].get["x-x402-price"]).toBe("$0.99");
	});

	test("sets pricing-type on merged operations", () => {
		const config = makeConfig({
			routes: {
				"GET /pets": {
					upstream: "api",
					price: { fn: "computePrice" },
				},
				"POST /pets": {
					upstream: "api",
					match: [{ where: { "body.breed": "poodle" }, price: "$1.00" }],
					fallback: "$0.50",
				},
			},
		});
		const merged = mergeOpenAPISpec(PETSTORE_SPEC, config, "api");
		const paths = merged.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		expect(paths["/pets"].get["x-x402-pricing-type"]).toBe("dynamic");
		expect(paths["/pets"].post["x-x402-pricing-type"]).toBe("match");
	});
});

// ── buildExportSpec ──────────────────────────────────────────────────────────

const USERS_SPEC = {
	openapi: "3.0.3",
	info: { title: "Users API", version: "1.0.0" },
	paths: {
		"/users": {
			get: {
				summary: "List users",
				responses: { "200": { description: "OK" } },
			},
		},
		"/users/{userId}": {
			get: {
				summary: "Get user by ID",
				responses: { "200": { description: "OK" } },
			},
		},
	},
};

describe("buildExportSpec", () => {
	test("merges specs from multiple upstreams", async () => {
		const petServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(PETSTORE_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});
		const userServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(USERS_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});

		try {
			const config = makeConfig({
				upstreams: {
					petstore: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${petServer.port}/openapi.json`,
						defaultPrice: "$0.10",
					},
					users: {
						url: "http://localhost:9998",
						openapi: `http://localhost:${userServer.port}/openapi.json`,
						defaultPrice: "$0.20",
					},
				},
				routes: {},
			});

			// Import routes first (like gateway.start does)
			await importOpenAPIRoutes(config);
			const spec = await buildExportSpec(config);

			const paths = spec.paths as Record<
				string,
				Record<string, Record<string, unknown>>
			>;

			// Both upstreams' paths should be present
			expect(paths["/pets"]).toBeDefined();
			expect(paths["/pets"].get).toBeDefined();
			expect(paths["/users"]).toBeDefined();
			expect(paths["/users"].get).toBeDefined();
			expect(paths["/users/{userId}"]).toBeDefined();

			// First upstream's metadata used as base
			expect((spec.info as Record<string, string>).title).toBe("Petstore");
		} finally {
			petServer.stop();
			userServer.stop();
		}
	});

	test("falls back to buildOpenAPISpec when no upstream specs available", async () => {
		const config = makeConfig({
			upstreams: {
				api: { url: "http://localhost:9999" },
			},
		});

		const spec = await buildExportSpec(config);

		expect(spec.openapi).toBe("3.1.0");
		expect((spec.info as Record<string, string>).title).toBe("Tollbooth API");
		const paths = spec.paths as Record<string, Record<string, unknown>>;
		expect(paths["/pets"]).toBeDefined();
	});

	test("includes config-only routes alongside upstream routes", async () => {
		const petServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(PETSTORE_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});

		try {
			const config = makeConfig({
				upstreams: {
					petstore: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${petServer.port}/openapi.json`,
					},
				},
				routes: {
					"GET /health": {
						upstream: "petstore",
						price: "$0.00",
					},
				},
			});

			await importOpenAPIRoutes(config);
			const spec = await buildExportSpec(config);

			const paths = spec.paths as Record<string, Record<string, unknown>>;
			// Upstream route present
			expect(paths["/pets"]).toBeDefined();
			// Config-only route also present
			expect(paths["/health"]).toBeDefined();
		} finally {
			petServer.stop();
		}
	});
});

// ── importOpenAPIRoutes ──────────────────────────────────────────────────────

describe("importOpenAPIRoutes", () => {
	test("imports routes from spec served by local HTTP server", async () => {
		const specServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(PETSTORE_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});

		try {
			const config = makeConfig({
				upstreams: {
					petstore: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${specServer.port}/openapi.json`,
						defaultPrice: "$0.10",
					},
				},
				routes: {},
			});

			await importOpenAPIRoutes(config);

			expect(config.routes["GET /pets"]).toBeDefined();
			expect(config.routes["GET /pets"].upstream).toBe("petstore");
			expect(config.routes["GET /pets"].price).toBe("$0.10");
			expect(config.routes["POST /pets"]).toBeDefined();
			expect(config.routes["GET /pets/:petId"]).toBeDefined();
		} finally {
			specServer.stop();
		}
	});

	test("config-defined routes take precedence over imported ones", async () => {
		const specServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(PETSTORE_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});

		try {
			const config = makeConfig({
				upstreams: {
					petstore: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${specServer.port}/openapi.json`,
					},
				},
				routes: {
					"GET /pets": {
						upstream: "petstore",
						price: "$1.00",
					},
				},
			});

			await importOpenAPIRoutes(config);

			// Existing route should not be overwritten
			expect(config.routes["GET /pets"].price).toBe("$1.00");
			// But new routes should be added
			expect(config.routes["POST /pets"]).toBeDefined();
		} finally {
			specServer.stop();
		}
	});

	test("skips non-3.x OpenAPI specs", async () => {
		const specServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(
					JSON.stringify({ swagger: "2.0", paths: { "/test": { get: {} } } }),
					{ headers: { "Content-Type": "application/json" } },
				),
		});

		try {
			const config = makeConfig({
				upstreams: {
					old: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${specServer.port}/spec.json`,
					},
				},
				routes: {},
			});

			await importOpenAPIRoutes(config);

			expect(Object.keys(config.routes)).toHaveLength(0);
		} finally {
			specServer.stop();
		}
	});

	test("stores summary in metadata when available", async () => {
		const specServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(PETSTORE_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});

		try {
			const config = makeConfig({
				upstreams: {
					petstore: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${specServer.port}/openapi.json`,
					},
				},
				routes: {},
			});

			await importOpenAPIRoutes(config);

			expect(config.routes["GET /pets"].metadata?.summary).toBe("List pets");
		} finally {
			specServer.stop();
		}
	});

	test("skips upstreams without openapi field", async () => {
		const config = makeConfig({
			routes: {},
		});

		await importOpenAPIRoutes(config);

		expect(Object.keys(config.routes)).toHaveLength(0);
	});

	test("handles fetch errors gracefully", async () => {
		const config = makeConfig({
			upstreams: {
				broken: {
					url: "http://localhost:9999",
					openapi: "http://localhost:1/nonexistent",
				},
			},
			routes: {},
		});

		// Should not throw
		await importOpenAPIRoutes(config);

		expect(Object.keys(config.routes)).toHaveLength(0);
	});
});

// ── Integration: gateway serves /.well-known/openapi.json ────────────────────

describe("OpenAPI export endpoint", () => {
	let gateway: TollboothGateway;

	afterEach(async () => {
		await gateway?.stop();
	});

	test("GET /.well-known/openapi.json returns OpenAPI spec", async () => {
		const config = makeConfig();
		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(
			`http://localhost:${gateway.port}/.well-known/openapi.json`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("application/json");

		const spec = (await res.json()) as Record<string, unknown>;
		expect(spec.openapi).toBe("3.1.0");

		const paths = spec.paths as Record<string, Record<string, unknown>>;
		expect(paths["/pets"]).toBeDefined();
		expect(paths["/pets"].get).toBeDefined();
	});

	test("includes x402 extensions in served spec", async () => {
		const config = makeConfig();
		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(
			`http://localhost:${gateway.port}/.well-known/openapi.json`,
		);
		const spec = (await res.json()) as Record<string, unknown>;
		const paths = spec.paths as Record<
			string,
			Record<string, Record<string, unknown>>
		>;

		const getPets = paths["/pets"].get;
		expect(getPets["x-x402-price"]).toBe("$0.01");
		expect(getPets["x-x402-accepts"]).toBeDefined();
	});

	test("not served when discovery is disabled", async () => {
		const config = makeConfig({
			gateway: { port: 0, discovery: false },
		});
		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const res = await fetch(
			`http://localhost:${gateway.port}/.well-known/openapi.json`,
		);
		// Without discovery, endpoint is not registered so it hits the route matcher
		expect(res.status).toBe(404);
	});

	test("gateway imports OpenAPI routes and serves them", async () => {
		const specServer: TestServer = await serve({
			port: 0,
			fetch: () =>
				new Response(JSON.stringify(PETSTORE_SPEC), {
					headers: { "Content-Type": "application/json" },
				}),
		});

		try {
			const config: TollboothConfig = {
				gateway: { port: 0, discovery: true },
				wallets: { "base-sepolia": "0xtest" },
				accepts: [{ asset: "USDC", network: "base-sepolia" }],
				defaults: { price: "$0.001", timeout: 60 },
				facilitator: "https://x402.org/facilitator",
				upstreams: {
					petstore: {
						url: "http://localhost:9999",
						openapi: `http://localhost:${specServer.port}/openapi.json`,
						defaultPrice: "$0.10",
					},
				},
				routes: {},
			};

			gateway = createGateway(config);
			await gateway.start({ silent: true });

			// Routes should have been imported
			expect(config.routes["GET /pets"]).toBeDefined();

			// OpenAPI spec should include imported routes
			const res = await fetch(
				`http://localhost:${gateway.port}/.well-known/openapi.json`,
			);
			expect(res.status).toBe(200);

			const spec = (await res.json()) as Record<string, unknown>;
			const paths = spec.paths as Record<string, Record<string, unknown>>;
			expect(paths["/pets"]).toBeDefined();
		} finally {
			specServer.stop();
		}
	});
});
