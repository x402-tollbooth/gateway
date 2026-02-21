import type { ResolvedPrice } from "../pricing/resolver.js";
import type { AcceptedPayment, PaymentRequirementsPayload } from "../types.js";
import { encodePaymentRequired, HEADERS } from "./headers.js";

export type { PaymentRequirementsPayload } from "../types.js";

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

export class PaymentError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message);
		this.name = "PaymentError";
	}
}
