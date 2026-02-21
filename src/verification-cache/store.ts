import type {
	VerificationCacheEntry,
	VerificationCacheStore,
} from "../types.js";

/**
 * In-memory verification cache with TTL-based expiry.
 *
 * Each key maps to a cached verification entry with an expiration timestamp.
 * Expired entries are lazily evicted on read and periodically swept.
 */
export class MemoryVerificationCacheStore implements VerificationCacheStore {
	private cache = new Map<
		string,
		{ entry: VerificationCacheEntry; expiresAt: number }
	>();
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.sweepTimer = setInterval(() => this.sweep(), 60_000);
		if (this.sweepTimer && "unref" in this.sweepTimer) {
			this.sweepTimer.unref();
		}
	}

	async get(key: string): Promise<VerificationCacheEntry | undefined> {
		const cached = this.cache.get(key);
		if (!cached) return undefined;
		if (Date.now() > cached.expiresAt) {
			this.cache.delete(key);
			return undefined;
		}
		return cached.entry;
	}

	async set(
		key: string,
		entry: VerificationCacheEntry,
		ttlMs: number,
	): Promise<void> {
		this.cache.set(key, { entry, expiresAt: Date.now() + ttlMs });
	}

	/** Remove expired entries. */
	private sweep(): void {
		const now = Date.now();
		for (const [key, cached] of this.cache) {
			if (now > cached.expiresAt) {
				this.cache.delete(key);
			}
		}
	}

	/** Stop the sweep timer (useful in tests). */
	destroy(): void {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
	}
}
