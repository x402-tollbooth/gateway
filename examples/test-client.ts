/**
 * Test client — calls tollbooth and shows the 402 responses.
 * Run: bun run examples/test-client.ts
 */
export {};

const BASE = "http://localhost:3000";

async function test(label: string, url: string, init?: RequestInit) {
	console.log(`\n── ${label} ──`);
	try {
		const res = await fetch(url, init);
		const paymentRequired = res.headers.get("payment-required");
		console.log(`Status: ${res.status}`);

		if (res.status === 402 && paymentRequired) {
			const decoded = JSON.parse(atob(paymentRequired));
			console.log("Payment required:", JSON.stringify(decoded, null, 2));
		} else {
			const body = await res.text();
			console.log("Body:", body);
		}
	} catch (e) {
		console.error("Error:", (e as Error).message);
	}
}

// 1. Static price endpoint
await test("GET /weather (static $0.01)", `${BASE}/weather`);

// 2. Body-match: haiku ($0.005)
await test("POST /chat model=haiku ($0.005)", `${BASE}/chat`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ model: "haiku", message: "hello" }),
});

// 3. Body-match: opus ($0.075)
await test("POST /chat model=opus ($0.075)", `${BASE}/chat`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ model: "opus", message: "hello" }),
});

// 4. Param extraction
await test("GET /data/12345 (param, $0.05)", `${BASE}/data/12345`);

// 5. Unknown route → 404
await test("GET /unknown (should 404)", `${BASE}/unknown`);

// 6. Discovery endpoint
await test("GET /.well-known/x402 (discovery)", `${BASE}/.well-known/x402`);

// 7. Health check
await test("GET /health", `${BASE}/health`);