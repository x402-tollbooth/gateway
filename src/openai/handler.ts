import { log } from "../logger.js";
import { DEFAULT_MODEL_PRICES } from "../pricing/models.js";
import { parsePrice } from "../pricing/parser.js";
import type { PayToSplit, RouteConfig, TollboothConfig } from "../types.js";

export interface OpenAIPriceResult {
	amount: bigint;
	asset: string;
	network: string;
	payTo: string | PayToSplit[];
	model: string;
}

/**
 * Extract the model name from an OpenAI-compatible request body.
 * Supports both /v1/chat/completions and /v1/completions formats.
 */
export function extractModel(body: unknown): string | undefined {
	if (
		body !== null &&
		typeof body === "object" &&
		"model" in (body as Record<string, unknown>)
	) {
		const model = (body as Record<string, unknown>).model;
		if (typeof model === "string" && model.length > 0) {
			return model;
		}
	}
	return undefined;
}

/**
 * Resolve pricing for an openai-compatible route.
 *
 * Priority:
 * 1. route.models (user overrides) — exact match
 * 2. Default model pricing table — exact match
 * 3. route.price / route.fallback / config.defaults.price (standard fallback chain)
 */
export function resolveOpenAIPrice(
	model: string,
	route: RouteConfig,
	config: TollboothConfig,
): OpenAIPriceResult {
	const accepts = route.accepts ?? config.accepts;
	const primaryAccept = accepts[0];

	if (!primaryAccept) {
		throw new Error("No accepted payment methods configured");
	}

	const defaultPayTo = resolveDefaultPayTo(config, primaryAccept.network);
	const payTo = route.payTo ?? defaultPayTo;

	// 1. Check user overrides (route.models)
	if (route.models?.[model]) {
		log.debug("openai_price_resolved", {
			model,
			source: "route.models",
			price: route.models[model],
		});
		return {
			amount: parsePrice(route.models[model], primaryAccept.asset),
			asset: primaryAccept.asset,
			network: primaryAccept.network,
			payTo,
			model,
		};
	}

	// 2. Check default pricing table
	if (DEFAULT_MODEL_PRICES[model]) {
		log.debug("openai_price_resolved", {
			model,
			source: "default_table",
			price: DEFAULT_MODEL_PRICES[model],
		});
		return {
			amount: parsePrice(DEFAULT_MODEL_PRICES[model], primaryAccept.asset),
			asset: primaryAccept.asset,
			network: primaryAccept.network,
			payTo,
			model,
		};
	}

	// 3. Fall back to standard pricing chain
	const fallbackPrice =
		(typeof route.price === "string" ? route.price : undefined) ??
		route.fallback ??
		config.defaults.price;

	log.debug("openai_price_resolved", {
		model,
		source: "fallback",
		price: fallbackPrice,
	});

	return {
		amount: parsePrice(fallbackPrice, primaryAccept.asset),
		asset: primaryAccept.asset,
		network: primaryAccept.network,
		payTo,
		model,
	};
}

function resolveDefaultPayTo(config: TollboothConfig, network: string): string {
	const wallet = config.wallets[network];
	if (wallet) return wallet;

	const firstWallet = Object.values(config.wallets)[0];
	if (!firstWallet) {
		throw new Error("No wallets configured");
	}
	return firstWallet;
}
