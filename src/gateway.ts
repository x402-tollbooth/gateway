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
import { getEffectiveRoutePricing } from "./pricing/config.js";
import { formatPrice } from "./pricing/parser.js";
import { resolvePrice } from "./pricing/resolver.js";
import { bufferRequestBody, routeNeedsBody } from "./proxy/body-buffer.js";
import { proxyRequest, UpstreamError } from "./proxy/proxy.js";
import {
	checkRateLimit,
	extractIdentity,
	resolveRateLimit,
} from "./ratelimit/check.js";
import { MemoryRateLimitStore, parseWindow } from "./ratelimit/store.js";
import { rewritePath } from "./router/rewriter.js";
import { matchRoute } from "./router/router.js";
import {
	buildSessionKey,
	MemoryTimeSessionStore,
	parseDuration,
} from "./session/store.js";
import { FacilitatorSettlement } from "./settlement/facilitator.js";
import {
	createFacilitatorStrategy,
	initSettlementStrategy,
} from "./settlement/loader.js";
import type {
	PaymentRequirementsPayload,
	PayToSplit,
	RateLimitStore,
	ResolvedRoute,
	RouteConfig,
	SettlementDecision,
	SettlementInfo,
	SettlementStrategy,
	SettlementVerification,
	TimeSessionStore,
	TollboothConfig,
	TollboothGateway,
	TollboothRequest,
	UpstreamConfig,
	UpstreamResponse,
	VerificationCacheConfig,
	VerificationCacheStore,
} from "./types.js";
import { MemoryVerificationCacheStore } from "./verification-cache/store.js";
import {
	decodePaymentSignature,
	encodePaymentResponse,
	extractPayerFromHeader,
	HEADERS,
} from "./x402/headers.js";
import {
	buildPaymentRequirements,
	createPaymentRequiredResponse,
	PaymentError,
} from "./x402/middleware.js";
import { extractPayerFromPaymentHeader } from "./x402/payer.js";

interface AfterResponseCtx {
	request: Request;
	tollboothReq: TollboothRequest;
	route: RouteConfig;
	routeKey: string;
	upstream: UpstreamConfig;
	upstreamPath: string;
	resolvedRoute: ResolvedRoute;
	rawBody: ArrayBuffer | undefined;
	requirements: PaymentRequirementsPayload[];
	strategy: SettlementStrategy;
	verification: SettlementVerification;
	price: {
		amount: bigint;
		asset: string;
		network: string;
		payTo: string | PayToSplit[];
	};
	timeSessionDurationMs?: number;
	url: URL;
	start: number;
}

interface FinalResponseCtx {
	response: UpstreamResponse;
	settlement?: SettlementInfo;
	settlementSkippedReason?: string;
	price: { amount: bigint; asset: string };
	request: Request;
	url: URL;
	routeKey: string;
	start: number;
}

interface ErrorCtx {
	request: Request;
	tollboothReq: TollboothRequest;
	url: URL;
	routeKey: string;
	route: RouteConfig;
	upstream: UpstreamConfig;
	params: Record<string, string>;
	query: Record<string, string>;
	resolvedRoute?: ResolvedRoute;
	start: number;
}

/**
 * Create a tollbooth gateway from a validated config.
 */
export function createGateway(
	config: TollboothConfig,
	options?: {
		rateLimitStore?: RateLimitStore;
		verificationCacheStore?: VerificationCacheStore;
		timeSessionStore?: TimeSessionStore;
	},
): TollboothGateway {
	let server: ReturnType<typeof Bun.serve> | null = null;
	const rateLimitStore = options?.rateLimitStore ?? new MemoryRateLimitStore();
	const verificationCacheStore =
		options?.verificationCacheStore ?? new MemoryVerificationCacheStore();
	const timeSessionStore =
		options?.timeSessionStore ?? new MemoryTimeSessionStore();

	const discoveryPayload = config.gateway.discovery
		? JSON.stringify(generateDiscoveryMetadata(config))
		: null;

	// Pre-loaded custom strategy (set during start())
	let customStrategy: SettlementStrategy | null = null;

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

		let resolvedRoute: ResolvedRoute | undefined;
		const settlementTiming = route.settlement ?? "before-response";

		try {
			// ── Identity (shared by rate limiting + verification cache) ──────
			const identity = extractIdentity(request);

			// ── Rate limiting ────────────────────────────────────────────────
			const rateLimit = resolveRateLimit(route.rateLimit, config);
			if (rateLimit) {
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

			if (route.type === "token-based" || route.type === "openai-compatible") {
				const model = extractModel(parsedBody);
				if (!model) {
					return new Response(
						JSON.stringify({
							error: 'Missing or invalid "model" field in request body',
							hint: 'token-based routes require a "model" string in the JSON body',
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

			resolvedRoute = {
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

			const routePricing = getEffectiveRoutePricing(route);
			const timeDuration =
				routePricing.model === "time" ? routePricing.duration : undefined;
			if (routePricing.model === "time" && !timeDuration) {
				throw new Error(
					`Route "${routeKey}" requires pricing.duration when pricing.model is "time"`,
				);
			}

			const timeSessionDurationMs = timeDuration
				? parseDuration(timeDuration)
				: undefined;

			// ── x402 payment flow ────────────────────────────────────────────
			const accepts = route.accepts ?? config.accepts;
			const requirements = buildPaymentRequirements(
				price,
				url.pathname,
				routeKey,
				config.defaults.timeout,
				accepts,
			);

			// ── Extract payment from request ────────────────────────────────
			const paymentHeader = request.headers.get(HEADERS.PAYMENT_SIGNATURE);
			if (!paymentHeader && timeSessionDurationMs == null) {
				return createPaymentRequiredResponse(requirements);
			}
			const payment = paymentHeader
				? decodePaymentSignature(paymentHeader)
				: null;

			// ── Resolve settlement strategy ─────────────────────────────────
			const strategy =
				customStrategy ??
				createFacilitatorStrategy(
					accepts,
					route.facilitator,
					config.facilitator,
					config.settlement?.url,
				);

			// ── Time-based pricing: skip settlement when session is still active ──
			if (timeSessionDurationMs != null && payment) {
				const claimedPayer = extractPayerFromPaymentHeader(request);
				if (claimedPayer) {
					const sessionKey = buildSessionKey(routeKey, claimedPayer);
					const expiresAt = await timeSessionStore.get(sessionKey);
					if (expiresAt != null) {
						// Session exists — verify the signature is authentic before
						// granting access (prevents forged payment-signature headers).
						const verification = await strategy.verify(payment, requirements);

						tollboothReq.payer = verification.payer ?? claimedPayer;

						log.debug("time_session_active", {
							routeKey,
							payer: tollboothReq.payer,
						});

						if (
							!rawBody &&
							!["GET", "HEAD"].includes(request.method.toUpperCase())
						) {
							rawBody = await request.arrayBuffer();
						}

						const upstreamResponse = await proxyRequest(
							upstream,
							upstreamPath,
							request,
							rawBody,
							route.upstream,
						);

						const hookResult = await runOnResponse(
							{
								req: tollboothReq,
								route: resolvedRoute,
								response: upstreamResponse,
							},
							route.hooks,
							config.hooks,
						);

						const finalResponse = isUpstreamResponse(hookResult)
							? hookResult
							: upstreamResponse;

						return buildFinalResponse({
							response: finalResponse,
							price,
							request,
							url,
							routeKey,
							start,
						});
					}
				}
			}

			// No payment header → require payment
			if (!paymentHeader || !payment) {
				return createPaymentRequiredResponse(requirements);
			}

			// ── Verification cache config ────────────────────────────────────
			const vcConfig = resolveVerificationCache(
				route.verificationCache,
				config,
			);
			const vcCacheKey =
				identity.startsWith("payer:") && vcConfig
					? `vc:${routeKey}:${identity}`
					: null;

			// ── Verify payment (with optional cache) ────────────────────────
			const verification = await cachedVerify(
				strategy,
				payment,
				paymentHeader,
				requirements,
				vcCacheKey,
				vcConfig,
			);

			if (verification.payer) {
				tollboothReq.payer = verification.payer;
			}

			// ── Branch on settlement timing ─────────────────────────────────
			if (settlementTiming === "after-response") {
				return await handleAfterResponse({
					request,
					tollboothReq,
					resolvedRoute: resolvedRoute as ResolvedRoute,
					upstream,
					upstreamPath,
					rawBody,
					requirements,
					strategy,
					verification,
					price,
					timeSessionDurationMs,
					route,
					routeKey,
					url,
					start,
				});
			}

			// ── before-response (default): settle immediately ───────────────
			const settlement = await strategy.settle(verification);
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
					{ status: onSettledResult.status ?? 403 },
				);
			}

			if (timeSessionDurationMs != null) {
				await grantTimeSession(
					routeKey,
					settlement.payer,
					timeSessionDurationMs,
				);
			}

			// ── Proxy to upstream ────────────────────────────────────────────
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
			const hookResult = await runOnResponse(
				{
					req: tollboothReq,
					route: resolvedRoute,
					settlement,
					response: upstreamResponse,
				},
				route.hooks,
				config.hooks,
			);

			// In before-response mode, only accept UpstreamResponse modifications
			const finalResponse = isUpstreamResponse(hookResult)
				? hookResult
				: upstreamResponse;

			return buildFinalResponse({
				response: finalResponse,
				settlement,
				price,
				request,
				url,
				routeKey,
				start,
			});
		} catch (error) {
			return handleError(error, {
				request,
				tollboothReq,
				url,
				routeKey,
				route,
				upstream,
				params,
				query,
				resolvedRoute,
				start,
			});
		}
	}

	/**
	 * Handle the after-response settlement timing.
	 * Payment already verified → proxy → conditionally settle based on upstream response.
	 */
	async function handleAfterResponse(ctx: AfterResponseCtx): Promise<Response> {
		const {
			request,
			tollboothReq,
			resolvedRoute,
			upstream,
			upstreamPath,
			strategy,
			verification,
			price,
			timeSessionDurationMs,
			route,
			routeKey,
			url,
			start,
		} = ctx;
		let rawBody = ctx.rawBody;

		// ── Proxy to upstream ────────────────────────────────────────────
		if (!rawBody && !["GET", "HEAD"].includes(request.method.toUpperCase())) {
			rawBody = await request.arrayBuffer();
		}

		let upstreamResponse: UpstreamResponse;
		try {
			upstreamResponse = await proxyRequest(
				upstream,
				upstreamPath,
				request,
				rawBody,
				route.upstream,
			);
		} catch (error) {
			// Upstream connection failure — don't settle
			if (error instanceof UpstreamError) {
				const reason = "upstream_unreachable";
				log.info("settlement_skipped", {
					payer: verification.payer,
					reason,
					upstream_status: 502,
				});

				await runOnError(
					{
						req: tollboothReq,
						route: resolvedRoute,
						settlementSkipped: { reason },
						error: {
							status: 502,
							message: error.message,
							upstream: error.upstreamUrl,
						},
					},
					route.hooks,
					config.hooks,
				);

				log.error("upstream_error", {
					method: request.method,
					path: url.pathname,
					route: routeKey,
					upstream: error.upstreamUrl,
					error: error.message,
					duration_ms: Math.round(performance.now() - start),
					settlement_skipped: true,
				});

				return new Response(JSON.stringify({ error: error.message }), {
					status: 502,
					headers: {
						"Content-Type": "application/json",
						"x-tollbooth-settlement-skipped": JSON.stringify({ reason }),
					},
				});
			}
			throw error;
		}

		// ── Hook: onResponse (no settlement in context yet) ──────────────
		const hookResult = await runOnResponse(
			{
				req: tollboothReq,
				route: resolvedRoute,
				response: upstreamResponse,
			},
			route.hooks,
			config.hooks,
		);

		// Determine final response and settlement decision
		let finalResponse: UpstreamResponse;
		let shouldSettle: boolean;
		let skipReason: string | undefined;

		if (isSettlementDecision(hookResult)) {
			finalResponse = upstreamResponse;
			shouldSettle = hookResult.settle;
			skipReason = hookResult.reason;
		} else {
			finalResponse = isUpstreamResponse(hookResult)
				? hookResult
				: upstreamResponse;
			// Default: settle if original upstream status < 500
			shouldSettle = shouldSettleByDefault(upstreamResponse.status);
		}

		if (shouldSettle) {
			// ── Settle via strategy ──────────────────────────────────────
			const settlement = await strategy.settle(verification);
			tollboothReq.payer = settlement.payer;

			log.info("payment_settled", {
				payer: settlement.payer,
				tx_hash: settlement.transaction,
				amount: settlement.amount,
				asset: price.asset,
				network: price.network,
			});

			// ── Hook: onSettled ──────────────────────────────────────────
			const onSettledResult = await runOnSettled(
				{ req: tollboothReq, route: resolvedRoute, settlement },
				route.hooks,
				config.hooks,
			);
			if (onSettledResult?.reject) {
				return new Response(
					onSettledResult.body ?? "Rejected after settlement",
					{ status: onSettledResult.status ?? 403 },
				);
			}

			if (timeSessionDurationMs != null) {
				await grantTimeSession(
					routeKey,
					settlement.payer,
					timeSessionDurationMs,
				);
			}

			return buildFinalResponse({
				response: finalResponse,
				settlement,
				price,
				request,
				url,
				routeKey,
				start,
			});
		}

		// ── Settlement skipped ───────────────────────────────────────────
		const reason = skipReason ?? defaultSkipReason(upstreamResponse.status);

		log.info("settlement_skipped", {
			payer: verification.payer,
			reason,
			upstream_status: upstreamResponse.status,
		});

		await runOnError(
			{
				req: tollboothReq,
				route: resolvedRoute,
				settlementSkipped: { reason },
				error: {
					status: upstreamResponse.status,
					message: `Upstream returned ${upstreamResponse.status}`,
					upstream: upstream.url,
				},
			},
			route.hooks,
			config.hooks,
		);

		return buildFinalResponse({
			response: finalResponse,
			settlementSkippedReason: reason,
			price,
			request,
			url,
			routeKey,
			start,
		});
	}

	async function grantTimeSession(
		routeKey: string,
		payer: string,
		durationMs: number,
	): Promise<void> {
		const sessionKey = buildSessionKey(routeKey, payer);
		await timeSessionStore.set(sessionKey, Date.now() + durationMs);
	}

	/**
	 * Build the final HTTP response with appropriate payment/settlement headers.
	 */
	function buildFinalResponse(ctx: FinalResponseCtx): Response {
		const {
			response: finalResponse,
			settlement,
			settlementSkippedReason,
			price,
			request,
			url,
			routeKey,
			start,
		} = ctx;
		const responseHeaders = new Headers(finalResponse.headers);

		if (settlement) {
			responseHeaders.set(
				HEADERS.PAYMENT_RESPONSE,
				encodePaymentResponse(settlement),
			);
		}

		if (settlementSkippedReason) {
			responseHeaders.set(
				"x-tollbooth-settlement-skipped",
				JSON.stringify({ reason: settlementSkippedReason }),
			);
		}

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
			...(settlementSkippedReason ? { settlement_skipped: true } : {}),
		});

		return new Response(finalResponse.body as string | ReadableStream | null, {
			status: finalResponse.status,
			headers: responseHeaders,
		});
	}

	/**
	 * Handle errors from the try block.
	 */
	function handleError(error: unknown, ctx: ErrorCtx): Response {
		const {
			request,
			tollboothReq,
			url,
			routeKey,
			route,
			upstream,
			params,
			query,
			resolvedRoute,
			start,
		} = ctx;
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

		const fallbackRoute: ResolvedRoute = resolvedRoute ?? {
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

		// Fire-and-forget: don't await in a sync return path
		runOnError(
			{
				req: tollboothReq,
				route: fallbackRoute,
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

	return {
		get port() {
			return server?.port ?? config.gateway.port;
		},
		get config() {
			return config;
		},
		async start(options?: { silent?: boolean }) {
			// Load custom settlement strategy if configured
			customStrategy = await initSettlementStrategy(config);

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
			if (verificationCacheStore instanceof MemoryVerificationCacheStore) {
				verificationCacheStore.destroy();
			}
			timeSessionStore.close();
		},
	};

	/**
	 * Verify a payment via the settlement strategy with optional caching.
	 *
	 * Caching only applies to FacilitatorSettlement (not custom strategies).
	 * On cache hit, rebuilds a verification from the cached requirement index
	 * without calling the facilitator /verify endpoint. On cache miss, verifies
	 * normally and caches the result.
	 *
	 * Note: on cache hit the facilitator /verify call is skipped but /settle still
	 * runs per-request, so invalid payments will fail at settlement time.
	 */
	async function cachedVerify(
		strategy: SettlementStrategy,
		payment: unknown,
		paymentHeader: string,
		requirements: PaymentRequirementsPayload[],
		cacheKey: string | null,
		cacheConfig: VerificationCacheConfig | undefined,
	): Promise<SettlementVerification> {
		const isFacilitator = strategy instanceof FacilitatorSettlement;

		// Try cache (only for facilitator strategy)
		if (isFacilitator && cacheKey && cacheConfig) {
			const cached = await verificationCacheStore.get(cacheKey);
			if (cached) {
				const idx = cached.requirementIndex;
				if (idx >= requirements.length) {
					log.warn("verification_cache_stale", {
						route: cacheKey,
						cachedIndex: idx,
						requirementsCount: requirements.length,
					});
				}
				const payer = extractPayerFromHeader(paymentHeader);
				log.info("verification_cache_hit", { route: cacheKey });
				return strategy.rebuildVerification(payment, payer, idx, requirements);
			}
		}

		// Cache miss — full verify via strategy
		if (cacheKey) {
			log.debug("verification_cache_miss", { route: cacheKey });
		}
		const verification = await strategy.verify(payment, requirements);

		// Cache successful verification (facilitator only)
		if (isFacilitator && cacheKey && cacheConfig) {
			const idx = FacilitatorSettlement.getRequirementIndex(verification);
			if (idx !== undefined) {
				const ttlMs = parseWindow(cacheConfig.ttl);
				await verificationCacheStore.set(
					cacheKey,
					{ requirementIndex: idx },
					ttlMs,
				);
				log.debug("verification_cache_set", {
					route: cacheKey,
					ttl: cacheConfig.ttl,
				});
			}
		}

		return verification;
	}
}

function shouldSettleByDefault(status: number): boolean {
	return status < 500;
}

function defaultSkipReason(status: number): string {
	if (status >= 500) return "upstream_5xx";
	return "upstream_error";
}

function isSettlementDecision(result: unknown): result is SettlementDecision {
	return result != null && typeof result === "object" && "settle" in result;
}

function isUpstreamResponse(result: unknown): result is UpstreamResponse {
	return (
		result != null &&
		typeof result === "object" &&
		"status" in result &&
		"headers" in result
	);
}

function resolveVerificationCache(
	routeCache: VerificationCacheConfig | undefined,
	config: TollboothConfig,
): VerificationCacheConfig | undefined {
	return routeCache ?? config.defaults.verificationCache;
}
