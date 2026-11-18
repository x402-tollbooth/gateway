import type Stripe from "stripe";
import { describe, expect, test, vi } from "vitest";
import {
	StripeMethod,
	type StripePaymentIntentsClient,
} from "../mpp/stripe.js";
import { MppSettlement } from "../settlement/mpp.js";
import type {
	PaymentClaimStore,
	PaymentRequirementsPayload,
} from "../types.js";
import { RedisVerificationCacheStore } from "../verification-cache/redis-store.js";
import { MemoryVerificationCacheStore } from "../verification-cache/store.js";
import { MockRedisClient } from "./helpers/mock-redis.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function requirement(
	overrides: Partial<PaymentRequirementsPayload> = {},
): PaymentRequirementsPayload {
	return {
		scheme: "exact",
		network: "base-sepolia",
		maxAmountRequired: "50000", // $0.05 in USDC units → 5 cents
		resource: "/expensive",
		description: "GET /expensive",
		payTo: "0xTestWallet",
		maxTimeoutSeconds: 60,
		asset: "USDC",
		...overrides,
	};
}

function intent(
	overrides: Partial<Stripe.PaymentIntent> = {},
): Stripe.PaymentIntent {
	return {
		id: "pi_test_1",
		object: "payment_intent",
		amount: 5,
		currency: "usd",
		status: "succeeded",
		created: Math.floor(Date.now() / 1000),
		metadata: {
			mpp_challenge_id: "ch_1",
			resource: "/expensive",
			network: "base-sepolia",
		},
		...overrides,
	} as Stripe.PaymentIntent;
}

/** In-memory fake of the Stripe PaymentIntents API. */
function fakeStripe(intents: Stripe.PaymentIntent[]) {
	const byId = new Map(intents.map((i) => [i.id, i]));
	const client = {
		paymentIntents: {
			create: vi.fn(async (params: Stripe.PaymentIntentCreateParams) => {
				const created = intent({
					id: `pi_created_${byId.size + 1}`,
					amount: params.amount,
					currency: params.currency,
					status: "requires_payment_method",
					metadata: params.metadata as Stripe.Metadata,
					client_secret: "secret",
				});
				byId.set(created.id, created);
				return created;
			}),
			retrieve: vi.fn(async (id: string) => {
				const found = byId.get(id);
				if (!found) throw new Error(`No such payment_intent: '${id}'`);
				return found;
			}),
			confirm: vi.fn(async (id: string) => {
				const found = byId.get(id);
				if (!found) throw new Error(`No such payment_intent: '${id}'`);
				found.status = "succeeded";
				return found;
			}),
		},
	} satisfies StripePaymentIntentsClient;
	return client;
}

function method(
	intents: Stripe.PaymentIntent[],
	claimStore: PaymentClaimStore = new MemoryVerificationCacheStore(),
) {
	const client = fakeStripe(intents);
	return {
		client,
		stripe: new StripeMethod({ secretKey: "sk_test", client, claimStore }),
	};
}

const ctx = { challengeId: "ch_1" };

// ── Binding ─────────────────────────────────────────────────────────────────

describe("StripeMethod.verify: binding to challenge and route", () => {
	test("accepts an intent issued for this challenge and route", async () => {
		const { stripe } = method([intent()]);
		const v = await stripe.verify(
			{ paymentIntentId: "pi_test_1" },
			[requirement()],
			ctx,
		);
		expect(v).toMatchObject({
			paymentIntentId: "pi_test_1",
			requirementIndex: 0,
			amount: "5",
		});
	});

	test("rejects a credential with no challenge id", async () => {
		const { stripe } = method([intent()]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()]),
		).rejects.toThrow(/challenge id/);
	});

	test("rejects an intent issued for a different challenge", async () => {
		const { stripe } = method([intent()]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], {
				challengeId: "ch_other",
			}),
		).rejects.toThrow(/not issued for this challenge/);
	});

	test("rejects an unrelated merchant PaymentIntent (no tollbooth metadata)", async () => {
		const { stripe } = method([intent({ id: "pi_shop", metadata: {} })]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_shop" }, [requirement()], ctx),
		).rejects.toThrow(/not issued for this challenge/);
	});

	test("rejects an intent created for a different route", async () => {
		const { stripe } = method([
			intent({
				metadata: {
					mpp_challenge_id: "ch_1",
					resource: "/cheap",
					network: "base-sepolia",
				},
			}),
		]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/does not match/);
	});

	test("rejects an intent created for a different network", async () => {
		const { stripe } = method([
			intent({
				metadata: {
					mpp_challenge_id: "ch_1",
					resource: "/expensive",
					network: "base",
				},
			}),
		]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/does not match/);
	});

	test("rejects an intent for less than the route price", async () => {
		const { stripe } = method([intent({ amount: 1 })]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/does not match/);
	});

	test("rejects an intent in a different currency", async () => {
		const { stripe } = method([intent({ currency: "eur" })]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/does not match/);
	});

	test("rejects an intent older than the max age", async () => {
		const twoHoursAgo = Math.floor(Date.now() / 1000) - 2 * 60 * 60;
		const { stripe } = method([intent({ created: twoHoursAgo })]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/expired/);
	});

	test("picks the matching requirement index", async () => {
		const { stripe } = method([
			intent({
				metadata: {
					mpp_challenge_id: "ch_1",
					resource: "/expensive",
					network: "base",
				},
			}),
		]);
		const v = await stripe.verify(
			{ paymentIntentId: "pi_test_1" },
			[requirement(), requirement({ network: "base" })],
			ctx,
		);
		expect(v).toMatchObject({ requirementIndex: 1 });
	});

	test("does not confirm an intent that fails binding", async () => {
		const { stripe, client } = method([
			intent({ status: "requires_payment_method", metadata: {} }),
		]);
		await expect(
			stripe.verify(
				{ paymentIntentId: "pi_test_1", paymentMethod: "pm_card" },
				[requirement()],
				ctx,
			),
		).rejects.toThrow();
		expect(client.paymentIntents.confirm).not.toHaveBeenCalled();
	});

	test("confirms a bound, unpaid intent with the supplied payment method", async () => {
		const { stripe, client } = method([
			intent({ status: "requires_payment_method" }),
		]);
		await stripe.verify(
			{ paymentIntentId: "pi_test_1", paymentMethod: "pm_card" },
			[requirement()],
			ctx,
		);
		expect(client.paymentIntents.confirm).toHaveBeenCalledOnce();
	});

	test("rejects a bound intent that is not paid", async () => {
		const { stripe } = method([intent({ status: "requires_payment_method" })]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/not completed/);
	});

	test("accepts intents created by buildChallenge", async () => {
		const { stripe } = method([]);
		const challenge = await stripe.buildChallenge(
			requirement(),
			"ch_new",
			"GET /expensive",
		);
		const { paymentIntentId } = JSON.parse(
			Buffer.from(challenge.request, "base64url").toString(),
		);
		await expect(
			stripe.verify(
				{ paymentIntentId, paymentMethod: "pm_card" },
				[requirement()],
				{ challengeId: challenge.id },
			),
		).resolves.toMatchObject({ paymentIntentId });
	});
});

// ── Replay ──────────────────────────────────────────────────────────────────

describe("StripeMethod.verify: spend once", () => {
	test("rejects a second use of the same intent", async () => {
		const { stripe } = method([intent()]);
		await stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/already been used/);
	});

	test("concurrent uses of one intent: exactly one succeeds", async () => {
		const { stripe } = method([intent()]);
		const results = await Promise.allSettled(
			Array.from({ length: 10 }, () =>
				stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
	});

	test("a shared Redis claim store blocks replay across instances", async () => {
		const redis = new MockRedisClient();
		const a = method(
			[intent()],
			new RedisVerificationCacheStore(redis, { prefix: "t" }),
		);
		const b = method(
			[intent()],
			new RedisVerificationCacheStore(redis, { prefix: "t" }),
		);
		await a.stripe.verify(
			{ paymentIntentId: "pi_test_1" },
			[requirement()],
			ctx,
		);
		await expect(
			b.stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).rejects.toThrow(/already been used/);
	});

	test("a failed binding check does not burn the intent", async () => {
		const { stripe } = method([intent()]);
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], {
				challengeId: "ch_wrong",
			}),
		).rejects.toThrow();
		await expect(
			stripe.verify({ paymentIntentId: "pi_test_1" }, [requirement()], ctx),
		).resolves.toBeTruthy();
	});
});

// ── MppSettlement wiring ────────────────────────────────────────────────────

describe("MppSettlement passes the credential id to methods", () => {
	test("binds the Authorization id as the challenge id", async () => {
		const { stripe } = method([intent()]);
		const mpp = new MppSettlement([stripe]);
		const v = await mpp.verify(
			{
				id: "ch_1",
				payload: { paymentIntentId: "pi_test_1" },
				rawHeader: "Payment ...",
			},
			[requirement()],
		);
		expect(v).toMatchObject({ methodType: "stripe", challengeId: "ch_1" });
	});

	test("a bare payload (no credential id) cannot pass Stripe", async () => {
		const { stripe } = method([intent()]);
		const mpp = new MppSettlement([stripe]);
		await expect(
			mpp.verify({ paymentIntentId: "pi_test_1" }, [requirement()]),
		).rejects.toThrow(/challenge id/);
	});
});
