import type { RateLimitResult, RateLimitStore } from "../types.js";

export interface RedisRateLimitClient {
	incr(key: string): Promise<number>;
	pexpire(key: string, milliseconds: number): Promise<number>;
	pttl(key: string): Promise<number>;
	close?(): void;
}

interface RedisRateLimitStoreOptions {
	prefix?: string;
	closeClient?: boolean;
}

/**
 * Redis-backed fixed-window rate limiter.
 *
 * Uses INCR + PEXPIRE for atomic request counting across instances.
 */
export class RedisRateLimitStore implements RateLimitStore {
	private readonly prefix: string;
	private readonly closeClient: boolean;

	constructor(
		private readonly client: RedisRateLimitClient,
		options?: RedisRateLimitStoreOptions,
	) {
		this.prefix = options?.prefix ?? "tollbooth:rate-limit";
		this.closeClient = options?.closeClient ?? false;
	}

	async check(
		key: string,
		limit: number,
		windowMs: number,
	): Promise<RateLimitResult> {
		const redisKey = `${this.prefix}:${key}`;
		const count = await this.client.incr(redisKey);
		if (count === 1) {
			await this.client.pexpire(redisKey, windowMs);
		}

		let ttlMs = await this.client.pttl(redisKey);
		if (ttlMs <= 0) {
			await this.client.pexpire(redisKey, windowMs);
			ttlMs = windowMs;
		}

		const allowed = count <= limit;
		return {
			allowed,
			remaining: allowed ? Math.max(limit - count, 0) : 0,
			limit,
			resetMs: Math.max(ttlMs, 0),
		};
	}

	close(): void {
		if (this.closeClient) {
			this.client.close?.();
		}
	}
}
