import type { FacilitatorMapping, SettlementInfo } from "../types.js";

const DEFAULT_FACILITATOR = "https://x402.org/facilitator";

export interface FacilitatorConfig {
	url?: string;
}

export interface VerifyResult {
	isValid: boolean;
	invalidReason?: string;
	payer?: string;
}

export interface SettleResult {
	success: boolean;
	payer: string;
	transaction: string;
	network: string;
	errorReason?: string;
}

/**
 * Resolve the facilitator URL for a given network/asset pair.
 *
 * Fallback chain:
 *   route chain-specific → route default → global chain-specific → global default → hardcoded default
 */
export function resolveFacilitatorUrl(
	network: string,
	asset: string,
	routeFacilitator?: string | FacilitatorMapping,
	globalFacilitator?: string | FacilitatorMapping,
): string {
	const key = `${network}/${asset}`.toLowerCase();

	// Route-level
	if (routeFacilitator) {
		if (typeof routeFacilitator === "string") return routeFacilitator;
		const chainUrl = findChainMatch(routeFacilitator.chains, key);
		if (chainUrl) return chainUrl;
		if (routeFacilitator.default) return routeFacilitator.default;
	}

	// Global-level
	if (globalFacilitator) {
		if (typeof globalFacilitator === "string") return globalFacilitator;
		const chainUrl = findChainMatch(globalFacilitator.chains, key);
		if (chainUrl) return chainUrl;
		if (globalFacilitator.default) return globalFacilitator.default;
	}

	return DEFAULT_FACILITATOR;
}

function findChainMatch(
	chains: Record<string, string> | undefined,
	key: string,
): string | undefined {
	if (!chains) return undefined;
	for (const [k, v] of Object.entries(chains)) {
		if (k.toLowerCase() === key) return v;
	}
	return undefined;
}

/**
 * Verify a payment payload with the facilitator without executing it.
 */
export async function verifyPayment(
	paymentPayload: unknown,
	paymentRequirements: unknown,
	facilitator?: FacilitatorConfig,
): Promise<VerifyResult> {
	const baseUrl = facilitator?.url ?? DEFAULT_FACILITATOR;
	const url = `${baseUrl}/verify`;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paymentPayload, paymentRequirements }),
		});
	} catch (err) {
		throw new Error(formatFetchError("verify", baseUrl, err));
	}

	if (!response.ok) {
		throw new Error(
			formatHttpError("verify", baseUrl, response.status, response.statusText),
		);
	}

	return (await response.json()) as VerifyResult;
}

/**
 * Settle a verified payment by broadcasting it to the blockchain.
 */
export async function settlePayment(
	paymentPayload: unknown,
	paymentRequirements: unknown,
	facilitator?: FacilitatorConfig,
): Promise<SettleResult> {
	const baseUrl = facilitator?.url ?? DEFAULT_FACILITATOR;
	const url = `${baseUrl}/settle`;

	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paymentPayload, paymentRequirements }),
		});
	} catch (err) {
		throw new Error(formatFetchError("settle", baseUrl, err));
	}

	if (!response.ok) {
		throw new Error(
			formatHttpError("settle", baseUrl, response.status, response.statusText),
		);
	}

	return (await response.json()) as SettleResult;
}

function formatHttpError(
	operation: string,
	url: string,
	status: number,
	statusText: string,
): string {
	const suggestion =
		status >= 500
			? `Check that the facilitator at ${url} is reachable`
			: `Facilitator rejected the request — verify your payment configuration`;
	return `Facilitator ${operation} failed (${status} ${statusText})\n  → ${suggestion}`;
}

function formatFetchError(
	operation: string,
	url: string,
	err: unknown,
): string {
	const message = err instanceof Error ? err.message : "unknown error";
	if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
		return `Facilitator ${operation} failed — could not connect to ${url}\n  → Check that the facilitator URL is correct and the server is running`;
	}
	if (message.includes("ENOTFOUND") || message.includes("getaddrinfo")) {
		return `Facilitator ${operation} failed — DNS lookup failed for ${url}\n  → Check that the facilitator URL is correct`;
	}
	return `Facilitator ${operation} failed — ${message}\n  → Check that the facilitator at ${url} is reachable`;
}

/**
 * Convert a SettleResult to a SettlementInfo.
 */
export function toSettlementInfo(result: SettleResult): SettlementInfo {
	return {
		payer: result.payer,
		amount: "", // filled in by caller
		transaction: result.transaction,
		network: result.network,
	};
}
