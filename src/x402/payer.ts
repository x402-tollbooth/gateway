import { isMppAuthorization, parseCredential } from "../mpp/headers.js";
import { decodePaymentSignature, HEADERS } from "./headers.js";

/**
 * Decode the payer address from the payment header.
 *
 * Checks MPP `Authorization: Payment` first, then falls back to
 * x402 `payment-signature`.
 */
export function extractPayerFromPaymentHeader(
	request: Request,
): string | undefined {
	// MPP: Authorization: Payment id="...", payload="..."
	const authHeader = request.headers.get("authorization");
	if (authHeader && isMppAuthorization(authHeader)) {
		const cred = parseCredential(authHeader);
		if (cred?.payload) {
			const payer = extractPayerFromPayload(
				cred.payload as Record<string, unknown>,
			);
			if (payer) return payer;
		}
	}

	// x402: payment-signature
	const paymentHeader = request.headers.get(HEADERS.PAYMENT_SIGNATURE);
	if (!paymentHeader) {
		return undefined;
	}

	try {
		const payload = decodePaymentSignature(paymentHeader) as Record<
			string,
			unknown
		>;
		return extractPayerFromPayload(payload);
	} catch {
		return undefined;
	}
}

/**
 * Extract payer address from a decoded payment payload.
 */
function extractPayerFromPayload(
	payload: Record<string, unknown>,
): string | undefined {
	const payer =
		getNestedString(payload, "payload", "authorization", "from") ??
		getNestedString(payload, "from") ??
		getNestedString(payload, "payer");
	return payer ? payer.toLowerCase() : undefined;
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
