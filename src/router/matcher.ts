import type { MatchRule } from "../types.js";

interface MatchInput {
	body?: unknown;
	query: Record<string, string>;
	headers: Record<string, string>;
	params: Record<string, string>;
}

/**
 * Evaluate match rules top-to-bottom against request data.
 * Returns the first matching rule, or undefined if none match.
 */
export function evaluateMatchers(rules: MatchRule[], input: MatchInput): MatchRule | undefined {
	for (const rule of rules) {
		if (matchesWhere(rule.where, input)) {
			return rule;
		}
	}
	return undefined;
}

/**
 * Check if all conditions in a `where` clause match the input.
 * Supports dot notation: body.model, query.format, headers.x-api-key, params.id
 * Supports glob matching with * for string values.
 */
function matchesWhere(
	where: Record<string, string | number | boolean>,
	input: MatchInput,
): boolean {
	for (const [path, expected] of Object.entries(where)) {
		const actual = resolvePath(path, input);
		if (!matchesValue(actual, expected)) {
			return false;
		}
	}
	return true;
}

/**
 * Resolve a dot-notation path against the input.
 * e.g. "body.model" → input.body.model
 */
function resolvePath(path: string, input: MatchInput): unknown {
	const segments = path.split(".");
	const root = segments[0];

	let current: unknown;
	switch (root) {
		case "body":
			current = input.body;
			break;
		case "query":
			current = input.query;
			break;
		case "headers":
			current = input.headers;
			break;
		case "params":
			current = input.params;
			break;
		default:
			return undefined;
	}

	for (let i = 1; i < segments.length; i++) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segments[i]];
	}

	return current;
}

/**
 * Match a resolved value against an expected value.
 * String values support glob patterns with *.
 */
function matchesValue(actual: unknown, expected: string | number | boolean): boolean {
	if (actual === undefined || actual === null) {
		return false;
	}

	if (typeof expected === "string" && typeof actual === "string") {
		return globMatch(actual, expected);
	}

	return actual === expected;
}

/**
 * Simple glob matching. Only supports * as wildcard.
 * "claude-haiku-*" matches "claude-haiku-4-5-20251001"
 */
function globMatch(value: string, pattern: string): boolean {
	if (!pattern.includes("*")) {
		return value === pattern;
	}

	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	const regex = new RegExp(`^${escaped}$`);
	return regex.test(value);
}
