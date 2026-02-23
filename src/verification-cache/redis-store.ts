import type {
	VerificationCacheEntry,
	VerificationCacheStore,
} from "../types.js";

export interface RedisVerificationCacheClient {
	get(key: string): Promise<string | null>;
	set(
		key: string,
		value: string,
		px: "PX",
		milliseconds: number,
	): Promise<"OK">;
	del(...keys: string[]): Promise<number>;
	close?(): void;
}

interface RedisVerificationCacheStoreOptions {
	prefix?: string;
	closeClient?: boolean;
}

/**
 * Redis-backed verification cache with TTL-based expiry.
 */
export class RedisVerificationCacheStore implements VerificationCacheStore {
	private readonly prefix: string;
	private readonly closeClient: boolean;

	constructor(
		private readonly client: RedisVerificationCacheClient,
		options?: RedisVerificationCacheStoreOptions,
	) {
		this.prefix = options?.prefix ?? "tollbooth:verification-cache";
		this.closeClient = options?.closeClient ?? false;
	}

	async get(key: string): Promise<VerificationCacheEntry | undefined> {
		const redisKey = `${this.prefix}:${key}`;
		const raw = await this.client.get(redisKey);
		if (!raw) return undefined;

		try {
			const parsed = JSON.parse(raw) as VerificationCacheEntry;
			if (
				typeof parsed !== "object" ||
				parsed == null ||
				typeof parsed.requirementIndex !== "number"
			) {
				await this.client.del(redisKey);
				return undefined;
			}
			return parsed;
		} catch {
			await this.client.del(redisKey);
			return undefined;
		}
	}

	async set(
		key: string,
		entry: VerificationCacheEntry,
		ttlMs: number,
	): Promise<void> {
		const redisKey = `${this.prefix}:${key}`;
		if (ttlMs <= 0) {
			await this.client.del(redisKey);
			return;
		}
		await this.client.set(
			redisKey,
			JSON.stringify(entry),
			"PX",
			Math.max(1, Math.floor(ttlMs)),
		);
	}

	close(): void {
		if (this.closeClient) {
			this.client.close?.();
		}
	}
}
