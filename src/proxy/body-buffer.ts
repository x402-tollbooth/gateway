import type { RouteConfig } from "../types.js";

/**
 * Check if a route needs the request body buffered for matching.
 * True if:
 * - The route has match rules that reference body.* fields
 * - The route is type: openai-compatible (needs body to extract model)
 */
export function routeNeedsBody(route: RouteConfig): boolean {
	if (route.type === "openai-compatible") return true;

	if (!route.match) return false;

	return route.match.some((rule) =>
		Object.keys(rule.where).some((key) => key.startsWith("body.")),
	);
}

/**
 * Buffer a request body from a ReadableStream.
 * Returns the parsed body (JSON) and a new stream for forwarding.
 */
export async function bufferRequestBody(
	request: Request,
): Promise<{ parsed: unknown; raw: ArrayBuffer }> {
	const raw = await request.arrayBuffer();
	let parsed: unknown;

	const contentType = request.headers.get("content-type") ?? "";
	if (contentType.includes("application/json")) {
		try {
			const text = new TextDecoder().decode(raw);
			parsed = JSON.parse(text);
		} catch {
			// Not valid JSON, leave parsed as undefined
		}
	}

	return { parsed, raw };
}
