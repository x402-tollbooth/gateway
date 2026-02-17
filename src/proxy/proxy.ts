import type { UpstreamConfig, UpstreamResponse } from "../types.js";

/**
 * Forward a request to an upstream API.
 */
export async function proxyRequest(
	upstream: UpstreamConfig,
	upstreamPath: string,
	originalRequest: Request,
	body?: ArrayBuffer,
): Promise<UpstreamResponse> {
	const url = new URL(upstreamPath, upstream.url);

	// Copy original query string
	const originalUrl = new URL(originalRequest.url);
	url.search = originalUrl.search;

	// Build headers: merge upstream headers + original headers, strip payment headers
	const headers = new Headers();

	// Copy original headers (except hop-by-hop and payment headers)
	const skipHeaders = new Set([
		"host",
		"connection",
		"payment-required",
		"payment-signature",
		"payment-response",
		"transfer-encoding",
	]);

	for (const [key, value] of originalRequest.headers.entries()) {
		if (!skipHeaders.has(key.toLowerCase())) {
			headers.set(key, value);
		}
	}

	// Apply upstream headers (these override originals)
	if (upstream.headers) {
		for (const [key, value] of Object.entries(upstream.headers)) {
			headers.set(key, value);
		}
	}

	const init: RequestInit = {
		method: originalRequest.method,
		headers,
		signal: AbortSignal.timeout(upstream.timeout ?? 30_000),
	};

	// Attach body for non-GET/HEAD requests
	if (body && !["GET", "HEAD"].includes(originalRequest.method.toUpperCase())) {
		init.body = body;
	}

	const response = await fetch(url.toString(), init);

	// Convert to our response type
	const responseHeaders: Record<string, string> = {};
	for (const [key, value] of response.headers.entries()) {
		responseHeaders[key] = value;
	}

	return {
		status: response.status,
		headers: responseHeaders,
		body: response.body ?? "",
	};
}
