import { log } from "../logger.js";
import { TempoMethod } from "../mpp/tempo.js";
import type {
	PaymentRequirementsPayload,
	SettlementInfo,
	SettlementStrategy,
	SettlementVerification,
	TempoRecurringInterval,
	TempoSettlementConfig,
} from "../types.js";
import { DEFAULT_FACILITATOR } from "../x402/facilitator.js";

const DEFAULT_TEMPO_FACILITATORS: Record<"testnet" | "mainnet", string> = {
	mainnet: "https://facilitator.tempo.xyz",
	testnet: "https://facilitator.testnet.tempo.xyz",
};

const INTERVAL_PRETTY: Record<TempoRecurringInterval, string> = {
	daily: "day",
	weekly: "week",
	monthly: "month",
	yearly: "year",
};

interface TempoSettlementVerification extends SettlementVerification {
	__tempoSettlement: true;
	inner: SettlementVerification;
}

/**
 * Tempo settlement strategy.
 *
 * Wraps the existing x402 facilitator path (via `TempoMethod`) with the
 * merchant primitives Tempo's mainnet release added: per-customer deposit
 * attribution, structured invoice memos, and recurring/auto-pay metadata.
 *
 * Recurring routes piggyback on tollbooth's existing time-based pricing
 * substrate — the route's `price: "$10/month"` triggers a `TimeSessionStore`
 * entry, and Tempo's on-chain auto-pay primitive handles the actual recurring
 * transfer when `recurring.autoPay` is true.
 */
export class TempoSettlement implements SettlementStrategy {
	private readonly inner: TempoMethod;
	private readonly recipient: string;
	private readonly token: string;
	private readonly network: "testnet" | "mainnet";
	private readonly recurring?: TempoSettlementConfig["recurring"];
	private readonly memoTemplate: Record<string, string>;
	private warnedFirstDeploy = false;

	constructor(config: TempoSettlementConfig) {
		if (!config.recipient) {
			throw new Error("TempoSettlement requires a recipient address");
		}

		this.recipient = config.recipient;
		this.token = config.token ?? "pathUSD";
		this.network = config.network ?? "mainnet";
		this.recurring = config.recurring;
		this.memoTemplate = config.memo ?? {};

		const facilitatorUrl =
			config.url ??
			DEFAULT_TEMPO_FACILITATORS[this.network] ??
			DEFAULT_FACILITATOR;
		this.inner = new TempoMethod([{ url: facilitatorUrl }]);

		log.info("tempo_settlement_init", {
			network: this.network,
			token: this.token,
			recipient: this.recipient,
			recurring: this.recurring?.interval,
			autoPay: this.recurring?.autoPay ?? false,
		});

		// Tempo state-creation cost is ~12.5x Ethereum (~300k gas for the first
		// payment to a new merchant). Surface this once at boot so operators
		// can fund accordingly.
		log.warn("tempo_state_creation_cost", {
			recipient: this.recipient,
			msg: "First payment to a fresh Tempo merchant address costs ~300k gas (TIP-20 state creation).",
		});
	}

	async verify(
		payment: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification> {
		const inner = await this.inner.verify(payment, requirements);
		const verification: TempoSettlementVerification = {
			__tempoSettlement: true,
			payer: inner.payer,
			inner,
		};
		return verification;
	}

	async settle(verification: SettlementVerification): Promise<SettlementInfo> {
		const inner = isTempoSettlementVerification(verification)
			? verification.inner
			: verification;

		const settlement = await this.inner.settle(inner);

		const customerId = deriveCustomerId(settlement.payer);
		const period = this.recurring
			? INTERVAL_PRETTY[this.recurring.interval]
			: "request";
		const memo = interpolateMemo(this.memoTemplate, {
			customerId,
			customer_id: customerId,
			payer: settlement.payer,
			period,
			recipient: this.recipient,
			network: this.network,
			token: this.token,
		});
		const attribution: Record<string, unknown> = {
			recipient: this.recipient,
			token: this.token,
			network: this.network,
		};
		if (this.recurring) {
			attribution.recurring = {
				interval: this.recurring.interval,
				autoPay: this.recurring.autoPay ?? false,
			};
		}

		if (!this.warnedFirstDeploy) {
			this.warnedFirstDeploy = true;
		}

		return {
			...settlement,
			customerId,
			memo: Object.keys(memo).length > 0 ? memo : undefined,
			attribution,
		};
	}
}

function isTempoSettlementVerification(
	v: SettlementVerification,
): v is TempoSettlementVerification {
	return (v as { __tempoSettlement?: boolean }).__tempoSettlement === true;
}

function deriveCustomerId(payer: string | undefined): string | undefined {
	if (!payer) return undefined;
	return payer.toLowerCase();
}

/**
 * Interpolate `{token}` placeholders in a memo template.
 *
 * Supports tokens: customerId, payer, period, recipient, network, token.
 * Unknown placeholders are left untouched.
 */
export function interpolateMemo(
	template: Record<string, string>,
	values: Record<string, string | undefined>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, raw] of Object.entries(template)) {
		out[key] = raw.replace(/\{(\w+)\}/g, (match, name: string) => {
			const v = values[name];
			return v === undefined ? match : v;
		});
	}
	return out;
}
