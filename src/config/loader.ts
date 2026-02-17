import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
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
		const issues = result.error.issues
			.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
			.join("\n");
		throw new Error(`Invalid tollbooth config:\n${issues}`);
	}

	return result.data as TollboothConfig;
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
