import { randomUUID } from "node:crypto";

/**
 * Generate a unique challenge ID for an MPP 402 response.
 *
 * Each 402 response gets one challenge ID shared across all methods,
 * binding the credential back to this specific challenge.
 */
export function generateChallengeId(): string {
	return randomUUID();
}
