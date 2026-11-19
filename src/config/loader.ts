import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import type { TollboothConfig } from "../types.js";
import { interpolateEnv } from "./env.js";
import { tollboothConfigSchema } from "./schema.js";

const CONFIG_FILENAMES = [
	"tollbooth.config.yaml",
	"tollbooth.config.yml",
	"tollbooth.config.json",
	"tollbooth.yaml",
	"tollbooth.yml",
	"tollbooth.json",
];

/**
 * Load and validate a tollbooth config file.
 * If no path is provided, searches for known config filenames in cwd.
 */
export function loadConfig(configPath?: string): TollboothConfig {
	const filePath = configPath ? resolve(configPath) : findConfig();

	if (!filePath) {
		throw new Error(
			`No tollbooth config found. Create one of: ${CONFIG_FILENAMES.join(", ")}`,
		);
	}

	if (!existsSync(filePath)) {
		throw new Error(`Config file not found: ${filePath}`);
	}

	const raw = readFileSync(filePath, "utf-8");
	const parsed = filePath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);

	const interpolated = interpolateEnv(parsed);

	// reportInput: lets getSuggestion tell a missing field from a wrong type.
	const result = tollboothConfigSchema.safeParse(interpolated, {
		reportInput: true,
	});

	if (!result.success) {
		throw new Error(formatZodErrors(result.error.issues));
	}

	return result.data as TollboothConfig;
}

function issuePath(issue: z.core.$ZodIssue): string {
	return issue.path.map(String).join(".");
}

type InvalidTypeIssue = Extract<z.core.$ZodIssue, { code: "invalid_type" }>;

/** zod's expected type, in config terms ("record" is just an object here). */
function expectedName(issue: InvalidTypeIssue): string {
	if (issue.expected === "record") return "object";
	if (issue.expected === "int") return "integer";
	return issue.expected;
}

/** Type name of the value that was found instead. */
function receivedName(issue: InvalidTypeIssue): string {
	const value = issue.input;
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	if (issue.expected === "int" && typeof value === "number") return "float";
	return typeof value;
}

/** zod 4's type messages ("Invalid input: expected record, received
 * undefined") are written for developers; keep the config-friendly wording. */
function getMessage(issue: z.core.$ZodIssue): string {
	if (issue.code !== "invalid_type") return issue.message;
	if (issue.input === undefined) return "Required";
	return `Expected ${expectedName(issue)}, received ${receivedName(issue)}`;
}

function getSuggestion(issue: z.core.$ZodIssue): string | undefined {
	const path = issuePath(issue);

	switch (issue.code) {
		case "invalid_type":
			if (issue.input === undefined) {
				return `Add the "${path}" field to your config`;
			}
			return `Expected ${expectedName(issue)}, got ${receivedName(issue)}`;

		case "invalid_format":
			if (issue.format === "url") {
				return 'Expected a valid URL (e.g. "https://api.example.com")';
			}
			break;

		case "too_small":
			if (issue.origin === "array") {
				return `Add at least ${issue.minimum} item(s)`;
			}
			if (issue.origin === "string") {
				return "Value cannot be empty";
			}
			break;

		case "unrecognized_keys":
			return `Remove unknown field(s): ${issue.keys.join(", ")}`;
	}

	return undefined;
}

function formatZodErrors(issues: z.core.$ZodIssue[]): string {
	const lines = issues.map((issue) => {
		const path = issue.path.length > 0 ? issuePath(issue) : "(root)";
		const suggestion = getSuggestion(issue);
		let line = `  ${path} — ${getMessage(issue)}`;
		if (suggestion) {
			line += `\n    → ${suggestion}`;
		}
		return line;
	});

	return `Invalid tollbooth config:\n\n${lines.join("\n\n")}`;
}

function findConfig(): string | undefined {
	const cwd = process.cwd();
	for (const name of CONFIG_FILENAMES) {
		const fullPath = resolve(cwd, name);
		if (existsSync(fullPath)) {
			return fullPath;
		}
	}
	return undefined;
}
