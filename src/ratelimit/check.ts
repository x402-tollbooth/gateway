import type {
	RateLimitConfig,
	RateLimitResult,
	RateLimitStore,
	TollboothConfig,
} from "../types.js";
import { extractPayerFromHeader } from "../x402/headers.js";
import { parseWindow } from "./store.js";

/**
 * Extract the payer identity from the request.
 *
 * Priority:
 *   1. Wallet address decoded from the payment-signature header
 *   2. Client IP from X-Forwarded-For or connection
 */
export function extractIdentity(request: Request): string {
	const paymentHeader = request.headers.get("payment-signature");
	if (paymentHeader) {
		const payer = extractPayerFromHeader(paymentHeader);
		if (payer) return `payer:${payer.toLowerCase()}`;
	}

	const forwarded = request.headers.get("x-forwarded-for");
	if (forwarded) {
		const ip = forwarded.split(",")[0].trim();
		if (ip) return `ip:${ip}`;
	}

	// Bun exposes the remote address on the server object, but it isn't on
	// the Request itself. Fall back to a generic key.
	return "ip:unknown";
}

/**
 * Resolve the effective rate limit config for a route.
 * Route-level overrides global defaults.
 */
export function resolveRateLimit(
	routeRateLimit: RateLimitConfig | undefined,
	config: TollboothConfig,
): RateLimitConfig | undefined {
	return routeRateLimit ?? config.defaults.rateLimit;
}

/**
 * Check rate limit and return the result.
 * Returns null if no rate limit is configured.
 */
export async function checkRateLimit(
	store: RateLimitStore,
	identity: string,
	routeKey: string,
	rateLimit: RateLimitConfig,
): Promise<RateLimitResult> {
	const windowMs = parseWindow(rateLimit.window);
	const key = `${routeKey}:${identity}`;
	return store.check(key, rateLimit.requests, windowMs);
}
