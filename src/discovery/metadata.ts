import type { TollboothConfig } from "../types.js";
import { resolveFacilitatorUrl } from "../x402/facilitator.js";

export interface DiscoveryMetadata {
	x402Version: number;
	provider: string;
	endpoints: DiscoveryEndpoint[];
}

export interface DiscoveryEndpoint {
	method: string;
	path: string;
	description?: string;
	pricing: {
		type: "static" | "dynamic" | "match";
		defaultPrice?: string;
	};
	accepts: { asset: string; network: string; facilitator?: string }[];
	facilitator?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Generate x402 V2 discovery metadata from the config.
 * This is served at /.well-known/x402 for facilitator crawling.
 */
export function generateDiscoveryMetadata(
	config: TollboothConfig,
): DiscoveryMetadata {
	const endpoints: DiscoveryEndpoint[] = [];

	for (const [routeKey, route] of Object.entries(config.routes)) {
		const [method, path] = routeKey.split(" ", 2);
		const accepts = route.accepts ?? config.accepts;

		let pricingType: "static" | "dynamic" | "match" = "static";
		let defaultPrice: string | undefined;

		if (route.match) {
			pricingType = "match";
			defaultPrice = route.fallback ?? config.defaults.price;
		} else if (route.price && typeof route.price === "object") {
			pricingType = "dynamic";
		} else {
			defaultPrice = (route.price as string) ?? config.defaults.price;
		}

		// Resolve per-chain facilitator for each accepted payment
		// settlement.url takes precedence over legacy facilitator field
		const globalFacilitator = config.settlement?.url ?? config.facilitator;
		const acceptsWithFacilitator = accepts.map((a) => {
			const url = resolveFacilitatorUrl(
				a.network,
				a.asset,
				route.facilitator,
				globalFacilitator,
			);
			return { asset: a.asset, network: a.network, facilitator: url };
		});

		// Top-level facilitator for backward compat: use the first accept's facilitator
		const facilitator = acceptsWithFacilitator[0]?.facilitator;

		endpoints.push({
			method: method.toUpperCase(),
			path,
			pricing: { type: pricingType, defaultPrice },
			accepts: acceptsWithFacilitator,
			...(facilitator && { facilitator }),
			...(route.metadata && { metadata: route.metadata }),
		});
	}

	return {
		x402Version: 2,
		provider: "tollbooth",
		endpoints,
	};
}
