import { describe, expect, test } from "bun:test";
import { parsePrice, formatPrice } from "../pricing/parser.js";

describe("parsePrice", () => {
	test("parses dollar amount with $ prefix", () => {
		expect(parsePrice("$0.01")).toBe(10000n);
	});

	test("parses dollar amount without prefix", () => {
		expect(parsePrice("0.01")).toBe(10000n);
	});

	test("parses whole dollar amount", () => {
		expect(parsePrice("$1.00")).toBe(1000000n);
	});

	test("parses sub-cent amount", () => {
		expect(parsePrice("$0.001")).toBe(1000n);
	});

	test("parses raw smallest unit (no decimal)", () => {
		expect(parsePrice("10000")).toBe(10000n);
	});

	test("handles DAI (18 decimals)", () => {
		expect(parsePrice("$1.00", "DAI")).toBe(1000000000000000000n);
	});

	test("parses zero", () => {
		expect(parsePrice("$0.00")).toBe(0n);
	});
});

describe("formatPrice", () => {
	test("formats smallest unit to dollar string", () => {
		expect(formatPrice(10000n)).toBe("$0.010000");
	});

	test("formats 1 USDC", () => {
		expect(formatPrice(1000000n)).toBe("$1.000000");
	});
});
