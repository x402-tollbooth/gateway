import {
	createPortableServer,
	type PortableServer,
} from "../../runtime/server.js";

export type TestServer = PortableServer;

/**
 * Create a test HTTP server with a Web-standard fetch handler.
 *
 * Drop-in replacement for `Bun.serve({ port: 0, fetch })` in tests.
 * Returns a server with `.port` and `.stop()`.
 */
export function serve(options: {
	port: number;
	fetch: (req: Request) => Response | Promise<Response>;
}): Promise<TestServer> {
	return createPortableServer({
		port: options.port,
		fetch: (req) => options.fetch(req),
	});
}

/**
 * Create a mock facilitator server that routes /verify and /settle
 * to the provided handlers.
 */
export function mockFacilitator(options: {
	verify: (req: Request) => Response | Promise<Response>;
	settle: (req: Request) => Response | Promise<Response>;
}): Promise<TestServer> {
	return serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/verify") return options.verify(req);
			if (url.pathname === "/settle") return options.settle(req);
			return new Response("Not found", { status: 404 });
		},
	});
}
