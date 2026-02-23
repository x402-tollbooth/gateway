import type {
	RedisStoreConnectionConfig,
	RedisStoreOptions,
	StoreSelectionConfig,
	TollboothConfig,
} from "../types.js";

export type RedisStoreName = "rateLimit" | "verificationCache" | "timeSession";

export interface ResolvedRedisStoreConfig {
	url: string;
	prefix: string;
	options?: RedisStoreOptions;
}

const DEFAULT_REDIS_PREFIX = "tollbooth";

export function resolveRedisStoreConfig(
	config: TollboothConfig,
	storeName: RedisStoreName,
): ResolvedRedisStoreConfig | undefined {
	const storeConfig = config.stores?.[storeName];
	if (storeConfig?.backend !== "redis") return undefined;

	const resolved = mergeRedisConfig(config.stores?.redis, storeConfig);
	if (!resolved.url) {
		throw new Error(
			`stores.${storeName}.backend is "redis" but no Redis URL is configured. Set stores.redis.url or stores.${storeName}.redis.url.`,
		);
	}

	return {
		url: resolved.url,
		prefix: resolved.prefix ?? DEFAULT_REDIS_PREFIX,
		options: resolved.options,
	};
}

function mergeRedisConfig(
	globalRedis: RedisStoreConnectionConfig | undefined,
	storeConfig: StoreSelectionConfig,
): {
	url?: string;
	prefix?: string;
	options?: RedisStoreOptions;
} {
	const options = {
		...globalRedis?.options,
		...storeConfig.redis?.options,
	};

	return {
		url: storeConfig.redis?.url ?? globalRedis?.url,
		prefix: storeConfig.redis?.prefix ?? globalRedis?.prefix,
		options: Object.keys(options).length > 0 ? options : undefined,
	};
}

export function buildRedisStorePrefix(
	basePrefix: string,
	storeName: RedisStoreName,
): string {
	switch (storeName) {
		case "rateLimit":
			return `${basePrefix}:rate-limit`;
		case "verificationCache":
			return `${basePrefix}:verification-cache`;
		case "timeSession":
			return `${basePrefix}:time-session`;
		default:
			return `${basePrefix}:store`;
	}
}
