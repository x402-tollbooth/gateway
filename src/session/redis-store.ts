import type { TimeSessionStore } from "../types.js";

export interface RedisTimeSessionClient {
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

interface RedisTimeSessionStoreOptions {
	prefix?: string;
	closeClient?: boolean;
}

/**
 * Redis-backed store for time-based access sessions.
 */
export class RedisTimeSessionStore implements TimeSessionStore {
	private readonly prefix: string;
	private readonly closeClient: boolean;

	constructor(
		private readonly client: RedisTimeSessionClient,
		options?: RedisTimeSessionStoreOptions,
	) {
		this.prefix = options?.prefix ?? "tollbooth:time-session";
		this.closeClient = options?.closeClient ?? false;
	}

	async get(key: string): Promise<number | undefined> {
		const redisKey = `${this.prefix}:${key}`;
		const raw = await this.client.get(redisKey);
		if (!raw) return undefined;

		const expiresAt = Number(raw);
		if (!Number.isFinite(expiresAt)) {
			await this.client.del(redisKey);
			return undefined;
		}
		if (expiresAt <= Date.now()) {
			await this.client.del(redisKey);
			return undefined;
		}
		return expiresAt;
	}

	async set(key: string, expiresAt: number): Promise<void> {
		const redisKey = `${this.prefix}:${key}`;
		const ttlMs = Math.floor(expiresAt - Date.now());
		if (ttlMs <= 0) {
			await this.client.del(redisKey);
			return;
		}
		await this.client.set(
			redisKey,
			String(Math.floor(expiresAt)),
			"PX",
			Math.max(1, ttlMs),
		);
	}

	close(): void {
		if (this.closeClient) {
			this.client.close?.();
		}
	}
}
