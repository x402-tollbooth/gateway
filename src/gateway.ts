import type {
	TollboothConfig,
	TollboothGateway,
	TollboothRequest,
	ResolvedRoute,
} from "./types.js";
import { matchRoute } from "./router/router.js";
import { rewritePath } from "./router/rewriter.js";
import { resolvePrice } from "./pricing/resolver.js";
import { routeNeedsBody, bufferRequestBody } from "./proxy/body-buffer.js";
import { proxyRequest } from "./proxy/proxy.js";
import {
	buildPaymentRequirements,
	createPaymentRequiredResponse,
	processPayment,
	PaymentError,
} from "./x402/middleware.js";
import { HEADERS, encodePaymentResponse } from "./x402/headers.js";
import { generateDiscoveryMetadata } from "./discovery/metadata.js";
import {
	runOnRequest,
	runOnPriceResolved,
	runOnSettled,
	runOnResponse,
	runOnError,
} from "./hooks/runner.js";

/**
 * Create a tollbooth gateway from a validated config.
 */
export function createGateway(config: TollboothConfig): TollboothGateway {
	let server: ReturnType<typeof Bun.serve> | null = null;

	const discoveryPayload = config.gateway.discovery
		? JSON.stringify(generateDiscoveryMetadata(config))
		: null;

	async function handleRequest(request: Request): Promise<Response> {
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
		const matched = matchRoute(request.method, url.pathname, config);
		if (!matched) {
			return new Response(JSON.stringify({ error: "Not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}

		const { routeKey, route, upstream, params } = matched;

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
		let parsedBody: unknown = undefined;
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
			const price = await resolvePrice({
				route,
				config,
				body: parsedBody,
				query,
				headers,
				params,
			});

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

			const settlement = await processPayment(request, requirements);

			if (!settlement) {
				// No payment header → return 402
				return createPaymentRequiredResponse(requirements);
			}

			tollboothReq.payer = settlement.payer;

			// ── Hook: onSettled ───────────────────────────────────────────────
			const onSettledResult = await runOnSettled(
				{ req: tollboothReq, route: resolvedRoute, settlement },
				route.hooks,
				config.hooks,
			);
			if (onSettledResult?.reject) {
				return new Response(onSettledResult.body ?? "Rejected after settlement", {
					status: onSettledResult.status ?? 403,
				});
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

			return new Response(finalResponse.body as string | ReadableStream | null, {
				status: finalResponse.status,
				headers: responseHeaders,
			});
		} catch (error) {
			// ── Hook: onError ────────────────────────────────────────────────
			if (error instanceof PaymentError) {
				return new Response(JSON.stringify({ error: error.message }), {
					status: error.statusCode,
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

			await runOnError(
				{
					req: tollboothReq,
					route: resolvedRoute,
					error: {
						status: 500,
						message: error instanceof Error ? error.message : "Unknown error",
					},
				},
				route.hooks,
				config.hooks,
			);

			return new Response(
				JSON.stringify({ error: "Internal gateway error" }),
				{
					status: 502,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
	}

	return {
		get port() {
			return config.gateway.port;
		},
		get config() {
			return config;
		},
		async start() {
			server = Bun.serve({
				port: config.gateway.port,
				hostname: config.gateway.hostname,
				fetch: handleRequest,
			});
			console.log(`⛩️  tollbooth running on http://localhost:${config.gateway.port}`);
			if (discoveryPayload) {
				console.log(`📡 discovery at http://localhost:${config.gateway.port}/.well-known/x402`);
			}
		},
		async stop() {
			server?.stop();
			server = null;
		},
	};
}
