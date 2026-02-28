import {
	type IncomingMessage,
	type ServerResponse,
	createServer as createHttpServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export interface PortableServerOptions {
	port: number;
	hostname?: string;
	fetch: (
		request: Request,
		info: { remoteAddress?: string },
	) => Response | Promise<Response>;
}

export interface PortableServer {
	port: number;
	stop(): void;
}

/**
 * Create a portable HTTP server that works on both Node.js and Bun.
 *
 * Accepts a Web-standard `fetch` handler (Request → Response) and wraps
 * it with Node's `node:http` server, which Bun also supports.
 */
export function createPortableServer(
	options: PortableServerOptions,
): Promise<PortableServer> {
	return new Promise((resolve, reject) => {
		const httpServer = createHttpServer(async (req, res) => {
			try {
				const request = toRequest(req, httpServer);
				const remoteAddress = req.socket.remoteAddress;
				const response = await options.fetch(request, { remoteAddress });
				await writeResponse(response, res);
			} catch (err) {
				if (!res.headersSent) {
					res.writeHead(500);
				}
				res.end();
			}
		});

		httpServer.on("error", reject);

		httpServer.listen(options.port, options.hostname, () => {
			const addr = httpServer.address() as AddressInfo;
			resolve({
				port: addr.port,
				stop() {
					httpServer.close();
				},
			});
		});
	});
}

function toRequest(req: IncomingMessage, server: ReturnType<typeof createHttpServer>): Request {
	const addr = server.address() as AddressInfo;
	const host = req.headers.host ?? `localhost:${addr.port}`;
	const url = `http://${host}${req.url ?? "/"}`;

	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value == null) continue;
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v);
		} else {
			headers.set(key, value);
		}
	}

	const method = req.method ?? "GET";
	const hasBody = method !== "GET" && method !== "HEAD";

	return new Request(url, {
		method,
		headers,
		body: hasBody
			? (Readable.toWeb(req as unknown as Readable) as ReadableStream)
			: null,
		duplex: hasBody ? "half" : undefined,
	});
}

async function writeResponse(
	response: Response,
	res: ServerResponse,
): Promise<void> {
	const headers: Record<string, string | string[]> = {};
	response.headers.forEach((value, key) => {
		const existing = headers[key];
		if (existing != null) {
			headers[key] = Array.isArray(existing)
				? [...existing, value]
				: [existing, value];
		} else {
			headers[key] = value;
		}
	});

	res.writeHead(response.status, headers);

	if (!response.body) {
		res.end();
		return;
	}

	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
	} finally {
		res.end();
	}
}
