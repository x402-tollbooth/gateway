import { afterEach, describe, expect, test } from "bun:test";
import { createGateway } from "../gateway.js";
import { proxyRequest } from "../proxy/proxy.js";
import type { TollboothConfig, UpstreamConfig } from "../types.js";

/**
 * Helper: read a ReadableStream to a string.
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let result = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		result += decoder.decode(value, { stream: true });
	}
	return result;
}

/**
 * Helper: create a mock SSE upstream that sends events with delays.
 */
function createSSEServer(
	events: string[],
	intervalMs = 10,
): ReturnType<typeof Bun.serve> {
	return Bun.serve({
		port: 0,
		fetch() {
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const encoder = new TextEncoder();
					let i = 0;
					const id = setInterval(() => {
						if (i < events.length) {
							controller.enqueue(encoder.encode(events[i]));
							i++;
						} else {
							clearInterval(id);
							controller.close();
						}
					}, intervalMs);
				},
			});

			return new Response(stream, {
				headers: {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					"x-request-id": "sse-test",
				},
			});
		},
	});
}

// ── proxyRequest unit tests ──────────────────────────────────────────────────

describe("SSE streaming — proxyRequest", () => {
	let server: ReturnType<typeof Bun.serve>;

	afterEach(() => {
		server?.stop();
	});

	test("streams SSE events through without buffering", async () => {
		const events = [
			'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
			'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
			"data: [DONE]\n\n",
		];

		server = createSSEServer(events);

		const upstream: UpstreamConfig = {
			url: `http://localhost:${server.port}`,
		};
		const req = new Request(`http://localhost:${server.port}/v1/chat`, {
			method: "POST",
			body: JSON.stringify({ stream: true }),
			headers: { "content-type": "application/json" },
		});

		const response = await proxyRequest(
			upstream,
			"/v1/chat",
			req,
			await req.clone().arrayBuffer(),
		);

		// Body must be a ReadableStream (not buffered)
		expect(response.body).toBeInstanceOf(ReadableStream);

		const text = await readStream(response.body as ReadableStream);
		expect(text).toContain("Hello");
		expect(text).toContain(" world");
		expect(text).toContain("[DONE]");
	});

	test("preserves SSE response headers", async () => {
		server = createSSEServer(["data: hi\n\n"]);

		const upstream: UpstreamConfig = {
			url: `http://localhost:${server.port}`,
		};
		const req = new Request(`http://localhost:${server.port}/test`, {
			method: "GET",
		});

		const response = await proxyRequest(upstream, "/test", req);

		expect(response.headers["content-type"]).toBe("text/event-stream");
		expect(response.headers["cache-control"]).toBe("no-cache");
		expect(response.headers["x-request-id"]).toBe("sse-test");
	});

	test("SSE stream survives past connection timeout", async () => {
		// Events spread over 300ms — well past the 100ms connection timeout.
		server = Bun.serve({
			port: 0,
			fetch() {
				const stream = new ReadableStream<Uint8Array>({
					start(controller) {
						const encoder = new TextEncoder();
						setTimeout(() => {
							controller.enqueue(encoder.encode("data: event-1\n\n"));
						}, 50);
						setTimeout(() => {
							// This fires AFTER the 100ms timeout — stream must survive.
							controller.enqueue(encoder.encode("data: event-2\n\n"));
						}, 200);
						setTimeout(() => {
							controller.enqueue(encoder.encode("data: event-3\n\n"));
							controller.close();
						}, 300);
					},
				});

				return new Response(stream, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});

		const upstream: UpstreamConfig = {
			url: `http://localhost:${server.port}`,
			timeout: 100, // 100ms — stream extends past this
		};
		const req = new Request(`http://localhost:${server.port}/sse`, {
			method: "GET",
		});

		const response = await proxyRequest(upstream, "/sse", req);
		const text = await readStream(response.body as ReadableStream);

		expect(text).toContain("event-1");
		expect(text).toContain("event-2");
		expect(text).toContain("event-3");
	});

	test("connection timeout still fires if upstream is unreachable", async () => {
		const upstream: UpstreamConfig = {
			// Connect to a port that is not listening
			url: "http://localhost:1",
			timeout: 200,
		};
		const req = new Request("http://localhost:1/sse", { method: "GET" });

		await expect(proxyRequest(upstream, "/sse", req)).rejects.toThrow();
	});

	test("non-streaming responses still work", async () => {
		server = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({ text: "Hello world" });
			},
		});

		const upstream: UpstreamConfig = {
			url: `http://localhost:${server.port}`,
		};
		const req = new Request(`http://localhost:${server.port}/test`, {
			method: "GET",
		});

		const response = await proxyRequest(upstream, "/test", req);
		expect(response.status).toBe(200);
		expect(response.headers["content-type"]).toContain("application/json");
	});
});

// ── Gateway integration test ─────────────────────────────────────────────────

describe("SSE streaming — gateway integration", () => {
	let sseUpstream: ReturnType<typeof Bun.serve>;
	let facilitator: ReturnType<typeof Bun.serve>;
	let gateway: ReturnType<typeof createGateway>;

	afterEach(async () => {
		await gateway?.stop();
		sseUpstream?.stop();
		facilitator?.stop();
	});

	test("SSE streams through the full gateway after payment", async () => {
		// ── Mock SSE upstream ───────────────────────────────────────────────
		sseUpstream = createSSEServer([
			'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
			'data: {"id":"2","choices":[{"delta":{"content":"!"}}]}\n\n',
			"data: [DONE]\n\n",
		]);

		// ── Mock facilitator (always approves) ──────────────────────────────
		facilitator = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/verify") {
					return Response.json({
						isValid: true,
						payer: "0xabc",
					});
				}
				if (url.pathname === "/settle") {
					return Response.json({
						success: true,
						payer: "0xabc",
						transaction: "0xtx",
						network: "base-sepolia",
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});

		// ── Gateway config ──────────────────────────────────────────────────
		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${facilitator.port}`,
			upstreams: {
				llm: { url: `http://localhost:${sseUpstream.port}` },
			},
			routes: {
				"POST /v1/chat/completions": {
					upstream: "llm",
					price: "$0.01",
				},
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		// ── Make request with a mock payment signature ───────────────────────
		const paymentSig = btoa(
			JSON.stringify({ x402Version: 2, payload: "mock" }),
		);
		const res = await fetch(
			`http://localhost:${gateway.port}/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"payment-signature": paymentSig,
				},
				body: JSON.stringify({ model: "test", stream: true }),
			},
		);

		// ── Verify response ─────────────────────────────────────────────────
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/event-stream");
		expect(res.headers.get("cache-control")).toBe("no-cache");
		expect(res.headers.get("payment-response")).toBeTruthy();

		// Read streamed body
		expect(res.body).not.toBeNull();
		const text = await readStream(res.body as ReadableStream);
		expect(text).toContain('"content":"Hi"');
		expect(text).toContain('"content":"!"');
		expect(text).toContain("[DONE]");
	});

	test("non-streaming response through gateway still works", async () => {
		sseUpstream = Bun.serve({
			port: 0,
			fetch() {
				return Response.json({ id: "resp-1", text: "Hello" });
			},
		});

		facilitator = Bun.serve({
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/verify") {
					return Response.json({ isValid: true, payer: "0xabc" });
				}
				if (url.pathname === "/settle") {
					return Response.json({
						success: true,
						payer: "0xabc",
						transaction: "0xtx",
						network: "base-sepolia",
					});
				}
				return new Response("Not found", { status: 404 });
			},
		});

		const config: TollboothConfig = {
			gateway: { port: 0, discovery: false },
			wallets: { "base-sepolia": "0xtest" },
			accepts: [{ asset: "USDC", network: "base-sepolia" }],
			defaults: { price: "$0.001", timeout: 60 },
			facilitator: `http://localhost:${facilitator.port}`,
			upstreams: { api: { url: `http://localhost:${sseUpstream.port}` } },
			routes: {
				"GET /data": { upstream: "api", price: "$0.01" },
			},
		};

		gateway = createGateway(config);
		await gateway.start({ silent: true });

		const paymentSig = btoa(
			JSON.stringify({ x402Version: 2, payload: "mock" }),
		);
		const res = await fetch(`http://localhost:${gateway.port}/data`, {
			headers: { "payment-signature": paymentSig },
		});

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(res.headers.get("payment-response")).toBeTruthy();

		const body = await res.json();
		expect(body.text).toBe("Hello");
	});
});
