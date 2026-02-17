/**
 * Known asset decimals. USDC/EURC have 6 decimals.
 * Can be extended for other assets.
 */
const ASSET_DECIMALS: Record<string, number> = {
	USDC: 6,
	EURC: 6,
	USDT: 6,
	DAI: 18,
};

/**
 * Parse a human-readable price string to the smallest unit as bigint.
 * e.g. "$0.01" with asset "USDC" → 10000n (0.01 * 10^6)
 *
 * Supports:
 *   "$0.01"   → dollar amount
 *   "0.01"    → dollar amount without prefix
 *   "10000"   → raw smallest unit (no decimal point)
 */
export function parsePrice(price: string, asset = "USDC"): bigint {
	const cleaned = price.replace(/^\$/, "").trim();
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
