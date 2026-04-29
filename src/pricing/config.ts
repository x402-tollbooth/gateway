import type {
	MatchRule,
	PricingFnRef,
	PricingModel,
	RouteConfig,
} from "../types.js";
import { extractPricePeriod } from "./parser.js";

export interface EffectiveRoutePricing {
	model: PricingModel;
	duration?: string;
	price?: string | PricingFnRef;
	match?: MatchRule[];
	fallback?: string;
}

/**
 * Normalize route pricing config while keeping backward compatibility with
 * legacy top-level fields (`price`, `match`, `fallback`).
 *
 * If the route's static price string carries a period suffix (e.g.
 * `"$10/month"`), that period is treated as time-based pricing and the
 * model+duration are derived automatically. Explicit `route.pricing.model`
 * always wins over the suffix-derived value.
 */
export function getEffectiveRoutePricing(
	route: RouteConfig,
): EffectiveRoutePricing {
	const explicitPrice = route.pricing?.price ?? route.price;
	const derived = derivePeriodFromPrice(explicitPrice);

	const model: PricingModel =
		route.pricing?.model ?? derived.model ?? "request";
	const duration = route.pricing?.duration ?? derived.duration;

	return {
		model,
		duration,
		price: derived.cleanedPrice ?? explicitPrice,
		match: route.pricing?.match ?? route.match,
		fallback: route.pricing?.fallback ?? route.fallback,
	};
}

interface DerivedPeriod {
	model?: PricingModel;
	duration?: string;
	cleanedPrice?: string;
}

function derivePeriodFromPrice(
	price: string | PricingFnRef | undefined,
): DerivedPeriod {
	if (typeof price !== "string") return {};
	if (!price.includes("/")) return {};

	const { amount, duration } = extractPricePeriod(price);
	if (!duration) return {};

	if (duration === "request") {
		return { model: "request", cleanedPrice: amount };
	}

	return { model: "time", duration, cleanedPrice: amount };
}
