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
