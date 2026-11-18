import { createRequire } from "node:module";
import { log } from "../logger.js";
import { StripeMethod } from "../mpp/stripe.js";
import { TempoMethod } from "../mpp/tempo.js";
import type {
	AcceptedPayment,
	FacilitatorMapping,
	PaymentClaimStore,
	RouteConfig,
	SettlementStrategy,
	SettlementStrategyConfig,
} from "../types.js";
import {
	DEFAULT_FACILITATOR,
	resolveFacilitatorUrl,
} from "../x402/facilitator.js";
import { FacilitatorSettlement } from "./facilitator.js";
import { MppSettlement } from "./mpp.js";
import { NanopaymentSettlement } from "./nanopayments.js";
import { TempoSettlement } from "./tempo.js";

const strategyCache = new Map<string, SettlementStrategy>();

/**
 * Load a custom settlement strategy from a user module.
 *
 * The module must default-export (or named-export) an object with
 * `verify()` and `settle()` methods matching `SettlementStrategy`.
 *
 * Loaded modules are cached by path.
 */
export async function loadCustomStrategy(
	modulePath: string,
): Promise<SettlementStrategy> {
	const cached = strategyCache.get(modulePath);
	if (cached) return cached;

	const require = createRequire(`${process.cwd()}/`);
	const resolved = require.resolve(modulePath);
	const mod = await import(resolved);
	const strategy: SettlementStrategy = mod.default ?? mod;

	if (
		typeof strategy.verify !== "function" ||
		typeof strategy.settle !== "function"
	) {
		throw new Error(
			`Custom settlement module "${modulePath}" must export an object with verify() and settle() methods`,
		);
	}

	strategyCache.set(modulePath, strategy);
	return strategy;
}

/**
 * Create a FacilitatorSettlement bound to the resolved facilitator URLs
 * for the current request's accepted payment methods.
 */
export function createFacilitatorStrategy(
	accepts: AcceptedPayment[],
	routeFacilitator?: string | FacilitatorMapping,
	globalFacilitator?: string | FacilitatorMapping,
	settlementUrl?: string,
): FacilitatorSettlement {
	// settlement.url takes precedence over legacy facilitator field
	const effectiveGlobal: string | FacilitatorMapping | undefined =
		settlementUrl ?? globalFacilitator;

	const facilitators = accepts.map((a) => ({
		url: resolveFacilitatorUrl(
			a.network,
			a.asset,
			routeFacilitator,
			effectiveGlobal,
		),
	}));

	return new FacilitatorSettlement(facilitators);
}

/**
 * Pre-load a custom strategy at gateway startup.
 *
 * Returns `null` for the default facilitator strategy (which is created
 * per-request because facilitator URLs depend on the matched route).
 */
export async function initSettlementStrategy(
	config: {
		settlement?: SettlementStrategyConfig;
		facilitator?: string | FacilitatorMapping;
		routes?: Record<string, RouteConfig>;
		wallets?: Record<string, string>;
	},
	deps?: {
		/** Marks MPP Stripe PaymentIntents as spent (replay protection). */
		paymentClaimStore?: PaymentClaimStore;
	},
): Promise<SettlementStrategy | null> {
	if (config.settlement?.strategy === "nanopayments") {
		// Warn about ignored facilitator overrides
		if (config.facilitator) {
			log.warn("nanopayments_strategy_ignores_facilitator", {
				msg: "Top-level 'facilitator' is ignored when settlement.strategy is 'nanopayments'",
			});
		}
		if (config.routes) {
			for (const [key, route] of Object.entries(config.routes)) {
				if (route.facilitator) {
					log.warn("nanopayments_strategy_ignores_facilitator", {
						route: key,
						msg: "Route-level 'facilitator' is ignored when settlement.strategy is 'nanopayments'",
					});
				}
			}
		}

		const strategy = new NanopaymentSettlement({
			network: config.settlement.network,
			url: config.settlement.url,
		});
		await strategy.init();
		return strategy;
	}

	if (config.settlement?.strategy === "tempo") {
		if (!config.settlement.tempo) {
			throw new Error(
				"Tempo settlement strategy requires a 'tempo' config block",
			);
		}

		// Warn about ignored facilitator overrides
		if (config.facilitator) {
			log.warn("tempo_strategy_ignores_facilitator", {
				msg: "Top-level 'facilitator' is ignored when settlement.strategy is 'tempo'",
			});
		}
		if (config.routes) {
			for (const [key, route] of Object.entries(config.routes)) {
				if (route.facilitator) {
					log.warn("tempo_strategy_ignores_facilitator", {
						route: key,
						msg: "Route-level 'facilitator' is ignored when settlement.strategy is 'tempo'",
					});
				}
			}
		}

		// Funds go to the route's payTo (from `wallets`); `tempo.recipient` is
		// only used for attribution and memos. Flag a mismatch so receipts
		// don't name an address that isn't actually being paid.
		const recipient = config.settlement.tempo.recipient.toLowerCase();
		const walletAddresses = Object.values(config.wallets ?? {}).map((w) =>
			w.toLowerCase(),
		);
		if (!walletAddresses.includes(recipient)) {
			log.warn("tempo_recipient_not_in_wallets", {
				recipient: config.settlement.tempo.recipient,
				hint: "settlement.tempo.recipient does not match any address in 'wallets'. Payments go to the wallet address; recipient is only used in attribution and memos.",
			});
		}

		const tempoConfig = {
			...config.settlement.tempo,
			url: config.settlement.tempo.url ?? config.settlement.url,
		};
		return new TempoSettlement(tempoConfig);
	}

	if (config.settlement?.strategy === "mpp") {
		if (!config.settlement.methods?.length) {
			throw new Error("MPP settlement strategy requires at least one method");
		}

		// Resolve facilitator URLs for tempo methods
		const facilitatorUrl =
			config.settlement.url ??
			(typeof config.facilitator === "string"
				? config.facilitator
				: config.facilitator?.default) ??
			DEFAULT_FACILITATOR;

		const methods = config.settlement.methods.map((m) => {
			if (m.type === "tempo") {
				return new TempoMethod([{ url: facilitatorUrl }]);
			}
			if (m.type === "stripe") {
				return new StripeMethod({
					secretKey: m.secretKey,
					claimStore: deps?.paymentClaimStore,
				});
			}
			throw new Error(
				`Unknown MPP method type: ${(m as { type: string }).type}`,
			);
		});

		return new MppSettlement(methods);
	}

	if (config.settlement?.strategy === "custom") {
		if (!config.settlement.module) {
			throw new Error("Custom settlement strategy requires a 'module' path");
		}

		// Warn about ignored facilitator overrides
		if (config.facilitator) {
			log.warn("custom_strategy_ignores_facilitator", {
				msg: "Top-level 'facilitator' is ignored when settlement.strategy is 'custom'",
			});
		}
		if (config.routes) {
			for (const [key, route] of Object.entries(config.routes)) {
				if (route.facilitator) {
					log.warn("custom_strategy_ignores_facilitator", {
						route: key,
						msg: "Route-level 'facilitator' is ignored when settlement.strategy is 'custom'",
					});
				}
			}
		}

		return loadCustomStrategy(config.settlement.module);
	}
	return null;
}
