import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementVerification,
} from "../types.js";
import {
	type FacilitatorConfig,
	settlePayment,
	toSettlementInfo,
	verifyPayment,
} from "../x402/facilitator.js";
import { PaymentError } from "../x402/middleware.js";
import { base64UrlEncode } from "./headers.js";
import type { MppChallenge, MppMethod } from "./types.js";

// Token metadata for MPP challenge formatting.
// USDC has 6 decimals and is denominated in USD.
const ASSET_META: Record<string, { currency: string; decimals: number }> = {
	USDC: { currency: "usd", decimals: 6 },
};

interface TempoVerification extends SettlementVerification {
	paymentPayload: unknown;
	requirement: PaymentRequirementsPayload;
	requirementIndex: number;
	facilitator: FacilitatorConfig;
}

/**
 * Tempo payment method for MPP.
 *
 * Wraps the existing x402 facilitator settlement, mapping between
 * MPP challenge/credential format and x402 verify/settle calls.
 */
export class TempoMethod implements MppMethod {
	readonly type = "tempo" as const;

	constructor(private facilitators: FacilitatorConfig[]) {}

	buildChallenge(
		requirement: PaymentRequirementsPayload,
		challengeId: string,
		description: string,
	): MppChallenge {
		const meta = resolveAssetMeta(requirement.asset);
		const amount = formatAmount(requirement.maxAmountRequired, meta.decimals);

		const request = base64UrlEncode(
			JSON.stringify({
				address: requirement.payTo,
				network: requirement.network,
				asset: requirement.asset,
				extra: requirement.extra,
				scheme: requirement.scheme,
				maxTimeoutSeconds: requirement.maxTimeoutSeconds,
			}),
		);

		return {
			id: challengeId,
			method: "tempo",
			intent: "charge",
			amount,
			currency: meta.currency,
			decimals: meta.decimals,
			description,
			request,
		};
	}

	async verify(
		payload: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		let lastError: PaymentError | null = null;

		for (let i = 0; i < requirements.length; i++) {
			const req = requirements[i];
			const facilitator = this.facilitators[i] ?? this.facilitators[0];

			try {
				const result = await verifyPayment(payload, req, facilitator);
				if (!result.isValid) {
					lastError = new PaymentError(
						`Payment verification failed: ${result.invalidReason ?? "unknown reason"}`,
						402,
					);
					continue;
				}

				const verification: TempoVerification = {
					payer: result.payer,
					paymentPayload: payload,
					requirement: req,
					requirementIndex: i,
					facilitator,
				};
				return verification;
			} catch (err) {
				lastError = new PaymentError(
					err instanceof Error ? err.message : "Verification failed",
					402,
				);
			}
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
		if (!isTempoVerification(verification)) {
			throw new PaymentError(
				"settle() received a verification not produced by TempoMethod.verify()",
				500,
			);
		}
		const { paymentPayload, requirement, facilitator } = verification;

		let settlement: Awaited<ReturnType<typeof settlePayment>>;
		try {
			settlement = await settlePayment(
				paymentPayload,
				requirement,
				facilitator,
			);
		} catch (err) {
			throw new PaymentError(
				err instanceof Error ? err.message : "Settlement failed",
				502,
			);
		}
		if (!settlement.success) {
			throw new PaymentError(
				`Payment settlement failed: ${settlement.errorReason ?? "unknown reason"}`,
				502,
			);
		}

		const info = toSettlementInfo(settlement);
		info.amount = requirement.maxAmountRequired;
		return info;
	}
}

function isTempoVerification(
	v: SettlementVerification,
): v is TempoVerification {
	return "paymentPayload" in v && "requirement" in v && "facilitator" in v;
}

function resolveAssetMeta(asset: string): {
	currency: string;
	decimals: number;
} {
	// Match by known contract addresses or symbol
	for (const [symbol, meta] of Object.entries(ASSET_META)) {
		if (asset.toUpperCase() === symbol) return meta;
	}
	// Default to USDC-like properties for known USDC contract addresses
	return { currency: "usd", decimals: 6 };
}

/**
 * Format a raw amount string (smallest units) to a human-readable decimal.
 * e.g. "1000" with 6 decimals → "0.001"
 */
function formatAmount(raw: string, decimals: number): string {
	const n = BigInt(raw);
	const divisor = 10n ** BigInt(decimals);
	const whole = n / divisor;
	const frac = n % divisor;
	if (frac === 0n) return whole.toString();
	const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
	return `${whole}.${fracStr}`;
}
