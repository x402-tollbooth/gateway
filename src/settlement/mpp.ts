import { log } from "../logger.js";
import { generateChallengeId } from "../mpp/challenge.js";
import {
	type MppChallenge,
	type MppMethod,
	type MppVerification,
	serializeChallenge,
	serializeReceipt,
} from "../mpp/index.js";
import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementStrategy,
	SettlementVerification,
} from "../types.js";
import { PaymentError } from "../x402/middleware.js";

/**
 * MPP settlement strategy.
 *
 * Manages multiple payment methods (tempo, stripe, etc.) under the MPP
 * protocol. Generates MPP-format challenges, routes credentials to the
 * correct method, and produces dual-format receipts.
 */
export class MppSettlement implements SettlementStrategy {
	/** Methods in priority order (first = preferred). */
	private methods: MppMethod[];

	/**
	 * Maps challenge IDs to the method type that generated them.
	 * Entries are cleaned up after a TTL to prevent unbounded growth.
	 */
	private challengeMap = new Map<
		string,
		{ method: string; expiresAt: number }
	>();
	private static CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(methods: MppMethod[]) {
		this.methods = methods;
	}

	// ── Challenge generation (called by gateway for 402 responses) ──────────

	/**
	 * Build MPP challenges for all methods × all requirements.
	 * Returns one challenge per method (using the first requirement for each).
	 */
	async buildChallenges(
		requirements: PaymentRequirementsPayload[],
		description: string,
	): Promise<MppChallenge[]> {
		this.sweepExpired();
		const challengeId = generateChallengeId();
		const challenges: MppChallenge[] = [];

		for (const method of this.methods) {
			// Use the first requirement for the challenge (client picks method, not requirement)
			const req = requirements[0];
			const challenge = await method.buildChallenge(
				req,
				challengeId,
				description,
			);
			challenges.push(challenge);

			// Track which method owns this challenge
			this.challengeMap.set(`${challengeId}:${method.type}`, {
				method: method.type,
				expiresAt: Date.now() + MppSettlement.CHALLENGE_TTL_MS,
			});
		}

		return challenges;
	}

	/**
	 * Serialize challenges into WWW-Authenticate header values.
	 */
	serializeChallengeHeaders(challenges: MppChallenge[]): string[] {
		return challenges.map(serializeChallenge);
	}

	/**
	 * Build a Payment-Receipt header value for a settlement.
	 */
	buildReceiptHeader(
		challengeId: string | undefined,
		settlement: SettlementInfo,
	): string {
		return serializeReceipt(challengeId ?? "none", settlement);
	}

	// ── SettlementStrategy interface ────────────────────────────────────────

	async verify(
		payment: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		// Try each method in order — the payment format determines which succeeds.
		// For x402-compatible clients sending stablecoin proofs, tempo will match.
		// For Stripe SPT clients, stripe will match.
		let lastError: PaymentError | null = null;

		for (const method of this.methods) {
			try {
				const inner = await method.verify(payment, requirements);
				const verification: MppVerification = {
					payer: inner.payer,
					methodType: method.type,
					requirementIndex: getInnerRequirementIndex(inner),
					inner,
				};
				return verification;
			} catch (err) {
				lastError =
					err instanceof PaymentError
						? err
						: new PaymentError(
								err instanceof Error ? err.message : "Verification failed",
								402,
							);
			}
		}

		throw (
			lastError ??
			new PaymentError("Payment verification failed for all methods", 402)
		);
	}

	async settle(verification: SettlementVerification): Promise<SettlementInfo> {
		if (!isMppVerification(verification)) {
			throw new PaymentError(
				"settle() received a verification not produced by MppSettlement",
				500,
			);
		}

		const method = this.methods.find((m) => m.type === verification.methodType);
		if (!method) {
			throw new PaymentError(
				`No method found for type: ${verification.methodType}`,
				500,
			);
		}

		const settlement = await method.settle(verification.inner);

		log.info("mpp_settled", {
			method: verification.methodType,
			payer: settlement.payer,
			tx: settlement.transaction,
		});

		return settlement;
	}

	/**
	 * Reconstruct a verification from cached data.
	 */
	rebuildVerification(
		_payment: unknown,
		payer: string | undefined,
		requirementIndex: number,
		_requirements: PaymentRequirementsPayload[],
	): SettlementVerification {
		// Use the first (default) method for cache rebuilds — this assumes
		// tempo is the primary method. If the cached index points to a
		// different method, the verify loop will handle it on next miss.
		const method = this.methods[0];
		const verification: MppVerification = {
			payer,
			methodType: method.type,
			requirementIndex,
			inner: { payer },
		};
		return verification;
	}

	static getRequirementIndex(
		verification: SettlementVerification,
	): number | undefined {
		return isMppVerification(verification)
			? verification.requirementIndex
			: undefined;
	}

	// ── Internal ────────────────────────────────────────────────────────────

	private sweepExpired(): void {
		const now = Date.now();
		for (const [key, entry] of this.challengeMap) {
			if (entry.expiresAt <= now) {
				this.challengeMap.delete(key);
			}
		}
	}
}

function isMppVerification(v: SettlementVerification): v is MppVerification {
	return "methodType" in v && "inner" in v;
}

function getInnerRequirementIndex(inner: SettlementVerification): number {
	if ("requirementIndex" in inner) {
		return (inner as { requirementIndex: number }).requirementIndex;
	}
	return 0;
}
