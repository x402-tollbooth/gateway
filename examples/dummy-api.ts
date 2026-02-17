/**
 * Fake upstream API for testing tollbooth locally.
 * Run: bun run examples/dummy-api.ts
 */
Bun.serve({
	port: 4000,
	fetch(req) {
		const url = new URL(req.url);

		if (req.method === "GET" && url.pathname === "/weather") {
			return Response.json({ temp: 22, city: "Milan", condition: "sunny" });
		}

		if (req.method === "POST" && url.pathname === "/chat") {
			return (async () => {
				const body = (await req.json()) as Record<string, unknown>;
				return Response.json({
					model: body.model ?? "unknown",
					reply: `Hello from ${body.model ?? "unknown"}!`,
					tokens: 42,
				});
			})();
		}

		if (req.method === "GET" && url.pathname.startsWith("/data/")) {
			const id = url.pathname.split("/")[2];
			return Response.json({ id, data: `Results for query ${id}`, rows: 100 });
		}

		return Response.json({ error: "not found" }, { status: 404 });
	},
});

console.log("🎯 Dummy API running on http://localhost:4000");