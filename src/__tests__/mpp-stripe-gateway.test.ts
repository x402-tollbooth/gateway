import { afterEach, describe, expect, test, vi } from "vitest";
import { createGateway } from "../gateway.js";
import { base64UrlDecode, base64UrlEncode } from "../mpp/headers.js";
import type { TollboothConfig, TollboothGateway } from "../types.js";
import { serve, type TestServer } from "./helpers/test-server.js";

// In-memory stand-in for Stripe's PaymentIntents API, shared with the mock.
const stripeState = vi.hoisted(() => {
	type FakeIntent = {
		id: string;
		amount: number;
		currency: string;
		status: string;
		created: number;
		metadata: Record<string, string>;
		client_secret: string;
	};
	const intents = new Map<string, FakeIntent>();
	let seq = 0;
	return {
		intents,
		add(intent: Omit<FakeIntent, "client_secret">) {
			intents.set(intent.id, { ...intent, client_secret: "secret" });
		},
		nextId() {
			seq += 1;
			return `pi_gw_${seq}`;
		},
	};
});

vi.mock("stripe", () => {
	class FakeStripe {
		paymentIntents = {
			async create(params: {
				amount: number;
				currency: string;
				metadata: Record<string, string>;
			}) {
				const id = stripeState.nextId();
				stripeState.add({
					id,
					amount: params.amount,
					currency: params.currency,
					status: "requires_payment_method",
					created: Math.floor(Date.now() / 1000),
					metadata: params.metadata,
				});
				return stripeState.intents.get(id);
			},
			async retrieve(id: string) {
				const intent = stripeState.intents.get(id);
				if (!intent) throw new Error(`No such payment_intent: '${id}'`);
				return { ...intent };
			},
			async confirm(id: string) {
				const intent = stripeState.intents.get(id);
				if (!intent) throw new Error(`No such payment_intent: '${id}'`);
				intent.status = "succeeded";
				return { ...intent };
			},
		};
	}
	return { default: FakeStripe };
});

let upstream: TestServer;
let gw: TollboothGateway;
let upstreamHits = 0;

afterEach(async () => {
	await gw?.stop();
	await upstream?.stop();
	stripeState.intents.clear();
});

async function startGateway(): Promise<void> {
	upstreamHits = 0;
	upstream = await serve({
		port: 0,
		fetch: () => {
			upstreamHits++;
			return Response.json({ ok: true });
		},
	});
	const config: TollboothConfig = {
		gateway: { port: 0, discovery: false },
		wallets: { "base-sepolia": "0xTestWallet" },
		accepts: [{ asset: "USDC", network: "base-sepolia" }],
		defaults: { price: "$0.001", timeout: 60 },
		upstreams: { api: { url: `http://localhost:${upstream.port}` } },
		routes: {
			"GET /cheap": { upstream: "api", price: "$0.01" },
			"GET /expensive": { upstream: "api", price: "$1.00" },
		},
		settlement: {
			strategy: "mpp",
			methods: [{ type: "stripe", secretKey: "sk_test_fake" }],
		},
	};
	gw = createGateway(config);
	await gw.start({ silent: true });
}

/** Request a 402, then "pay" the returned PaymentIntent. */
async function getPaidChallenge(path: string) {
	const res = await fetch(`http://localhost:${gw.port}${path}`);
	expect(res.status).toBe(402);
	const header = res.headers.get("www-authenticate") ?? "";
	const challengeId = header.match(/id="([^"]+)"/)?.[1];
	const request = header.match(/request="([^"]+)"/)?.[1];
	expect(challengeId).toBeTruthy();
	const { paymentIntentId } = JSON.parse(base64UrlDecode(request as string));
	const intent = stripeState.intents.get(paymentIntentId);
	if (intent) intent.status = "succeeded";
	return { challengeId: challengeId as string, paymentIntentId };
}

function payWith(path: string, challengeId: string, paymentIntentId: string) {
	const payload = base64UrlEncode(JSON.stringify({ paymentIntentId }));
	return fetch(`http://localhost:${gw.port}${path}`, {
		headers: {
			Authorization: `Payment id="${challengeId}", payload="${payload}"`,
		},
	});
}

describe("MPP Stripe through the gateway (#74)", () => {
	test("a paid intent for this challenge unlocks the route once", async () => {
		await startGateway();
		const { challengeId, paymentIntentId } =
			await getPaidChallenge("/expensive");

		const first = await payWith("/expensive", challengeId, paymentIntentId);
		expect(first.status).toBe(200);
		expect(first.headers.get("payment-receipt")).toBeTruthy();

		const replay = await payWith("/expensive", challengeId, paymentIntentId);
		expect(replay.status).toBe(402);
		expect(upstreamHits).toBe(1);
	});

	test("concurrent replays of one intent reach upstream once", async () => {
		await startGateway();
		const { challengeId, paymentIntentId } =
			await getPaidChallenge("/expensive");

		const results = await Promise.all(
			Array.from({ length: 5 }, () =>
				payWith("/expensive", challengeId, paymentIntentId),
			),
		);
		const statuses = results.map((r) => r.status).sort();
		expect(statuses).toEqual([200, 402, 402, 402, 402]);
		expect(upstreamHits).toBe(1);
	});

	test("an intent paid for a cheaper route is rejected on another route", async () => {
		await startGateway();
		const cheap = await getPaidChallenge("/cheap");

		const res = await payWith(
			"/expensive",
			cheap.challengeId,
			cheap.paymentIntentId,
		);
		expect(res.status).toBe(402);
		expect(upstreamHits).toBe(0);
	});

	test("an intent cannot be paired with another request's challenge id", async () => {
		await startGateway();
		const a = await getPaidChallenge("/expensive");
		const b = await getPaidChallenge("/expensive");

		const res = await payWith("/expensive", b.challengeId, a.paymentIntentId);
		expect(res.status).toBe(402);
		expect(upstreamHits).toBe(0);
	});

	test("an unrelated succeeded PaymentIntent on the account is rejected", async () => {
		await startGateway();
		stripeState.add({
			id: "pi_shop_order",
			amount: 10_000,
			currency: "usd",
			status: "succeeded",
			created: Math.floor(Date.now() / 1000),
			metadata: {},
		});

		const res = await payWith("/expensive", "anything", "pi_shop_order");
		expect(res.status).toBe(402);
		expect(upstreamHits).toBe(0);
	});
});
