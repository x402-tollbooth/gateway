import type { TollboothConfig, RouteConfig, UpstreamConfig } from "../types.js";
import { extractParams } from "./rewriter.js";

export interface MatchedRoute {
	routeKey: string;
	route: RouteConfig;
	upstream: UpstreamConfig;
	params: Record<string, string>;
}

/**
 * Match an incoming request (method + path) against configured routes.
 * Routes are defined as "METHOD /path" patterns with optional :param segments.
 */
export function matchRoute(
	method: string,
	path: string,
	config: TollboothConfig,
): MatchedRoute | undefined {
	const upperMethod = method.toUpperCase();

	for (const [routeKey, route] of Object.entries(config.routes)) {
		const [routeMethod, routePath] = parseRouteKey(routeKey);

		if (routeMethod !== upperMethod) {
			continue;
		}

		const params = extractParams(routePath, path);
		if (params === null) {
			continue;
		}

		const upstream = config.upstreams[route.upstream];
		if (!upstream) {
			throw new Error(`Route "${routeKey}" references unknown upstream "${route.upstream}"`);
		}

		return { routeKey, route, upstream, params };
	}

	return undefined;
}

function parseRouteKey(key: string): [method: string, path: string] {
	const spaceIndex = key.indexOf(" ");
	if (spaceIndex === -1) {
		throw new Error(`Invalid route key "${key}". Expected format: "METHOD /path"`);
	}
	return [key.slice(0, spaceIndex).toUpperCase(), key.slice(spaceIndex + 1)];
}
