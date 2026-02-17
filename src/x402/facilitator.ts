import type { SettlementInfo } from "../types.js";

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
 * Verify a payment payload with the facilitator without executing it.
 */
export async function verifyPayment(
	paymentPayload: unknown,
	paymentRequirements: unknown,
	facilitator?: FacilitatorConfig,
): Promise<VerifyResult> {
	const url = `${facilitator?.url ?? DEFAULT_FACILITATOR}/verify`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paymentPayload, paymentRequirements }),
	});

	if (!response.ok) {
		throw new Error(`Facilitator verify failed: ${response.status} ${response.statusText}`);
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
	const url = `${facilitator?.url ?? DEFAULT_FACILITATOR}/settle`;

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ paymentPayload, paymentRequirements }),
	});

	if (!response.ok) {
		throw new Error(`Facilitator settle failed: ${response.status} ${response.statusText}`);
	}

	return (await response.json()) as SettleResult;
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
