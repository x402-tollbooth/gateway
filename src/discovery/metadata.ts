import type { TollboothConfig } from "../types.js";

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
	accepts: { asset: string; network: string }[];
}

/**
 * Generate x402 V2 discovery metadata from the config.
 * This is served at /.well-known/x402 for facilitator crawling.
 */
export function generateDiscoveryMetadata(config: TollboothConfig): DiscoveryMetadata {
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

		endpoints.push({
			method: method.toUpperCase(),
			path,
			pricing: { type: pricingType, defaultPrice },
			accepts: accepts.map((a) => ({ asset: a.asset, network: a.network })),
		});
	}

	return {
		x402Version: 2,
		provider: "tollbooth",
		endpoints,
	};
}
