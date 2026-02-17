import { describe, expect, test } from "bun:test";
import { evaluateMatchers } from "../router/matcher.js";
import type { MatchRule } from "../types.js";

describe("evaluateMatchers", () => {
	const rules: MatchRule[] = [
		{ where: { "body.model": "claude-haiku-*" }, price: "$0.005" },
		{ where: { "body.model": "claude-sonnet-*" }, price: "$0.015" },
		{ where: { "body.model": "claude-opus-*" }, price: "$0.075" },
	];

	test("matches glob pattern", () => {
		const result = evaluateMatchers(rules, {
			body: { model: "claude-haiku-4-5-20251001" },
			query: {},
			headers: {},
			params: {},
		});
		expect(result?.price).toBe("$0.005");
	});

	test("matches second rule", () => {
		const result = evaluateMatchers(rules, {
			body: { model: "claude-sonnet-4-5-20250929" },
			query: {},
			headers: {},
			params: {},
		});
		expect(result?.price).toBe("$0.015");
	});

	test("returns undefined when no match", () => {
		const result = evaluateMatchers(rules, {
			body: { model: "gpt-4o" },
			query: {},
			headers: {},
			params: {},
		});
		expect(result).toBeUndefined();
	});

	test("matches exact string (no glob)", () => {
		const exactRules: MatchRule[] = [
			{ where: { "query.format": "csv" }, price: "$0.01" },
		];
		const result = evaluateMatchers(exactRules, {
			query: { format: "csv" },
			headers: {},
			params: {},
		});
		expect(result?.price).toBe("$0.01");
	});

	test("matches nested body field", () => {
		const nestedRules: MatchRule[] = [
			{ where: { "body.options.stream": true }, price: "$0.02" },
		];
		const result = evaluateMatchers(nestedRules, {
			body: { options: { stream: true } },
			query: {},
			headers: {},
			params: {},
		});
		expect(result?.price).toBe("$0.02");
	});

	test("returns first match (top-to-bottom)", () => {
		const overlapping: MatchRule[] = [
			{ where: { "body.model": "claude-*" }, price: "$0.01" },
			{ where: { "body.model": "claude-opus-*" }, price: "$0.075" },
		];
		const result = evaluateMatchers(overlapping, {
			body: { model: "claude-opus-4-5" },
			query: {},
			headers: {},
			params: {},
		});
		expect(result?.price).toBe("$0.01"); // first match wins
	});
});
