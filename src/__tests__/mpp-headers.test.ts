import { describe, expect, test } from "vitest";
import {
	base64UrlDecode,
	base64UrlEncode,
	isMppAuthorization,
	parseCredential,
	serializeChallenge,
	serializeReceipt,
} from "../mpp/headers.js";
import type { MppChallenge } from "../mpp/types.js";

describe("MPP headers", () => {
	describe("base64url", () => {
		test("round-trips standard characters", () => {
			const input = '{"foo":"bar","n":42}';
			expect(base64UrlDecode(base64UrlEncode(input))).toBe(input);
		});

		test("produces URL-safe output (no +, /, or =)", () => {
			const input = "a?b>c<d"; // produces + and / in standard base64
			const encoded = base64UrlEncode(input);
			expect(encoded).not.toMatch(/[+/=]/);
		});
	});

	describe("serializeChallenge", () => {
		const challenge: MppChallenge = {
			id: "abc-123",
			method: "tempo",
			intent: "charge",
			amount: "0.01",
			currency: "usd",
			decimals: 6,
			description: "GET /weather",
			request: base64UrlEncode('{"address":"0xABC"}'),
		};

		test("produces Payment scheme header value", () => {
			const result = serializeChallenge(challenge);
			expect(result).toMatch(/^Payment /);
			expect(result).toContain('id="abc-123"');
			expect(result).toContain('method="tempo"');
			expect(result).toContain('intent="charge"');
			expect(result).toContain('amount="0.01"');
			expect(result).toContain('currency="usd"');
			expect(result).toContain("decimals=6");
			expect(result).toContain('description="GET /weather"');
			expect(result).toContain("request=");
		});

		test("escapes quotes in description", () => {
			const c = { ...challenge, description: 'route "test"' };
			const result = serializeChallenge(c);
			expect(result).toContain('description="route \\"test\\""');
		});
	});

	describe("isMppAuthorization", () => {
		test("returns true for Payment scheme", () => {
			expect(isMppAuthorization('Payment id="abc"')).toBe(true);
		});

		test("returns false for Bearer scheme", () => {
			expect(isMppAuthorization("Bearer xyz")).toBe(false);
		});

		test("returns false for empty string", () => {
			expect(isMppAuthorization("")).toBe(false);
		});
	});

	describe("parseCredential", () => {
		test("parses valid MPP credential", () => {
			const payload = { from: "0xABC", signature: "0xDEF" };
			const encoded = base64UrlEncode(JSON.stringify(payload));
			const header = `Payment id="ch-1", payload="${encoded}"`;

			const result = parseCredential(header);
			expect(result).not.toBeNull();
			expect(result?.id).toBe("ch-1");
			expect(result?.payload).toEqual(payload);
			expect(result?.rawHeader).toBe(header);
		});

		test("returns null for Bearer token", () => {
			expect(parseCredential("Bearer abc")).toBeNull();
		});

		test("returns null for missing payload", () => {
			expect(parseCredential('Payment id="abc"')).toBeNull();
		});

		test("returns null for invalid base64 payload", () => {
			expect(
				parseCredential('Payment id="abc", payload="!!!invalid!!!"'),
			).toBeNull();
		});
	});

	describe("serializeReceipt", () => {
		test("produces correct format", () => {
			const receipt = { payer: "0xABC", transaction: "0xDEF" };
			const result = serializeReceipt("ch-1", receipt);
			expect(result).toContain('id="ch-1"');
			expect(result).toContain('receipt="');
			// Verify round-trip
			const match = result.match(/receipt="([^"]+)"/);
			expect(match).not.toBeNull();
			const decoded = JSON.parse(base64UrlDecode(match?.[1]));
			expect(decoded).toEqual(receipt);
		});
	});
});
