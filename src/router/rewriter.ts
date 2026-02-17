/**
 * Rewrite a path template with resolved params.
 * e.g. "/v1/query/${params.query_id}/results" with params { query_id: "123" }
 *   → "/v1/query/123/results"
 */
export function rewritePath(
	template: string,
	params: Record<string, string>,
	query: Record<string, string>,
): string {
	return template.replace(/\$\{(params|query)\.([^}]+)\}/g, (_match, source: string, key: string) => {
		const map = source === "params" ? params : query;
		const value = map[key];
		if (value === undefined) {
			throw new Error(`Path rewrite references "${source}.${key}" but it is not available`);
		}
		return encodeURIComponent(value);
	});
}

/**
 * Extract named params from a route pattern.
 * e.g. pattern "GET /data/dune/:query_id" matched against "GET /data/dune/12345"
 *   → { query_id: "12345" }
 */
export function extractParams(pattern: string, actualPath: string): Record<string, string> | null {
	// Split "METHOD /path" → just the path part
	const patternPath = pattern.includes(" ") ? pattern.split(" ")[1] : pattern;
	const patternSegments = patternPath.split("/").filter(Boolean);
	const actualSegments = actualPath.split("/").filter(Boolean);

	if (patternSegments.length !== actualSegments.length) {
		return null;
	}

	const params: Record<string, string> = {};

	for (let i = 0; i < patternSegments.length; i++) {
		const pat = patternSegments[i];
		const act = actualSegments[i];

		if (pat.startsWith(":")) {
			params[pat.slice(1)] = decodeURIComponent(act);
		} else if (pat !== act) {
			return null;
		}
	}

	return params;
}
