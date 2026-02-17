// ── Public API ───────────────────────────────────────────────────────────────

export { createGateway } from "./gateway.js";
export { loadConfig } from "./config/loader.js";
export { tollboothConfigSchema } from "./config/schema.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type {
	TollboothConfig,
	TollboothGateway,
	GatewayConfig,
	UpstreamConfig,
	RouteConfig,
	MatchRule,
	AcceptedPayment,
	PayToSplit,
	DefaultsConfig,
	PricingFn,
	PricingFnInput,
	// Hooks
	RequestHook,
	PriceResolvedHook,
	SettledHook,
	ResponseHook,
	ErrorHook,
	HookResult,
	RequestHookContext,
	HookContext,
	SettledHookContext,
	ResponseHookContext,
	ErrorHookContext,
	// Request/Response
	TollboothRequest,
	UpstreamResponse,
	SettlementInfo,
	TollboothError,
} from "./types.js";

// ── Utilities ────────────────────────────────────────────────────────────────

export { parsePrice, formatPrice } from "./pricing/parser.js";
export { generateDiscoveryMetadata } from "./discovery/metadata.js";
