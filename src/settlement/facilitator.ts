import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementStrategy,
	SettlementVerification,
} from "../types.js";
import {
	type FacilitatorConfig,
	settlePayment,
	toSettlementInfo,
	verifyPayment,
} from "../x402/facilitator.js";
import { PaymentError } from "../x402/middleware.js";

interface FacilitatorVerification extends SettlementVerification {
	paymentPayload: unknown;
	requirement: PaymentRequirementsPayload;
	requirementIndex: number;
	facilitator: FacilitatorConfig;
	facilitatorUrl: string;
}

/**
 * Settlement strategy that delegates to an x402 facilitator.
 *
 * Each instance is bound to a set of facilitator configs (one per accepted
 * payment method) so the gateway can create it per-request with the right URLs.
 */
export class FacilitatorSettlement implements SettlementStrategy {
	constructor(private facilitators: FacilitatorConfig[]) {}

	/**
	 * Reconstruct a verification from cached data (skipping the facilitator
	 * /verify call). Used by the verification cache on cache hit.
	 */
	rebuildVerification(
		payment: unknown,
		payer: string | undefined,
		requirementIndex: number,
		requirements: PaymentRequirementsPayload[],
	): SettlementVerification {
		const facilitator =
			this.facilitators[requirementIndex] ?? this.facilitators[0];
		const facilitatorUrl =
			facilitator?.url ?? "https://x402.org/facilitator";
		return {
			payer,
			paymentPayload: payment,
			requirement: requirements[requirementIndex] ?? requirements[0],
			requirementIndex,
			facilitator,
			facilitatorUrl,
		} satisfies FacilitatorVerification;
	}

	/**
	 * Extract the requirement index from a verification produced by this
	 * strategy. Returns undefined for foreign verifications.
	 */
	static getRequirementIndex(
		verification: SettlementVerification,
	): number | undefined {
		return isFacilitatorVerification(verification)
			? verification.requirementIndex
			: undefined;
	}

	async verify(
		payment: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		let lastError: PaymentError | null = null;

		for (let i = 0; i < requirements.length; i++) {
			const req = requirements[i];
			const facilitator = this.facilitators[i] ?? this.facilitators[0];
			const facilitatorUrl = facilitator?.url ?? "https://x402.org/facilitator";

			let verification: Awaited<ReturnType<typeof verifyPayment>>;
			try {
				verification = await verifyPayment(payment, req, facilitator);
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

			const result: FacilitatorVerification = {
				payer: verification.payer,
				paymentPayload: payment,
				requirement: req,
				requirementIndex: i,
				facilitator,
				facilitatorUrl,
			};
			return result;
		}

		throw (
			lastError ??
			new PaymentError(
				"Payment verification failed for all payment methods",
				402,
			)
		);
	}

	async settle(verification: SettlementVerification): Promise<SettlementInfo> {
		if (!isFacilitatorVerification(verification)) {
			throw new PaymentError(
				"settle() received a verification not produced by FacilitatorSettlement.verify()",
				500,
			);
		}
		const { paymentPayload, requirement, facilitator, facilitatorUrl } =
			verification;

		let settlement: Awaited<ReturnType<typeof settlePayment>>;
		try {
			settlement = await settlePayment(
				paymentPayload,
				requirement,
				facilitator,
			);
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
		return info;
	}
}

function isFacilitatorVerification(
	v: SettlementVerification,
): v is FacilitatorVerification {
	return (
		"paymentPayload" in v &&
		"requirement" in v &&
		"facilitator" in v &&
		"facilitatorUrl" in v
	);
}
