import type { SettlementInfo, AcceptedPayment } from "../types.js";
import type { ResolvedPrice } from "../pricing/resolver.js";
import { HEADERS, encodePaymentRequired, decodePaymentSignature } from "./headers.js";
import { verifyPayment, settlePayment, toSettlementInfo } from "./facilitator.js";

export interface PaymentRequirementsPayload {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	resource: string;
	description: string;
	payTo: string;
	maxTimeoutSeconds: number;
	asset: string;
}

/**
 * Build the payment requirements payload for a 402 response.
 */
export function buildPaymentRequirements(
	price: ResolvedPrice,
	resource: string,
	description: string,
	timeout: number,
	accepts: AcceptedPayment[],
): PaymentRequirementsPayload[] {
	const payTo = typeof price.payTo === "string" ? price.payTo : price.payTo[0]?.address ?? "";

	return accepts.map((accept) => ({
		scheme: "exact",
		network: accept.network,
		maxAmountRequired: price.amount.toString(),
		resource,
		description,
		payTo,
		maxTimeoutSeconds: timeout,
		asset: accept.asset,
	}));
}

/**
 * Create a 402 Payment Required response.
 */
export function createPaymentRequiredResponse(
	requirements: PaymentRequirementsPayload[],
): Response {
	const body = JSON.stringify({ accepts: requirements.map((r) => ({ paymentRequirements: r })) });
	const encoded = encodePaymentRequired(requirements);

	return new Response(body, {
		status: 402,
		headers: {
			"Content-Type": "application/json",
			[HEADERS.PAYMENT_REQUIRED]: encoded,
		},
	});
}

/**
 * Attempt to extract and verify a payment from the request.
 * Returns settlement info if payment is valid, null if no payment header present.
 * Throws if payment is present but invalid.
 */
export async function processPayment(
	request: Request,
	requirements: PaymentRequirementsPayload[],
): Promise<SettlementInfo | null> {
	const paymentHeader = request.headers.get(HEADERS.PAYMENT_SIGNATURE);

	if (!paymentHeader) {
		return null;
	}

	const paymentPayload = decodePaymentSignature(paymentHeader);

	// Use the first matching requirement for verification
	const paymentRequirements = requirements[0];

	// Verify
	const verification = await verifyPayment(paymentPayload, paymentRequirements);
	if (!verification.isValid) {
		throw new PaymentError(
			`Payment verification failed: ${verification.invalidReason ?? "unknown reason"}`,
			402,
		);
	}

	// Settle
	const settlement = await settlePayment(paymentPayload, paymentRequirements);
	if (!settlement.success) {
		throw new PaymentError(
			`Payment settlement failed: ${settlement.errorReason ?? "unknown reason"}`,
			502,
		);
	}

	const info = toSettlementInfo(settlement);
	info.amount = paymentRequirements.maxAmountRequired;

	return info;
}

export class PaymentError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message);
		this.name = "PaymentError";
	}
}
