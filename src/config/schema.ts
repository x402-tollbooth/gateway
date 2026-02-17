import { z } from "zod";

const payToSplitSchema = z.object({
	address: z.string().min(1),
	share: z.number().min(0).max(1),
});

const payToSchema = z.union([z.string().min(1), z.array(payToSplitSchema)]);

const acceptedPaymentSchema = z.object({
	asset: z.string().min(1),
	network: z.string().min(1),
});

const pricingFnRefSchema = z.object({
	fn: z.string().min(1),
});

const matchRuleSchema = z.object({
	where: z.record(z.union([z.string(), z.number(), z.boolean()])),
	price: z.string().min(1),
	payTo: payToSchema.optional(),
});

const routeHooksSchema = z
	.object({
		onRequest: z.string().optional(),
		onPriceResolved: z.string().optional(),
		onSettled: z.string().optional(),
		onResponse: z.string().optional(),
		onError: z.string().optional(),
	})
	.strict()
	.optional();

const routeConfigSchema = z.object({
	upstream: z.string().min(1),
	path: z.string().optional(),
	price: z.union([z.string().min(1), pricingFnRefSchema]).optional(),
	match: z.array(matchRuleSchema).optional(),
	fallback: z.string().optional(),
	accepts: z.array(acceptedPaymentSchema).optional(),
	payTo: payToSchema.optional(),
	hooks: routeHooksSchema,
});

const upstreamConfigSchema = z.object({
	url: z.string().url(),
	headers: z.record(z.string()).optional(),
	timeout: z.number().positive().optional(),
});

export const tollboothConfigSchema = z.object({
	gateway: z
		.object({
			port: z.number().int().positive().default(3000),
			discovery: z.boolean().default(true),
			hostname: z.string().optional(),
		})
		.default({}),

	wallets: z.record(z.string().min(1)),

	accepts: z.array(acceptedPaymentSchema).min(1),

	defaults: z
		.object({
			price: z.string().default("$0.001"),
			timeout: z.number().positive().default(60),
		})
		.default({}),

	upstreams: z.record(upstreamConfigSchema),

	routes: z.record(routeConfigSchema),

	hooks: routeHooksSchema,
});

export type TollboothConfigInput = z.input<typeof tollboothConfigSchema>;
