import type { ResolvedPrice } from "../pricing/resolver.js";
import type { AcceptedPayment, SettlementInfo } from "../types.js";
import {
	type FacilitatorConfig,
	settlePayment,
	toSettlementInfo,
	verifyPayment,
} from "./facilitator.js";
import {
	decodePaymentSignature,
	encodePaymentRequired,
	HEADERS,
} from "./headers.js";

export interface PaymentRequirementsPayload {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	resource: string;
	description: string;
	payTo: string;
	maxTimeoutSeconds: number;
	asset: string;
	// EIP-712 domain info required by the facilitator to verify the signature
	extra?: { name: string; version: string };
}

// Token metadata keyed by "asset:network".
// `address` is the on-chain contract address the facilitator needs for verification.
// `eip712` is the EIP-712 domain info the facilitator uses to reconstruct typed data.
const TOKEN_INFO: Record<
	string,
	{ address: string; eip712: { name: string; version: string } }
> = {
	"USDC:base-sepolia": {
		address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		eip712: { name: "USDC", version: "2" },
	},
	"USDC:base": {
		address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		eip712: { name: "USD Coin", version: "2" },
	},
};

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
	const payTo =
		typeof price.payTo === "string"
			? price.payTo
			: (price.payTo[0]?.address ?? "");

	return accepts.map((accept) => {
		const token = TOKEN_INFO[`${accept.asset}:${accept.network}`];
		return {
			scheme: "exact",
			network: accept.network,
			maxAmountRequired: price.amount.toString(),
			resource,
			description,
			payTo,
			maxTimeoutSeconds: timeout,
			// Use the on-chain contract address; facilitator rejects human-readable names
			asset: token?.address ?? accept.asset,
			extra: token?.eip712,
		};
	});
}

/**
 * Create a 402 Payment Required response.
 */
export function createPaymentRequiredResponse(
	requirements: PaymentRequirementsPayload[],
): Response {
	const body = JSON.stringify({
		accepts: requirements.map((r) => ({ paymentRequirements: r })),
	});
	const encoded = encodePaymentRequired(requirements);

	return new Response(body, {
		status: 402,
		headers: {
			"Content-Type": "application/json",
			[HEADERS.PAYMENT_REQUIRED]: encoded,
		},
	});
}

export interface PaymentResult {
	settlement: SettlementInfo;
	facilitatorUrl: string;
}

export interface VerificationResult {
	payer?: string;
	paymentPayload: unknown;
	requirement: PaymentRequirementsPayload;
	facilitator: FacilitatorConfig;
	facilitatorUrl: string;
}

/**
 * Verify a payment from the request without settling.
 * Returns verification info if payment is valid, null if no payment header present.
 * Throws PaymentError if payment is present but invalid.
 */
export async function processVerification(
	request: Request,
	requirements: PaymentRequirementsPayload[],
	facilitators: FacilitatorConfig[],
): Promise<VerificationResult | null> {
	const paymentHeader = request.headers.get(HEADERS.PAYMENT_SIGNATURE);

	if (!paymentHeader) {
		return null;
	}

	const paymentPayload = decodePaymentSignature(paymentHeader);

	let lastError: PaymentError | null = null;

	for (let i = 0; i < requirements.length; i++) {
		const req = requirements[i];
		const facilitator = facilitators[i] ?? facilitators[0];
		const facilitatorUrl = facilitator?.url ?? "https://x402.org/facilitator";

		let verification: Awaited<ReturnType<typeof verifyPayment>>;
		try {
			verification = await verifyPayment(paymentPayload, req, facilitator);
		} catch (err) {
			lastError = new PaymentError(
				err instanceof Error
					? err.message
					: `Payment verification failed — unknown error (facilitator: ${facilitatorUrl})`,
				402,
			);
			continue;
		}
		if (!verification.isValid) {
			lastError = new PaymentError(
				`Payment verification failed: ${verification.invalidReason ?? "unknown reason"}\n  → Facilitator: ${facilitatorUrl}`,
				402,
			);
			continue;
		}

		return {
			payer: verification.payer,
			paymentPayload,
			requirement: req,
			facilitator,
			facilitatorUrl,
		};
	}

	throw (
		lastError ??
		new PaymentError("Payment verification failed for all payment methods", 402)
	);
}

/**
 * Settle a previously verified payment.
 * Throws PaymentError on settlement failure.
 */
export async function executeSettlement(
	verification: VerificationResult,
): Promise<PaymentResult> {
	const { paymentPayload, requirement, facilitator, facilitatorUrl } =
		verification;

	let settlement: Awaited<ReturnType<typeof settlePayment>>;
	try {
		settlement = await settlePayment(paymentPayload, requirement, facilitator);
	} catch (err) {
		throw new PaymentError(
			err instanceof Error
				? err.message
				: `Payment settlement failed — unknown error (facilitator: ${facilitatorUrl})`,
			502,
		);
	}
	if (!settlement.success) {
		throw new PaymentError(
			`Payment settlement failed: ${settlement.errorReason ?? "unknown reason"}\n  → Facilitator: ${facilitatorUrl}`,
			502,
		);
	}

	const info = toSettlementInfo(settlement);
	info.amount = requirement.maxAmountRequired;
	return { settlement: info, facilitatorUrl };
}

/**
 * Verify and settle a payment in one call (for before-response mode).
 * Returns settlement info if payment is valid, null if no payment header present.
 * Throws if payment is present but invalid or settlement fails.
 */
export async function processPayment(
	request: Request,
	requirements: PaymentRequirementsPayload[],
	facilitators: FacilitatorConfig[],
): Promise<PaymentResult | null> {
	const verification = await processVerification(
		request,
		requirements,
		facilitators,
	);
	if (!verification) return null;
	return executeSettlement(verification);
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
