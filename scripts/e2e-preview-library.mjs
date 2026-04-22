#!/usr/bin/env node
// Library-import smoke test for the pkg.pr.new preview.
//
// Run from a consumer dir that has `x402-tollbooth` installed (e.g. the
// preview tarball from pkg-pr-new). Validates that the published package's
// named exports resolve and that createGateway() can boot a gateway in-process.
//
// Exits 0 on success, non-zero on failure.

import http from "node:http";
import { createGateway } from "x402-tollbooth";

const FAILURES = [];
function expect(desc, ok, detail = "") {
	if (ok) {
		console.log(`  PASS: ${desc}`);
	} else {
		console.log(`  FAIL: ${desc}${detail ? ` — ${detail}` : ""}`);
		FAILURES.push(desc);
	}
}

// ── 1. Mock upstream on a random port ───────────────────────────────────────

const upstream = http.createServer((req, res) => {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ method: req.method, path: req.url }));
});
await new Promise((resolve) => upstream.listen(0, resolve));
const upstreamPort = upstream.address().port;
console.log(`==> Mock upstream on port ${upstreamPort}`);

// ── 2. Build a minimal config and boot the gateway ──────────────────────────

const gwPort = 50000 + Math.floor(Math.random() * 10000);

const config = {
	gateway: { port: gwPort },
	wallets: { "base-sepolia": "0xTestWallet" },
	accepts: [{ asset: "USDC", network: "base-sepolia" }],
	defaults: { price: "$0.01", timeout: 60 },
	facilitator: "http://localhost:19999",
	upstreams: { api: { url: `http://localhost:${upstreamPort}` } },
	routes: { "GET /free": { upstream: "api", price: "$0" } },
};

const gateway = createGateway(config);
await gateway.start({ silent: true });
console.log(`==> Gateway on port ${gwPort}`);

const base = `http://localhost:${gwPort}`;

// ── 3. Smoke tests ──────────────────────────────────────────────────────────

console.log("");
console.log("=== Library smoke tests ===");

try {
	{
		const res = await fetch(`${base}/health`);
		const body = await res.text();
		expect(
			"GET /health returns 200",
			res.status === 200 && body.includes('"status":"ok"'),
			`status=${res.status} body=${body}`,
		);
	}
	{
		const res = await fetch(`${base}/free`);
		const body = await res.text();
		expect(
			"GET /free proxies to upstream",
			res.status === 200 && body.includes('"path":"/free"'),
			`status=${res.status} body=${body}`,
		);
	}
	{
		const res = await fetch(`${base}/nonexistent`);
		expect(
			"GET /nonexistent returns 404",
			res.status === 404,
			`status=${res.status}`,
		);
	}
} finally {
	await gateway.stop();
	upstream.close();
}

console.log("");
if (FAILURES.length > 0) {
	console.log(`FAILED (${FAILURES.length})`);
	process.exit(1);
}
console.log("OK");
