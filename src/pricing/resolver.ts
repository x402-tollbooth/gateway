import type {
	RouteConfig,
	TollboothConfig,
	PricingFn,
	PayToSplit,
} from "../types.js";
import { evaluateMatchers } from "../router/matcher.js";
import { parsePrice } from "./parser.js";

export interface ResolvedPrice {
	amount: bigint;
	asset: string;
	network: string;
	payTo: string | PayToSplit[];
}

interface ResolveInput {
	route: RouteConfig;
	config: TollboothConfig;
	body?: unknown;
	query: Record<string, string>;
	headers: Record<string, string>;
	params: Record<string, string>;
}

/**
 * Resolve the price for a request based on the route config.
 *
 * Priority:
 * 1. match rules (top-to-bottom, first match wins)
 * 2. route.price (static or fn)
 * 3. route.fallback
 * 4. config.defaults.price
 */
export async function resolvePrice(input: ResolveInput): Promise<ResolvedPrice> {
	const { route, config } = input;
	const accepts = route.accepts ?? config.accepts;
	const primaryAccept = accepts[0];

	if (!primaryAccept) {
		throw new Error("No accepted payment methods configured");
	}

	const defaultPayTo = resolveDefaultPayTo(config, primaryAccept.network);

	// 1. Try match rules
	if (route.match) {
		const matched = evaluateMatchers(route.match, {
			body: input.body,
			query: input.query,
			headers: input.headers,
			params: input.params,
		});

		if (matched) {
			return {
				amount: parsePrice(matched.price, primaryAccept.asset),
				asset: primaryAccept.asset,
				network: primaryAccept.network,
				payTo: matched.payTo ?? route.payTo ?? defaultPayTo,
			};
		}
	}

	// 2. Try route.price
	if (route.price) {
		const priceStr = await resolvePriceValue(route.price, input);
		return {
			amount: parsePrice(priceStr, primaryAccept.asset),
			asset: primaryAccept.asset,
			network: primaryAccept.network,
			payTo: route.payTo ?? defaultPayTo,
		};
	}

	// 3. Try fallback
	if (route.fallback) {
		return {
			amount: parsePrice(route.fallback, primaryAccept.asset),
			asset: primaryAccept.asset,
			network: primaryAccept.network,
			payTo: route.payTo ?? defaultPayTo,
		};
	}

	// 4. Global default
	return {
		amount: parsePrice(config.defaults.price, primaryAccept.asset),
		asset: primaryAccept.asset,
		network: primaryAccept.network,
		payTo: route.payTo ?? defaultPayTo,
	};
}

async function resolvePriceValue(
	price: string | { fn: string },
	input: ResolveInput,
): Promise<string> {
	if (typeof price === "string") {
		return price;
	}

	// Dynamic pricing function
	const pricingModule = await import(/* @vite-ignore */ price.fn);
	const pricingFn: PricingFn = pricingModule.default;

	if (typeof pricingFn !== "function") {
		throw new Error(`Pricing function "${price.fn}" must export a default function`);
	}

	const result = await pricingFn({
		body: input.body,
		headers: input.headers,
		query: input.query,
		params: input.params,
	});

	return typeof result === "number" ? `$${result}` : String(result);
}

function resolveDefaultPayTo(config: TollboothConfig, network: string): string {
	// Find a wallet for this network
	const wallet = config.wallets[network];
	if (wallet) return wallet;

	// Fall back to the first wallet
	const firstWallet = Object.values(config.wallets)[0];
	if (!firstWallet) {
		throw new Error("No wallets configured");
	}
	return firstWallet;
}
