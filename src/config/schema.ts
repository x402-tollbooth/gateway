import { z } from "zod";

const durationSchema = z
	.string()
	.regex(/^\d+[smhd]$/, 'Must be a duration like "30s", "5m", "1h", or "1d"');

const rateLimitSchema = z
	.object({
		requests: z.number().int().positive(),
		window: durationSchema,
	})
	.strict();

const verificationCacheSchema = z
	.object({
		ttl: z
			.string()
			.regex(
				/^\d+[smhd]$/,
				'Must be a duration like "30s", "5m", "1h", or "1d"',
			),
	})
	.strict();

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

const routePricingSchema = z
	.object({
		model: z.enum(["request", "time"]).optional(),
		duration: durationSchema.optional(),
		price: z.union([z.string().min(1), pricingFnRefSchema]).optional(),
		match: z.array(matchRuleSchema).optional(),
		fallback: z.string().optional(),
	})
	.strict()
	.superRefine((pricing, ctx) => {
		if (pricing.model === "time" && !pricing.duration) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["duration"],
				message: 'Required when pricing.model is "time"',
			});
		}

		if (pricing.model !== "time" && pricing.duration) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["duration"],
				message: 'Only allowed when pricing.model is "time"',
			});
		}
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

const facilitatorMappingSchema = z.object({
	default: z.string().url().optional(),
	chains: z.record(z.string().url()).optional(),
});

const facilitatorSchema = z.union([z.string().url(), facilitatorMappingSchema]);

const settlementStrategySchema = z
	.object({
		strategy: z.enum(["facilitator", "custom"]),
		url: z.string().url().optional(),
		module: z.string().min(1).optional(),
	})
	.strict()
	.refine(
		(data) => data.strategy !== "custom" || !!data.module,
		"Custom settlement strategy requires a 'module' path",
	);

const corsSchema = z
	.object({
		allowedOrigins: z.array(z.string().min(1)).min(1),
		allowedMethods: z
			.array(z.string().min(1))
			.min(1)
			.default(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]),
		allowedHeaders: z
			.array(z.string().min(1))
			.default(["content-type", "payment-signature"]),
		exposedHeaders: z
			.array(z.string().min(1))
			.default(["payment-required", "payment-response"]),
		credentials: z.boolean().default(false),
		maxAge: z.number().int().nonnegative().optional(),
	})
	.strict()
	.superRefine((cors, ctx) => {
		if (cors.credentials && cors.allowedOrigins.includes("*")) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["allowedOrigins"],
				message: 'Wildcard "*" origin is not allowed when credentials=true',
			});
		}
	});

const routeConfigSchema = z.object({
	upstream: z.string().min(1),
	type: z.enum(["token-based", "openai-compatible"]).optional(),
	path: z.string().optional(),
	price: z.union([z.string().min(1), pricingFnRefSchema]).optional(),
	match: z.array(matchRuleSchema).optional(),
	fallback: z.string().optional(),
	pricing: routePricingSchema.optional(),
	accepts: z.array(acceptedPaymentSchema).optional(),
	payTo: payToSchema.optional(),
	hooks: routeHooksSchema,
	metadata: z.record(z.unknown()).optional(),
	facilitator: facilitatorSchema.optional(),
	rateLimit: rateLimitSchema.optional(),
	verificationCache: verificationCacheSchema.optional(),
	models: z.record(z.string().min(1)).optional(),
	settlement: z.enum(["before-response", "after-response"]).optional(),
});

const upstreamConfigSchema = z.object({
	url: z.string().url(),
	headers: z.record(z.string()).optional(),
	timeout: z.number().positive().optional(),
	openapi: z
		.string()
		.min(1)
		.refine(
			(s) =>
				s.startsWith("http://") ||
				s.startsWith("https://") ||
				s.startsWith("/") ||
				s.startsWith("./") ||
				s.startsWith("../") ||
				s.endsWith(".json") ||
				s.endsWith(".yaml") ||
				s.endsWith(".yml"),
			"Must be a URL (http/https) or a file path (.json/.yaml/.yml)",
		)
		.optional(),
	defaultPrice: z
		.string()
		.regex(
			/^\$?\d+(\.\d+)?$/,
			'Must be a price like "$0.01", "0.01", or "10000"',
		)
		.optional(),
});

export const tollboothConfigSchema = z.object({
	gateway: z
		.object({
			port: z.number().int().positive().default(3000),
			discovery: z.boolean().default(true),
			hostname: z.string().optional(),
			cors: corsSchema.optional(),
		})
		.default({}),

	wallets: z.record(z.string().min(1)),

	accepts: z.array(acceptedPaymentSchema).min(1),

	defaults: z
		.object({
			price: z.string().default("$0.001"),
			timeout: z.number().positive().default(60),
			rateLimit: rateLimitSchema.optional(),
			verificationCache: verificationCacheSchema.optional(),
		})
		.default({}),

	upstreams: z.record(upstreamConfigSchema),

	routes: z.record(routeConfigSchema),

	hooks: routeHooksSchema,

	facilitator: facilitatorSchema.optional(),

	settlement: settlementStrategySchema.optional(),
});

export type TollboothConfigInput = z.input<typeof tollboothConfigSchema>;
