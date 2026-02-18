// ── Public API ───────────────────────────────────────────────────────────────

export { loadConfig } from "./config/loader.js";
export { tollboothConfigSchema } from "./config/schema.js";
export { createGateway } from "./gateway.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type {
	AcceptedPayment,
	DefaultsConfig,
	ErrorHook,
	ErrorHookContext,
	GatewayConfig,
	HookContext,
	HookResult,
	MatchRule,
	PayToSplit,
	PriceResolvedHook,
	PricingFn,
	PricingFnInput,
	// Hooks
	RequestHook,
	RequestHookContext,
	ResponseHook,
	ResponseHookContext,
	RouteConfig,
	SettledHook,
	SettledHookContext,
	SettlementInfo,
	TollboothConfig,
	TollboothError,
	TollboothGateway,
	// Request/Response
	TollboothRequest,
	UpstreamConfig,
	UpstreamResponse,
} from "./types.js";

// ── Utilities ────────────────────────────────────────────────────────────────

export { generateDiscoveryMetadata } from "./discovery/metadata.js";
export { log } from "./logger.js";
export { extractModel, resolveOpenAIPrice } from "./openai/handler.js";
export { DEFAULT_MODEL_PRICES } from "./pricing/models.js";
export { formatPrice, parsePrice } from "./pricing/parser.js";
