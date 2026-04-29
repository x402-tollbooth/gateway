/**
 * Known asset decimals. USDC/EURC have 6 decimals.
 * Can be extended for other assets.
 */
const ASSET_DECIMALS: Record<string, number> = {
	USDC: 6,
	EURC: 6,
	USDT: 6,
	DAI: 18,
	PATHUSD: 6,
};

/**
 * Period suffixes accepted in periodic prices like "$10/month".
 * Maps to the canonical duration string accepted by `parseDuration`.
 */
const PERIOD_TO_DURATION: Record<string, string> = {
	request: "request",
	req: "request",
	second: "1s",
	sec: "1s",
	s: "1s",
	minute: "1m",
	min: "1m",
	m: "1m",
	hour: "1h",
	hr: "1h",
	h: "1h",
	day: "1d",
	daily: "1d",
	d: "1d",
	week: "7d",
	weekly: "7d",
	w: "7d",
	month: "30d",
	monthly: "30d",
	mo: "30d",
	year: "365d",
	yearly: "365d",
	yr: "365d",
	y: "365d",
};

export interface PricePeriod {
	/** The price portion without the period suffix (e.g. "$10"). */
	amount: string;
	/** The raw period suffix from the input (e.g. "month"), or undefined. */
	period?: string;
	/** The canonical duration string (e.g. "30d") or "request" for per-request. */
	duration?: string;
}

/**
 * Split a periodic price string into amount + period.
 *
 * Examples:
 *   "$10/month"   → { amount: "$10", period: "month", duration: "30d" }
 *   "$0.001/req"  → { amount: "$0.001", period: "req", duration: "request" }
 *   "$0.01"       → { amount: "$0.01" }
 *
 * Throws if the suffix is present but unrecognized.
 */
export function extractPricePeriod(price: string): PricePeriod {
	const idx = price.indexOf("/");
	if (idx < 0) return { amount: price.trim() };

	const amount = price.slice(0, idx).trim();
	const periodRaw = price
		.slice(idx + 1)
		.trim()
		.toLowerCase();
	if (!periodRaw) return { amount };

	const duration = PERIOD_TO_DURATION[periodRaw];
	if (!duration) {
		throw new Error(
			`Unknown price period "${periodRaw}" in "${price}". ` +
				"Use one of: request, second, minute, hour, day, week, month, year (or short forms).",
		);
	}

	return { amount, period: periodRaw, duration };
}

/**
 * Parse a human-readable price string to the smallest unit as bigint.
 * e.g. "$0.01" with asset "USDC" → 10000n (0.01 * 10^6)
 *
 * Supports:
 *   "$0.01"        → dollar amount
 *   "0.01"         → dollar amount without prefix
 *   "10000"        → raw smallest unit (no decimal point)
 *   "$10/month"    → periodic — period suffix is ignored, only the amount is parsed.
 *                    Use `extractPricePeriod()` if you need the period.
 */
export function parsePrice(price: string, asset = "USDC"): bigint {
	const { amount } = extractPricePeriod(price);
	const cleaned = amount.replace(/^\$/, "").trim();
	const decimals = ASSET_DECIMALS[asset.toUpperCase()] ?? 6;

	// If no decimal point, treat as raw smallest unit
	if (!cleaned.includes(".")) {
		return BigInt(cleaned);
	}

	const [whole, fraction = ""] = cleaned.split(".");
	const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
	const combined = `${whole}${paddedFraction}`;

	return BigInt(combined);
}

/**
 * Format a smallest-unit bigint back to human-readable dollar string.
 * e.g. 10000n with asset "USDC" → "$0.010000"
 */
export function formatPrice(amount: bigint, asset = "USDC"): string {
	const decimals = ASSET_DECIMALS[asset.toUpperCase()] ?? 6;
	const str = amount.toString().padStart(decimals + 1, "0");
	const whole = str.slice(0, str.length - decimals);
	const fraction = str.slice(str.length - decimals);
	return `$${whole}.${fraction}`;
}
