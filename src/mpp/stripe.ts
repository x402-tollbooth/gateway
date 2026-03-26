import Stripe from "stripe";
import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementVerification,
} from "../types.js";
import { PaymentError } from "../x402/middleware.js";
import { base64UrlEncode } from "./headers.js";
import type { MppChallenge, MppMethod } from "./types.js";

interface StripeVerification extends SettlementVerification {
	paymentIntentId: string;
	requirementIndex: number;
	amount: string;
	currency: string;
}

/**
 * Stripe payment method for MPP.
 *
 * Accepts fiat card payments via Stripe's Shared Payment Tokens (SPT).
 * The server creates a PaymentIntent as the challenge, the client
 * confirms it with their SPT, and the server verifies completion.
 */
export class StripeMethod implements MppMethod {
	readonly type = "stripe" as const;
	private stripe: Stripe;

	constructor(config: { secretKey: string }) {
		this.stripe = new Stripe(config.secretKey);
	}

	async buildChallenge(
		requirement: PaymentRequirementsPayload,
		challengeId: string,
		description: string,
	): Promise<MppChallenge> {
		// Convert from smallest units (e.g. USDC 6 decimals) to Stripe's
		// smallest unit (cents for USD). USDC amounts are in 10^6; Stripe
		// wants cents (10^2), so divide by 10^4.
		const rawAmount = BigInt(requirement.maxAmountRequired);
		const stripeAmount = Number(rawAmount / 10_000n) || 1; // minimum 1 cent

		const intent = await this.stripe.paymentIntents.create({
			amount: stripeAmount,
			currency: "usd",
			payment_method_types: ["card"],
			metadata: {
				mpp_challenge_id: challengeId,
				resource: requirement.resource,
				network: requirement.network,
			},
		});

		const request = base64UrlEncode(
			JSON.stringify({
				clientSecret: intent.client_secret,
				paymentIntentId: intent.id,
			}),
		);

		return {
			id: challengeId,
			method: "stripe",
			intent: "charge",
			amount: (stripeAmount / 100).toFixed(2),
			currency: "usd",
			decimals: 2,
			description,
			request,
		};
	}

	async verify(
		payload: unknown,
		_requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		const cred = payload as Record<string, unknown>;

		// The credential payload should contain the confirmed PaymentIntent ID
		const paymentIntentId =
			(cred.paymentIntentId as string) ?? (cred.id as string);
		if (!paymentIntentId || typeof paymentIntentId !== "string") {
			throw new PaymentError("Missing paymentIntentId in credential", 402);
		}

		// Retrieve the PaymentIntent to check its status
		let intent: Stripe.PaymentIntent;
		try {
			intent = await this.stripe.paymentIntents.retrieve(paymentIntentId);
		} catch (err) {
			throw new PaymentError(
				err instanceof Error
					? `Stripe verification failed: ${err.message}`
					: "Stripe verification failed",
				402,
			);
		}

		if (intent.status !== "succeeded" && intent.status !== "requires_capture") {
			// If the client sent a payment_method (SPT), try to confirm
			const paymentMethod = cred.paymentMethod as string | undefined;
			if (paymentMethod) {
				try {
					intent = await this.stripe.paymentIntents.confirm(paymentIntentId, {
						payment_method: paymentMethod,
					});
				} catch (err) {
					throw new PaymentError(
						err instanceof Error
							? `Stripe payment failed: ${err.message}`
							: "Stripe payment failed",
						402,
					);
				}
			}

			if (
				intent.status !== "succeeded" &&
				intent.status !== "requires_capture"
			) {
				throw new PaymentError(
					`Stripe payment not completed (status: ${intent.status})`,
					402,
				);
			}
		}

		const verification: StripeVerification = {
			payer: intent.metadata?.payer ?? `stripe:${intent.id}`,
			paymentIntentId: intent.id,
			requirementIndex: 0,
			amount: intent.amount.toString(),
			currency: intent.currency,
		};
		return verification;
	}

	async settle(verification: SettlementVerification): Promise<SettlementInfo> {
		if (!isStripeVerification(verification)) {
			throw new PaymentError(
				"settle() received a verification not produced by StripeMethod",
				500,
			);
		}

		// Stripe PaymentIntents are captured on confirm (automatic capture).
		// Nothing more to do — return the settlement info.
		return {
			payer: verification.payer ?? `stripe:${verification.paymentIntentId}`,
			amount: verification.amount,
			transaction: verification.paymentIntentId,
			network: "stripe",
		};
	}
}

function isStripeVerification(
	v: SettlementVerification,
): v is StripeVerification {
	return "paymentIntentId" in v;
}
