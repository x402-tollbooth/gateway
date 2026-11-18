import Stripe from "stripe";
import type {
	PaymentClaimStore,
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementVerification,
} from "../types.js";
import { MemoryVerificationCacheStore } from "../verification-cache/store.js";
import { PaymentError } from "../x402/middleware.js";
import { base64UrlEncode } from "./headers.js";
import type { MppChallenge, MppMethod, MppVerifyContext } from "./types.js";

/**
 * PaymentIntents older than this are rejected. Bounds how long a spent-intent
 * claim has to be remembered: the claim TTL is longer than this window, so an
 * intent can never outlive its claim and be replayed.
 */
const MAX_INTENT_AGE_MS = 60 * 60 * 1000; // 1 hour
const CLAIM_TTL_MS = 2 * MAX_INTENT_AGE_MS;

const STRIPE_CURRENCY = "usd";

interface StripeVerification extends SettlementVerification {
	paymentIntentId: string;
	requirementIndex: number;
	amount: string;
	currency: string;
}

/** The subset of the Stripe client this method uses (injectable for tests). */
export interface StripePaymentIntentsClient {
	paymentIntents: {
		create(
			params: Stripe.PaymentIntentCreateParams,
		): Promise<Stripe.PaymentIntent>;
		retrieve(id: string): Promise<Stripe.PaymentIntent>;
		confirm(
			id: string,
			params?: Stripe.PaymentIntentConfirmParams,
		): Promise<Stripe.PaymentIntent>;
	};
}

export interface StripeMethodOptions {
	secretKey: string;
	/**
	 * Store used to mark PaymentIntents as spent. Use a shared (Redis) store
	 * when running more than one gateway instance. Defaults to in-memory.
	 */
	claimStore?: PaymentClaimStore;
	/** Override the Stripe client (tests). */
	client?: StripePaymentIntentsClient;
}

/**
 * Stripe payment method for MPP.
 *
 * Accepts fiat card payments via Stripe's Shared Payment Tokens (SPT).
 * The server creates a PaymentIntent as the challenge, the client
 * confirms it with their SPT, and the server verifies completion.
 *
 * A PaymentIntent is only accepted if it was created by this gateway for the
 * challenge the client is answering, covers the current route's price, and
 * has not been used before.
 */
export class StripeMethod implements MppMethod {
	readonly type = "stripe" as const;
	private stripe: StripePaymentIntentsClient;
	private claimStore: PaymentClaimStore;

	constructor(config: StripeMethodOptions) {
		this.stripe = config.client ?? new Stripe(config.secretKey);
		this.claimStore = config.claimStore ?? new MemoryVerificationCacheStore();
	}

	async buildChallenge(
		requirement: PaymentRequirementsPayload,
		challengeId: string,
		description: string,
	): Promise<MppChallenge> {
		const stripeAmount = toStripeAmount(requirement.maxAmountRequired);

		const intent = await this.stripe.paymentIntents.create({
			amount: stripeAmount,
			currency: STRIPE_CURRENCY,
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
			currency: STRIPE_CURRENCY,
			decimals: 2,
			description,
			request,
		};
	}

	async verify(
		payload: unknown,
		requirements: PaymentRequirementsPayload[],
		context?: MppVerifyContext,
	): Promise<SettlementVerification> {
		const cred = (payload ?? {}) as Record<string, unknown>;

		// The credential payload should contain the confirmed PaymentIntent ID
		const paymentIntentId = cred.paymentIntentId ?? cred.id;
		if (!paymentIntentId || typeof paymentIntentId !== "string") {
			throw new PaymentError("Missing paymentIntentId in credential", 402);
		}

		const challengeId = context?.challengeId;
		if (!challengeId) {
			throw new PaymentError(
				"Stripe payments must be sent as an MPP credential with a challenge id",
				402,
			);
		}

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

		// ── Bind the intent to this challenge and route ─────────────────────
		// Checked before any confirm, so we never confirm an intent that
		// couldn't pay for this request.
		if (intent.metadata?.mpp_challenge_id !== challengeId) {
			throw new PaymentError(
				"PaymentIntent was not issued for this challenge",
				402,
			);
		}

		const createdMs = intent.created * 1000;
		if (Date.now() - createdMs > MAX_INTENT_AGE_MS) {
			throw new PaymentError("PaymentIntent has expired", 402);
		}

		const requirementIndex = findMatchingRequirement(intent, requirements);
		if (requirementIndex === -1) {
			throw new PaymentError(
				"PaymentIntent does not match this route's payment requirements",
				402,
			);
		}

		// ── Make sure it's paid ─────────────────────────────────────────────
		if (!isPaid(intent)) {
			// If the client sent a payment_method (SPT), try to confirm
			const paymentMethod = cred.paymentMethod;
			if (typeof paymentMethod === "string" && paymentMethod) {
				try {
					intent = await this.stripe.paymentIntents.confirm(intent.id, {
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

			if (!isPaid(intent)) {
				throw new PaymentError(
					`Stripe payment not completed (status: ${intent.status})`,
					402,
				);
			}
		}

		// ── Spend it exactly once ───────────────────────────────────────────
		const claimed = await this.claimStore.claim(
			`mpp:stripe:pi:${intent.id}`,
			CLAIM_TTL_MS,
		);
		if (!claimed) {
			throw new PaymentError("PaymentIntent has already been used", 402);
		}

		const verification: StripeVerification = {
			payer: intent.metadata?.payer ?? `stripe:${intent.id}`,
			paymentIntentId: intent.id,
			requirementIndex,
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

/**
 * Convert from smallest token units (e.g. USDC, 6 decimals) to Stripe's
 * smallest unit (cents for USD): divide by 10^4, minimum 1 cent.
 */
function toStripeAmount(maxAmountRequired: string): number {
	const rawAmount = BigInt(maxAmountRequired);
	return Number(rawAmount / 10_000n) || 1;
}

/**
 * Index of the first requirement this intent pays for, or -1.
 * The intent must carry the requirement's resource and network in its
 * metadata, be in USD, and cover at least the requirement's price.
 */
function findMatchingRequirement(
	intent: Stripe.PaymentIntent,
	requirements: PaymentRequirementsPayload[],
): number {
	if (intent.currency !== STRIPE_CURRENCY) return -1;
	return requirements.findIndex(
		(req) =>
			intent.metadata?.resource === req.resource &&
			intent.metadata?.network === req.network &&
			intent.amount >= toStripeAmount(req.maxAmountRequired),
	);
}

function isPaid(intent: Stripe.PaymentIntent): boolean {
	return intent.status === "succeeded" || intent.status === "requires_capture";
}

function isStripeVerification(
	v: SettlementVerification,
): v is StripeVerification {
	return "paymentIntentId" in v;
}
