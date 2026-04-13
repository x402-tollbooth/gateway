import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementVerification,
} from "../types.js";

// ── Method types ────────────────────────────────────────────────────────────

export type MppMethodType = "tempo" | "stripe";

export interface TempoMethodConfig {
	type: "tempo";
}

export interface StripeMethodConfig {
	type: "stripe";
	secretKey: string;
}

export type MppMethodConfig = TempoMethodConfig | StripeMethodConfig;

// ── Protocol primitives ─────────────────────────────────────────────────────

export interface MppChallenge {
	id: string;
	method: MppMethodType;
	intent: "charge" | "session";
	amount: string;
	currency: string;
	decimals: number;
	description: string;
	/** Base64url-encoded method-specific payment request data. */
	request: string;
}

export interface MppCredential {
	id: string;
	/** Decoded payment payload from the credential. */
	payload: unknown;
	/** The raw Authorization header value (for cache key compatibility). */
	rawHeader: string;
}

export interface MppReceipt {
	id: string;
	receipt: unknown;
}

// ── Method interface ────────────────────────────────────────────────────────

export interface MppMethod {
	type: MppMethodType;

	/**
	 * Build an MPP challenge for a 402 response.
	 * May be async (e.g. Stripe creates a PaymentIntent).
	 */
	buildChallenge(
		requirement: PaymentRequirementsPayload,
		challengeId: string,
		description: string,
	): MppChallenge | Promise<MppChallenge>;

	/**
	 * Verify a credential payload submitted by the client.
	 */
	verify(
		payload: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification>;

	/**
	 * Settle (finalize) a verified payment.
	 */
	settle(verification: SettlementVerification): Promise<SettlementInfo>;
}

// ── Settlement verification extension ───────────────────────────────────────

export interface MppVerification extends SettlementVerification {
	/** Which method handled this payment. */
	methodType: MppMethodType;
	/** The challenge ID that was fulfilled. */
	challengeId?: string;
	/** Index into the requirements array (for cache support). */
	requirementIndex: number;
	/** Strategy-specific inner verification data. */
	inner: SettlementVerification;
}
