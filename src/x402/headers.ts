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
 * Extract the payer wallet address from a base64-encoded payment-signature header.
 * Checks common x402 payload shapes: payload.authorization.from, from, payer.
 * Returns undefined if the header cannot be parsed or doesn't contain a payer.
 */
export function extractPayerFromHeader(
	paymentHeader: string,
): string | undefined {
	try {
		const payload = JSON.parse(atob(paymentHeader)) as Record<string, unknown>;
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
