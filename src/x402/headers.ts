/**
 * x402 V2 header names (no deprecated X-* prefix).
 */
export const HEADERS = {
	PAYMENT_REQUIRED: "payment-required",
	PAYMENT_SIGNATURE: "payment-signature",
	PAYMENT_RESPONSE: "payment-response",
} as const;

/**
 * Encode a payment requirements object to base64 for the PAYMENT-REQUIRED header.
 */
export function encodePaymentRequired(requirements: unknown): string {
	const json = JSON.stringify(requirements);
	return btoa(json);
}

/**
 * Decode a base64 PAYMENT-REQUIRED header back to an object.
 */
export function decodePaymentRequired(header: string): unknown {
	const json = atob(header);
	return JSON.parse(json);
}

/**
 * Decode a base64 PAYMENT-SIGNATURE header.
 */
export function decodePaymentSignature(header: string): unknown {
	const json = atob(header);
	return JSON.parse(json);
}

/**
 * Encode a settlement response for the PAYMENT-RESPONSE header.
 */
export function encodePaymentResponse(response: unknown): string {
	const json = JSON.stringify(response);
	return btoa(json);
}

/**
 * Extract the payer wallet address from a payment header string.
 *
 * Handles both formats:
 * - x402: base64-encoded JSON (from `payment-signature` header)
 * - MPP: `Payment id="...", payload="..."` (from `Authorization` header)
 *
 * Checks common payload shapes: payload.authorization.from, from, payer.
 * Returns undefined if the header cannot be parsed or doesn't contain a payer.
 */
export function extractPayerFromHeader(
	paymentHeader: string,
): string | undefined {
	try {
		let payload: Record<string, unknown>;

		if (paymentHeader.startsWith("Payment ")) {
			// MPP format: parse the payload parameter
			const payloadMatch = paymentHeader.match(/payload="([^"]+)"/);
			if (!payloadMatch) return undefined;
			// base64url decode
			let base64 = payloadMatch[1].replace(/-/g, "+").replace(/_/g, "/");
			while (base64.length % 4) base64 += "=";
			payload = JSON.parse(atob(base64)) as Record<string, unknown>;
		} else {
			// x402 format: base64-encoded JSON
			payload = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
		}

		return (
			getNestedString(payload, "payload", "authorization", "from") ??
			getNestedString(payload, "from") ??
			getNestedString(payload, "payer")
		);
	} catch {
		return undefined;
	}
}

function getNestedString(
	obj: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	let current: unknown = obj;
	for (const key of keys) {
		if (current == null || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" && current.length > 0
		? current
		: undefined;
}
