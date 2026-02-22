import { parse as parseYaml } from "yaml";
import { extractOperations } from "../init.js";
import { log } from "../logger.js";
import type { TollboothConfig } from "../types.js";
import { resolveFacilitatorUrl } from "../x402/facilitator.js";

// ── Types ────────────────────────────────────────────────────────────────────

type OpenAPISpec = Record<string, unknown>;

interface OpenAPIPathItem {
	[method: string]: unknown;
}

// ── Fetch & Parse ────────────────────────────────────────────────────────────

/**
 * Fetch and parse an OpenAPI spec from a URL or local file path.
 */
export async function fetchOpenAPISpec(source: string): Promise<OpenAPISpec> {
	if (source.startsWith("http://") || source.startsWith("https://")) {
		const res = await fetch(source, {
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) {
			throw new Error(
				`Failed to fetch OpenAPI spec from ${source}: ${res.status} ${res.statusText}`,
			);
		}
		const contentType = res.headers.get("content-type") ?? "";
		const text = await res.text();
		if (contentType.includes("json") || source.endsWith(".json")) {
			return JSON.parse(text) as OpenAPISpec;
		}
		return parseYaml(text) as OpenAPISpec;
	}

	// Local file
	const { readFileSync, existsSync } = await import("node:fs");
	const { resolve } = await import("node:path");
	const abs = resolve(source);
	if (!existsSync(abs)) {
		throw new Error(`OpenAPI spec file not found: ${abs}`);
	}
	const raw = readFileSync(abs, "utf-8");
	if (abs.endsWith(".json")) {
		return JSON.parse(raw) as OpenAPISpec;
	}
	return parseYaml(raw) as OpenAPISpec;
}

// ── Runtime Import ───────────────────────────────────────────────────────────

/**
 * Auto-generate tollbooth routes from upstream OpenAPI specs.
 * Mutates config.routes by adding discovered routes (config overrides take precedence).
 */
export async function importOpenAPIRoutes(
	config: TollboothConfig,
): Promise<void> {
	for (const [upstreamName, upstream] of Object.entries(config.upstreams)) {
		if (!upstream.openapi) continue;

		try {
			const spec = await fetchOpenAPISpec(upstream.openapi);
			const version = (spec as { openapi?: string }).openapi;
			if (!version?.startsWith("3.")) {
				log.warn("openapi_skip", {
					upstream: upstreamName,
					reason: "Only OpenAPI 3.x specs are supported",
				});
				continue;
			}

			const ops = extractOperations(spec);
			let imported = 0;

			for (const op of ops) {
				const routeKey = `${op.method} ${op.path}`;

				// Config-defined routes take precedence
				if (config.routes[routeKey]) continue;

				config.routes[routeKey] = {
					upstream: upstreamName,
					price: upstream.defaultPrice ?? config.defaults.price,
					...(op.summary && { metadata: { summary: op.summary } }),
				};
				imported++;
			}

			log.info("openapi_imported", {
				upstream: upstreamName,
				source: upstream.openapi,
				operations: ops.length,
				imported,
				skipped: ops.length - imported,
			});
		} catch (err) {
			log.error("openapi_import_failed", {
				upstream: upstreamName,
				source: upstream.openapi,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Build an OpenAPI 3.1.0 spec from the current tollbooth config.
 * Includes x402 payment extensions on each operation.
 */
export function buildOpenAPISpec(config: TollboothConfig): OpenAPISpec {
	const paths: Record<string, OpenAPIPathItem> = {};

	for (const [routeKey, route] of Object.entries(config.routes)) {
		const [method, ...pathParts] = routeKey.split(" ");
		const routePath = pathParts.join(" ");
		// Convert :param back to {param} for OpenAPI
		const openapiPath = routePath.replace(/:(\w+)/g, "{$1}");
		const httpMethod = method.toLowerCase();

		const accepts = route.accepts ?? config.accepts;

		// Resolve price
		let price: string | undefined;
		if (route.match) {
			price = route.fallback ?? config.defaults.price;
		} else if (route.price && typeof route.price === "string") {
			price = route.price;
		} else if (!route.price || typeof route.price === "object") {
			price = config.defaults.price;
		}

		// Resolve facilitator
		const globalFacilitator = config.settlement?.url ?? config.facilitator;
		const acceptsInfo = accepts.map((a) => ({
			asset: a.asset,
			network: a.network,
			facilitator: resolveFacilitatorUrl(
				a.network,
				a.asset,
				route.facilitator,
				globalFacilitator,
			),
		}));

		// Build x402 extensions
		const extensions: Record<string, unknown> = {
			"x-x402-price": price,
			"x-x402-accepts": acceptsInfo,
		};

		if (route.type === "token-based") {
			extensions["x-x402-pricing-type"] = "token-based";
		} else if (route.match) {
			extensions["x-x402-pricing-type"] = "match";
		} else if (
			route.price &&
			typeof route.price === "object" &&
			"fn" in route.price
		) {
			extensions["x-x402-pricing-type"] = "dynamic";
		}

		// Extract path parameters
		const paramMatches = openapiPath.match(/\{(\w+)\}/g);
		const parameters = paramMatches?.map((p) => ({
			name: p.slice(1, -1),
			in: "path" as const,
			required: true,
			schema: { type: "string" as const },
		}));

		// Build operation
		const operation: Record<string, unknown> = {
			...extensions,
			responses: {
				"200": {
					description: "Successful response",
				},
				"402": {
					description: "Payment required",
					headers: {
						"payment-required": {
							description:
								"Base64-encoded payment requirements for x402 protocol",
							schema: { type: "string" },
						},
					},
				},
			},
		};

		// Add summary from metadata
		const summary = route.metadata?.summary;
		if (typeof summary === "string") {
			operation.summary = summary;
		}

		// Add description from metadata
		const description = route.metadata?.description;
		if (typeof description === "string") {
			operation.description = description;
		}

		if (parameters?.length) {
			operation.parameters = parameters;
		}

		// Add request body hint for non-GET methods
		if (!["get", "head", "options"].includes(httpMethod)) {
			operation.requestBody = {
				content: {
					"application/json": {
						schema: { type: "object" },
					},
				},
			};
		}

		if (!paths[openapiPath]) {
			paths[openapiPath] = {};
		}
		paths[openapiPath][httpMethod] = operation;
	}

	return {
		openapi: "3.1.0",
		info: {
			title: "Tollbooth API",
			version: "1.0.0",
			description:
				"API gateway with x402 payment protocol. All paid endpoints return 402 Payment Required without a valid payment signature.",
		},
		paths,
		"x-x402": {
			version: 2,
			provider: "tollbooth",
			wallets: config.wallets,
			accepts: config.accepts,
			defaultPrice: config.defaults.price,
		},
	};
}

// ── Merge ────────────────────────────────────────────────────────────────────

/**
 * Merge an upstream OpenAPI spec with tollbooth payment info.
 * Takes the upstream spec as a base, enriches each operation with x402 extensions.
 */
export function mergeOpenAPISpec(
	upstreamSpec: OpenAPISpec,
	config: TollboothConfig,
	upstreamName: string,
): OpenAPISpec {
	const merged = structuredClone(upstreamSpec) as OpenAPISpec;

	// Upgrade to 3.1.0 for extensions support
	merged.openapi = "3.1.0";

	// Add x402 top-level extension
	(merged as Record<string, unknown>)["x-x402"] = {
		version: 2,
		provider: "tollbooth",
		wallets: config.wallets,
		accepts: config.accepts,
		defaultPrice: config.defaults.price,
	};

	const paths = merged.paths as
		| Record<string, Record<string, unknown>>
		| undefined;
	if (!paths) return merged;

	const accepts = config.accepts;
	const globalFacilitator = config.settlement?.url ?? config.facilitator;

	for (const [path, methods] of Object.entries(paths)) {
		if (!methods || typeof methods !== "object") continue;

		for (const [method, operation] of Object.entries(methods)) {
			if (
				typeof operation !== "object" ||
				operation === null ||
				["summary", "description", "parameters", "servers", "$ref"].includes(
					method,
				)
			) {
				continue;
			}

			const op = operation as Record<string, unknown>;

			// Find matching tollbooth route
			const tollboothPath = path.replace(/\{([^}]+)\}/g, ":$1");
			const routeKey = `${method.toUpperCase()} ${tollboothPath}`;
			const route = config.routes[routeKey];

			// Determine price
			let price: string;
			if (route) {
				if (route.match) {
					price = route.fallback ?? config.defaults.price;
				} else if (route.price && typeof route.price === "string") {
					price = route.price;
				} else {
					price = config.defaults.price;
				}
			} else {
				// Route was auto-imported, use upstream default or global default
				const upstream = config.upstreams[upstreamName];
				price = upstream?.defaultPrice ?? config.defaults.price;
			}

			const routeFacilitator = route?.facilitator;
			const acceptsInfo = accepts.map((a) => ({
				asset: a.asset,
				network: a.network,
				facilitator: resolveFacilitatorUrl(
					a.network,
					a.asset,
					routeFacilitator,
					globalFacilitator,
				),
			}));

			op["x-x402-price"] = price;
			op["x-x402-accepts"] = acceptsInfo;

			if (route) {
				if (route.type === "token-based") {
					op["x-x402-pricing-type"] = "token-based";
				} else if (route.match) {
					op["x-x402-pricing-type"] = "match";
				} else if (
					route.price &&
					typeof route.price === "object" &&
					"fn" in route.price
				) {
					op["x-x402-pricing-type"] = "dynamic";
				}
			}

			// Add 402 response if not present
			const responses = (op.responses ?? {}) as Record<string, unknown>;
			if (!responses["402"]) {
				responses["402"] = {
					description: "Payment required",
					headers: {
						"payment-required": {
							description:
								"Base64-encoded payment requirements for x402 protocol",
							schema: { type: "string" },
						},
					},
				};
				op.responses = responses;
			}
		}
	}

	return merged;
}

// ── Combined Export (with merge if upstream spec exists) ──────────────────────

/**
 * Build the final OpenAPI spec for the /.well-known/openapi.json endpoint.
 * Merges all upstream OpenAPI specs and fills gaps with config-generated routes.
 */
export async function buildExportSpec(
	config: TollboothConfig,
): Promise<OpenAPISpec> {
	const mergedSpecs: OpenAPISpec[] = [];

	for (const [name, upstream] of Object.entries(config.upstreams)) {
		if (!upstream.openapi) continue;

		try {
			const spec = await fetchOpenAPISpec(upstream.openapi);
			mergedSpecs.push(mergeOpenAPISpec(spec, config, name));
		} catch {
			log.warn("openapi_merge_fallback", {
				upstream: name,
				reason: "Could not fetch upstream spec",
			});
		}
	}

	if (mergedSpecs.length === 0) {
		return buildOpenAPISpec(config);
	}

	// Use first upstream's spec as base (for info, servers, etc.)
	const combined = mergedSpecs[0];
	const combinedPaths = (combined.paths ?? {}) as Record<
		string,
		OpenAPIPathItem
	>;

	// Merge paths from additional upstream specs
	for (let i = 1; i < mergedSpecs.length; i++) {
		const paths = mergedSpecs[i].paths as
			| Record<string, OpenAPIPathItem>
			| undefined;
		if (!paths) continue;

		for (const [path, methods] of Object.entries(paths)) {
			if (!combinedPaths[path]) {
				combinedPaths[path] = methods;
			} else {
				for (const [method, op] of Object.entries(methods)) {
					if (!(method in combinedPaths[path])) {
						combinedPaths[path][method] = op;
					}
				}
			}
		}
	}

	// Fill in config routes not covered by any upstream spec
	const configSpec = buildOpenAPISpec(config);
	const configPaths = configSpec.paths as
		| Record<string, OpenAPIPathItem>
		| undefined;
	if (configPaths) {
		for (const [path, methods] of Object.entries(configPaths)) {
			if (!combinedPaths[path]) {
				combinedPaths[path] = methods;
			} else {
				for (const [method, op] of Object.entries(methods)) {
					if (!(method in combinedPaths[path])) {
						combinedPaths[path][method] = op;
					}
				}
			}
		}
	}

	combined.paths = combinedPaths;
	return combined;
}
