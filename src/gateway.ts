import { generateDiscoveryMetadata } from "./discovery/metadata.js";
import {
	runOnError,
	runOnPriceResolved,
	runOnRequest,
	runOnResponse,
	runOnSettled,
} from "./hooks/runner.js";
import { log } from "./logger.js";
import { extractModel, resolveOpenAIPrice } from "./openai/handler.js";
import { formatPrice } from "./pricing/parser.js";
import { resolvePrice } from "./pricing/resolver.js";
import { bufferRequestBody, routeNeedsBody } from "./proxy/body-buffer.js";
import { proxyRequest, UpstreamError } from "./proxy/proxy.js";
import {
	checkRateLimit,
	extractIdentity,
	resolveRateLimit,
} from "./ratelimit/check.js";
import { MemoryRateLimitStore } from "./ratelimit/store.js";
import { rewritePath } from "./router/rewriter.js";
import { matchRoute } from "./router/router.js";
import type {
	RateLimitStore,
	ResolvedRoute,
	TollboothConfig,
	TollboothGateway,
	TollboothRequest,
} from "./types.js";
import { encodePaymentResponse, HEADERS } from "./x402/headers.js";
import {
	buildPaymentRequirements,
	createPaymentRequiredResponse,
	PaymentError,
	processPayment,
} from "./x402/middleware.js";

/**
 * Create a tollbooth gateway from a validated config.
 */
export function createGateway(
	config: TollboothConfig,
	options?: { rateLimitStore?: RateLimitStore },
): TollboothGateway {
	let server: ReturnType<typeof Bun.serve> | null = null;
	const rateLimitStore = options?.rateLimitStore ?? new MemoryRateLimitStore();

	const discoveryPayload = config.gateway.discovery
		? JSON.stringify(generateDiscoveryMetadata(config))
		: null;

	async function handleRequest(request: Request): Promise<Response> {
		const start = performance.now();
		const url = new URL(request.url);

		// Discovery endpoint
		if (discoveryPayload && url.pathname === "/.well-known/x402") {
			return new Response(discoveryPayload, {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Health check
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ status: "ok" }), {
				headers: { "Content-Type": "application/json" },
			});
		}

		// Match route
		const result = matchRoute(request.method, url.pathname, config);
		if (!result.matched) {
			const requested = `${request.method.toUpperCase()} ${url.pathname}`;
			const detail: Record<string, unknown> = {
				error: `Route not found: ${requested}`,
				checked: result.checked,
			};
			if (result.suggestion) {
				detail.suggestion = `Did you mean ${result.suggestion}?`;
			}
			log.warn("route_not_found", {
				method: request.method,
				path: url.pathname,
				status: 404,
			});
			return new Response(JSON.stringify(detail), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const { routeKey, route, upstream, params } = result;

		// Parse query
		const query: Record<string, string> = {};
		for (const [key, value] of url.searchParams.entries()) {
			query[key] = value;
		}

		// Parse headers
		const headers: Record<string, string> = {};
		for (const [key, value] of request.headers.entries()) {
			headers[key] = value;
		}

		// Buffer body if needed for matching
		let parsedBody: unknown;
		let rawBody: ArrayBuffer | undefined;
		const needsBody = routeNeedsBody(route);

		if (needsBody) {
			const buffered = await bufferRequestBody(request);
			parsedBody = buffered.parsed;
			rawBody = buffered.raw;
		}

		// Build TollboothRequest
		const tollboothReq: TollboothRequest = {
			method: request.method,
			path: url.pathname,
			headers,
			query,
			body: parsedBody,
			params,
		};

		try {
			// ── Rate limiting ────────────────────────────────────────────────
			const rateLimit = resolveRateLimit(route.rateLimit, config);
			if (rateLimit) {
				const identity = extractIdentity(request);
				const rlResult = await checkRateLimit(
					rateLimitStore,
					identity,
					routeKey,
					rateLimit,
				);
				if (!rlResult.allowed) {
					const retryAfter = Math.ceil(rlResult.resetMs / 1000);
					log.warn("rate_limited", {
						method: request.method,
						path: url.pathname,
						route: routeKey,
						identity,
						limit: rlResult.limit,
						retry_after_s: retryAfter,
					});
					return new Response(
						JSON.stringify({
							error: "Too many requests",
							retryAfter: retryAfter,
						}),
						{
							status: 429,
							headers: {
								"Content-Type": "application/json",
								"Retry-After": String(retryAfter),
							},
						},
					);
				}
			}

			// ── Hook: onRequest ───────────────────────────────────────────────
			const onRequestResult = await runOnRequest(
				{ req: tollboothReq },
				route.hooks,
				config.hooks,
			);
			if (onRequestResult?.reject) {
				return new Response(onRequestResult.body ?? "Rejected", {
					status: onRequestResult.status ?? 403,
				});
			}

			// ── Resolve price ────────────────────────────────────────────────
			let price: {
				amount: bigint;
				asset: string;
				network: string;
				payTo: string | import("./types.js").PayToSplit[];
			};

			if (route.type === "openai-compatible") {
				const model = extractModel(parsedBody);
				if (!model) {
					return new Response(
						JSON.stringify({
							error: 'Missing or invalid "model" field in request body',
							hint: 'openai-compatible routes require a "model" string in the JSON body',
						}),
						{
							status: 400,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
				price = resolveOpenAIPrice(model, route, config);
			} else {
				price = await resolvePrice({
					route,
					config,
					body: parsedBody,
					query,
					headers,
					params,
				});
			}

			// Determine upstream path
			const upstreamPath = route.path
				? rewritePath(route.path, params, query)
				: url.pathname;

			const resolvedRoute: ResolvedRoute = {
				upstream,
				upstreamPath,
				price: price.amount,
				asset: price.asset,
				network: price.network,
				payTo: price.payTo,
				routeKey,
			};

			// ── Hook: onPriceResolved ────────────────────────────────────────
			const onPriceResult = await runOnPriceResolved(
				{ req: tollboothReq, route: resolvedRoute },
				route.hooks,
				config.hooks,
			);
			if (onPriceResult?.reject) {
				return new Response(onPriceResult.body ?? "Rejected", {
					status: onPriceResult.status ?? 403,
				});
			}

			// ── x402 payment flow ────────────────────────────────────────────
			const accepts = route.accepts ?? config.accepts;
			const requirements = buildPaymentRequirements(
				price,
				url.pathname,
				routeKey,
				config.defaults.timeout,
				accepts,
			);

			// Resolve facilitator: route-level > top-level > default
			const facilitatorUrl = route.facilitator ?? config.facilitator;
			const facilitator = facilitatorUrl ? { url: facilitatorUrl } : undefined;

			const settlement = await processPayment(
				request,
				requirements,
				facilitator,
			);

			if (!settlement) {
				// No payment header → return 402
				return createPaymentRequiredResponse(requirements);
			}

			tollboothReq.payer = settlement.payer;

			log.info("payment_settled", {
				payer: settlement.payer,
				tx_hash: settlement.transaction,
				amount: settlement.amount,
				asset: price.asset,
				network: price.network,
			});

			// ── Hook: onSettled ───────────────────────────────────────────────
			const onSettledResult = await runOnSettled(
				{ req: tollboothReq, route: resolvedRoute, settlement },
				route.hooks,
				config.hooks,
			);
			if (onSettledResult?.reject) {
				return new Response(
					onSettledResult.body ?? "Rejected after settlement",
					{
						status: onSettledResult.status ?? 403,
					},
				);
			}

			// ── Proxy to upstream ────────────────────────────────────────────
			// If we didn't buffer earlier, we need the raw body now
			if (!rawBody && !["GET", "HEAD"].includes(request.method.toUpperCase())) {
				rawBody = await request.arrayBuffer();
			}

			const upstreamResponse = await proxyRequest(
				upstream,
				upstreamPath,
				request,
				rawBody,
				route.upstream,
			);

			// ── Hook: onResponse ─────────────────────────────────────────────
			const modifiedResponse = await runOnResponse(
				{
					req: tollboothReq,
					route: resolvedRoute,
					settlement,
					response: upstreamResponse,
				},
				route.hooks,
				config.hooks,
			);

			const finalResponse = modifiedResponse ?? upstreamResponse;

			// Build the final HTTP response
			const responseHeaders = new Headers(finalResponse.headers);
			responseHeaders.set(
				HEADERS.PAYMENT_RESPONSE,
				encodePaymentResponse(settlement),
			);

			// Ensure SSE-friendly headers for streaming responses
			const contentType = finalResponse.headers["content-type"] ?? "";
			if (contentType.includes("text/event-stream")) {
				if (!responseHeaders.has("cache-control")) {
					responseHeaders.set("cache-control", "no-cache");
				}
			}

			const duration_ms = Math.round(performance.now() - start);
			log.info("request", {
				method: request.method,
				path: url.pathname,
				route: routeKey,
				price: formatPrice(price.amount, price.asset),
				duration_ms,
				status: finalResponse.status,
			});

			return new Response(
				finalResponse.body as string | ReadableStream | null,
				{
					status: finalResponse.status,
					headers: responseHeaders,
				},
			);
		} catch (error) {
			// ── Hook: onError ────────────────────────────────────────────────
			if (error instanceof PaymentError) {
				log.warn("payment_failed", {
					method: request.method,
					path: url.pathname,
					route: routeKey,
					status: error.statusCode,
					error: error.message,
					duration_ms: Math.round(performance.now() - start),
				});
				return new Response(JSON.stringify({ error: error.message }), {
					status: error.statusCode,
					headers: { "Content-Type": "application/json" },
				});
			}

			if (error instanceof UpstreamError) {
				log.error("upstream_error", {
					method: request.method,
					path: url.pathname,
					route: routeKey,
					upstream: error.upstreamUrl,
					error: error.message,
					duration_ms: Math.round(performance.now() - start),
				});
				return new Response(JSON.stringify({ error: error.message }), {
					status: 502,
					headers: { "Content-Type": "application/json" },
				});
			}

			const upstreamPath = route.path
				? rewritePath(route.path, params, query)
				: url.pathname;

			const resolvedRoute: ResolvedRoute = {
				upstream,
				upstreamPath,
				price: 0n,
				asset: "",
				network: "",
				payTo: "",
				routeKey,
			};

			const errMsg = error instanceof Error ? error.message : "Unknown error";

			log.error("internal_error", {
				method: request.method,
				path: url.pathname,
				route: routeKey,
				error: errMsg,
				duration_ms: Math.round(performance.now() - start),
			});

			await runOnError(
				{
					req: tollboothReq,
					route: resolvedRoute,
					error: {
						status: 500,
						message: errMsg,
					},
				},
				route.hooks,
				config.hooks,
			);

			return new Response(JSON.stringify({ error: "Internal gateway error" }), {
				status: 502,
				headers: { "Content-Type": "application/json" },
			});
		}
	}

	return {
		get port() {
			return server?.port ?? config.gateway.port;
		},
		get config() {
			return config;
		},
		async start(options?: { silent?: boolean }) {
			server = Bun.serve({
				port: config.gateway.port,
				hostname: config.gateway.hostname,
				fetch: handleRequest,
			});
			if (!options?.silent) {
				log.info("started", {
					url: `http://localhost:${server.port}`,
					port: server.port,
					...(discoveryPayload
						? {
								discovery: `http://localhost:${server.port}/.well-known/x402`,
							}
						: {}),
				});
			}
		},
		async stop() {
			server?.stop();
			server = null;
			if (rateLimitStore instanceof MemoryRateLimitStore) {
				rateLimitStore.destroy();
			}
		},
	};
}
