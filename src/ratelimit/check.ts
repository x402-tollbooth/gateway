import { resolveClientIp } from "../network/client-ip.js";
import type {
	RateLimitConfig,
	RateLimitResult,
	RateLimitStore,
	TollboothConfig,
	TrustProxyConfig,
} from "../types.js";
import { extractPayerFromPaymentHeader } from "../x402/payer.js";
import { parseWindow } from "./store.js";

/**
 * Extract the payer identity from the request.
 *
 * Priority:
 *   1. Wallet address decoded from the payment-signature header
 *   2. Client IP from remote socket / trusted forwarded headers
 */
export function extractIdentity(
	request: Request,
	options?: {
		clientIp?: string;
		remoteIp?: string;
		trustProxy?: TrustProxyConfig;
	},
): string {
	const payer = extractPayerFromPaymentHeader(request);
	if (payer) {
		return `payer:${payer}`;
	}

	const ip =
		options?.clientIp ??
		resolveClientIp(request, {
			remoteIp: options?.remoteIp,
			trustProxy: options?.trustProxy,
		});
	if (ip) return `ip:${ip}`;

	// Fall back to a generic key when no payer or IP can be determined.
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
