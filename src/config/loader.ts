import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodIssue } from "zod";
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

	const result = tollboothConfigSchema.safeParse(interpolated);

	if (!result.success) {
		throw new Error(formatZodErrors(result.error.issues));
	}

	return result.data as TollboothConfig;
}

function getSuggestion(issue: ZodIssue): string | undefined {
	const path = issue.path.join(".");

	switch (issue.code) {
		case "invalid_type":
			if (issue.received === "undefined") {
				return `Add the "${path}" field to your config`;
			}
			return `Expected ${issue.expected}, got ${issue.received}`;

		case "invalid_string":
			if ("validation" in issue && issue.validation === "url") {
				return 'Expected a valid URL (e.g. "https://api.example.com")';
			}
			break;

		case "too_small":
			if ("type" in issue && issue.type === "array") {
				return `Add at least ${issue.minimum} item(s)`;
			}
			if ("type" in issue && issue.type === "string") {
				return "Value cannot be empty";
			}
			break;

		case "unrecognized_keys":
			if ("keys" in issue) {
				const keys = (issue.keys as string[]).join(", ");
				return `Remove unknown field(s): ${keys}`;
			}
			break;
	}

	return undefined;
}

function formatZodErrors(issues: ZodIssue[]): string {
	const lines = issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		const suggestion = getSuggestion(issue);
		let line = `  ${path} — ${issue.message}`;
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
