import type { RouteConfig, TollboothConfig, UpstreamConfig } from "../types.js";
import { extractParams } from "./rewriter.js";

export interface MatchedRoute {
	routeKey: string;
	route: RouteConfig;
	upstream: UpstreamConfig;
	params: Record<string, string>;
}

export type RouteMatchResult =
	| (MatchedRoute & { matched: true })
	| { matched: false; checked: string[]; suggestion?: string };

/**
 * Match an incoming request (method + path) against configured routes.
 * Routes are defined as "METHOD /path" patterns with optional :param segments.
 * Returns diagnostic info (checked routes + suggestion) when no route matches.
 */
export function matchRoute(
	method: string,
	path: string,
	config: TollboothConfig,
): RouteMatchResult {
	const upperMethod = method.toUpperCase();
	const routeKeys = Object.keys(config.routes);

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
			throw new Error(
				`Route "${routeKey}" references unknown upstream "${route.upstream}"`,
			);
		}

		return { matched: true, routeKey, route, upstream, params };
	}

	const requested = `${upperMethod} ${path}`;
	const suggestion = findClosestRoute(requested, routeKeys);

	return { matched: false, checked: routeKeys, suggestion };
}

function parseRouteKey(key: string): [method: string, path: string] {
	const spaceIndex = key.indexOf(" ");
	if (spaceIndex === -1) {
		throw new Error(
			`Invalid route key "${key}". Expected format: "METHOD /path"`,
		);
	}
	return [key.slice(0, spaceIndex).toUpperCase(), key.slice(spaceIndex + 1)];
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		Array(n + 1).fill(0),
	);

	for (let i = 0; i <= m; i++) dp[i][0] = i;
	for (let j = 0; j <= n; j++) dp[0][j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i][j] =
				a[i - 1] === b[j - 1]
					? dp[i - 1][j - 1]
					: 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
		}
	}

	return dp[m][n];
}

function findClosestRoute(
	requested: string,
	routeKeys: string[],
): string | undefined {
	let best: string | undefined;
	let bestDist = Number.POSITIVE_INFINITY;

	for (const key of routeKeys) {
		const dist = levenshtein(requested.toLowerCase(), key.toLowerCase());
		if (dist < bestDist) {
			bestDist = dist;
			best = key;
		}
	}

	// Only suggest if the distance is reasonable (less than 40% of the longer string)
	if (best && bestDist <= Math.max(requested.length, best.length) * 0.4) {
		return best;
	}
	return undefined;
}
