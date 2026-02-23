interface MockRedisEntry {
	value: string;
	expiresAt?: number;
}

export class MockRedisClient {
	private store = new Map<string, MockRedisEntry>();
	closed = false;

	async get(key: string): Promise<string | null> {
		this.evictExpired(key);
		return this.store.get(key)?.value ?? null;
	}

	async set(
		key: string,
		value: string,
		option?: "PX",
		ttlMs?: number,
	): Promise<"OK"> {
		const expiresAt =
			option === "PX" && ttlMs != null ? Date.now() + ttlMs : undefined;
		this.store.set(key, { value, expiresAt });
		return "OK";
	}

	async del(...keys: string[]): Promise<number> {
		let deleted = 0;
		for (const key of keys) {
			if (this.store.delete(key)) {
				deleted++;
			}
		}
		return deleted;
	}

	async incr(key: string): Promise<number> {
		this.evictExpired(key);
		const existing = this.store.get(key);
		const current = existing ? Number(existing.value) || 0 : 0;
		const next = current + 1;
		this.store.set(key, {
			value: String(next),
			expiresAt: existing?.expiresAt,
		});
		return next;
	}

	async pexpire(key: string, milliseconds: number): Promise<number> {
		this.evictExpired(key);
		const existing = this.store.get(key);
		if (!existing) return 0;
		existing.expiresAt = Date.now() + milliseconds;
		this.store.set(key, existing);
		return 1;
	}

	async pttl(key: string): Promise<number> {
		this.evictExpired(key);
		const existing = this.store.get(key);
		if (!existing) return -2;
		if (existing.expiresAt == null) return -1;
		return Math.max(existing.expiresAt - Date.now(), 0);
	}

	close(): void {
		this.closed = true;
	}

	private evictExpired(key: string): void {
		const existing = this.store.get(key);
		if (!existing?.expiresAt) return;
		if (existing.expiresAt <= Date.now()) {
			this.store.delete(key);
		}
	}
}
