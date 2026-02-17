const ENV_PATTERN = /\$\{([^}]+)\}/g;

/** Prefixes reserved for runtime path-rewrite templates — not env vars. */
const RUNTIME_PREFIXES = ["params.", "query."];

/**
 * Recursively interpolate ${ENV_VAR} references in config values.
 * Skips runtime template variables like ${params.*} and ${query.*}.
 * Throws if a referenced env var is not set.
 */
export function interpolateEnv<T>(value: T): T {
	if (typeof value === "string") {
		return value.replace(ENV_PATTERN, (original, varName: string) => {
			const trimmed = varName.trim();
			if (RUNTIME_PREFIXES.some((p) => trimmed.startsWith(p))) {
				return original;
			}
			const envValue = process.env[trimmed];
			if (envValue === undefined) {
				throw new Error(`Environment variable "${trimmed}" is not set (referenced in config)`);
			}
			return envValue;
		}) as T;
	}

	if (Array.isArray(value)) {
		return value.map((item) => interpolateEnv(item)) as T;
	}

	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
			result[key] = interpolateEnv(val);
		}
		return result as T;
	}

	return value;
}
