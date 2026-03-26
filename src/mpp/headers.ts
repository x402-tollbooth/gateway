import type { MppChallenge, MppCredential } from "./types.js";

// ── Header names ────────────────────────────────────────────────────────────

export const MPP_HEADERS = {
	/** Server → Client: payment challenge (402 response). */
	WWW_AUTHENTICATE: "www-authenticate",
	/** Client → Server: payment credential (request). */
	AUTHORIZATION: "authorization",
	/** Server → Client: payment receipt (success response). */
	PAYMENT_RECEIPT: "payment-receipt",
} as const;

export const MPP_SCHEME = "Payment";

// ── Base64url helpers (RFC 4648 §5) ─────────────────────────────────────────

export function base64UrlEncode(data: string): string {
	return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(encoded: string): string {
	let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	while (base64.length % 4) base64 += "=";
	return atob(base64);
}

// ── Serialize / parse ───────────────────────────────────────────────────────

/**
 * Serialize an MppChallenge into the `WWW-Authenticate: Payment ...` header value.
 *
 * ```
 * Payment id="abc", method="tempo", intent="charge", amount="0.01",
 *   currency="usd", decimals=6, description="...", request="<base64url>"
 * ```
 */
export function serializeChallenge(challenge: MppChallenge): string {
	const parts = [
		`${MPP_SCHEME} id="${challenge.id}"`,
		`method="${challenge.method}"`,
		`intent="${challenge.intent}"`,
		`amount="${challenge.amount}"`,
		`currency="${challenge.currency}"`,
		`decimals=${challenge.decimals}`,
		`description="${escapeParam(challenge.description)}"`,
		`request="${challenge.request}"`,
	];
	return parts.join(", ");
}

/**
 * Check whether an Authorization header uses the MPP `Payment` scheme.
 */
export function isMppAuthorization(header: string): boolean {
	return header.startsWith(`${MPP_SCHEME} `);
}

/**
 * Parse an `Authorization: Payment id="...", payload="..."` header.
 *
 * Returns null if the header is not a valid MPP credential.
 */
export function parseCredential(header: string): MppCredential | null {
	if (!isMppAuthorization(header)) return null;

	const params = parseParams(header.slice(MPP_SCHEME.length + 1));
	const id = params.get("id");
	const payloadEncoded = params.get("payload");

	if (!id || !payloadEncoded) return null;

	try {
		const decoded = JSON.parse(base64UrlDecode(payloadEncoded));
		return { id, payload: decoded, rawHeader: header };
	} catch {
		return null;
	}
}

/**
 * Serialize a `Payment-Receipt` header value.
 */
export function serializeReceipt(id: string, receipt: unknown): string {
	const encoded = base64UrlEncode(JSON.stringify(receipt));
	return `id="${id}", receipt="${encoded}"`;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Escape double-quotes inside a parameter value. */
function escapeParam(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Parse `key="value", key=value` structured header parameters.
 * Handles quoted and unquoted values.
 */
function parseParams(input: string): Map<string, string> {
	const params = new Map<string, string>();
	const regex = /(\w+)=(?:"((?:[^"\\]|\\.)*)"|(\S+?)(?:,|$))/g;
	for (const match of input.matchAll(regex)) {
		const key = match[1];
		const value = match[2] !== undefined ? match[2] : match[3];
		if (key && value !== undefined) {
			params.set(key, value.replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
		}
	}
	return params;
}
