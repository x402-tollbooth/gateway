// ── Public API ───────────────────────────────────────────────────────────────

export { loadConfig } from "./config/loader.js";
export { tollboothConfigSchema } from "./config/schema.js";
export { createGateway } from "./gateway.js";
export { FacilitatorSettlement } from "./settlement/facilitator.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type {
	AcceptedPayment,
	CorsConfig,
	DefaultsConfig,
	ErrorHook,
	ErrorHookContext,
	GatewayConfig,
	HookContext,
	HookResult,
	MatchRule,
	PaymentRequirementsPayload,
	PayToSplit,
	PriceResolvedHook,
	PricingFn,
	PricingFnInput,
	PricingModel,
	// Hooks
	RequestHook,
	RequestHookContext,
	ResponseHook,
	ResponseHookContext,
	ResponseHookResult,
	RouteConfig,
	RoutePricingConfig,
	SettledHook,
	SettledHookContext,
	SettlementDecision,
	SettlementInfo,
	SettlementSkippedInfo,
	// Settlement Strategy
	SettlementStrategy,
	SettlementStrategyConfig,
	SettlementVerification,
	TimeSessionStore,
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
export {
	buildExportSpec,
	buildOpenAPISpec,
	importOpenAPIRoutes,
	mergeOpenAPISpec,
} from "./openapi/spec.js";
export { DEFAULT_MODEL_PRICES } from "./pricing/models.js";
export { formatPrice, parsePrice } from "./pricing/parser.js";
export { MemoryTimeSessionStore } from "./session/store.js";
