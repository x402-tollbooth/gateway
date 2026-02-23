// ── Config Types ──────────────────────────────────────────────────────────────

export interface FacilitatorMapping {
	default?: string;
	chains?: Record<string, string>;
}

export interface TollboothConfig {
	gateway: GatewayConfig;
	wallets: Record<string, string>;
	accepts: AcceptedPayment[];
	defaults: DefaultsConfig;
	stores?: StoresConfig;
	upstreams: Record<string, UpstreamConfig>;
	routes: Record<string, RouteConfig>;
	hooks?: GlobalHooksConfig;
	facilitator?: string | FacilitatorMapping;
	settlement?: SettlementStrategyConfig;
}

export interface GatewayConfig {
	port: number;
	discovery: boolean;
	hostname?: string;
	trustProxy?: TrustProxyConfig;
	cors?: CorsConfig;
}

export type TrustProxyConfig = boolean | number | TrustProxyOptions;

export interface TrustProxyOptions {
	hops?: number;
	cidrs?: string[];
}

export interface CorsConfig {
	allowedOrigins: string[];
	allowedMethods: string[];
	allowedHeaders: string[];
	exposedHeaders: string[];
	credentials: boolean;
	maxAge?: number;
}

export type StoreBackend = "memory" | "redis";

export interface RedisStoreOptions {
	connectionTimeout?: number;
	idleTimeout?: number;
	autoReconnect?: boolean;
	maxRetries?: number;
	enableOfflineQueue?: boolean;
	enableAutoPipelining?: boolean;
}

export interface RedisStoreConnectionConfig {
	url: string;
	prefix?: string;
	options?: RedisStoreOptions;
}

export interface RedisStoreConnectionOverride {
	url?: string;
	prefix?: string;
	options?: RedisStoreOptions;
}

export interface StoreSelectionConfig {
	backend?: StoreBackend;
	redis?: RedisStoreConnectionOverride;
}

export interface StoresConfig {
	redis?: RedisStoreConnectionConfig;
	rateLimit?: StoreSelectionConfig;
	verificationCache?: StoreSelectionConfig;
	timeSession?: StoreSelectionConfig;
}

export interface AcceptedPayment {
	asset: string;
	network: string;
}

export interface RateLimitConfig {
	requests: number;
	window: string;
}

export interface DefaultsConfig {
	price: string;
	timeout: number;
	rateLimit?: RateLimitConfig;
	verificationCache?: VerificationCacheConfig;
}

export interface UpstreamConfig {
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
	openapi?: string;
	defaultPrice?: string;
}

// ── Route Types ──────────────────────────────────────────────────────────────

export type PricingModel = "request" | "time";

export interface RoutePricingConfig {
	model?: PricingModel;
	duration?: string;
	price?: string | PricingFnRef;
	match?: MatchRule[];
	fallback?: string;
}

export interface RouteConfig {
	upstream: string;
	type?: "token-based" | "openai-compatible";
	path?: string;
	price?: string | PricingFnRef;
	match?: MatchRule[];
	fallback?: string;
	pricing?: RoutePricingConfig;
	accepts?: AcceptedPayment[];
	payTo?: string | PayToSplit[];
	hooks?: RouteHooksConfig;
	metadata?: Record<string, unknown>;
	facilitator?: string | FacilitatorMapping;
	rateLimit?: RateLimitConfig;
	verificationCache?: VerificationCacheConfig;
	models?: Record<string, string>;
	settlement?: "before-response" | "after-response";
}

export interface MatchRule {
	where: Record<string, string | number | boolean>;
	price: string;
	payTo?: string | PayToSplit[];
}

export interface PayToSplit {
	address: string;
	share: number;
}

export interface PricingFnRef {
	fn: string;
}

// ── Resolved Route (after matching) ──────────────────────────────────────────

export interface ResolvedRoute {
	upstream: UpstreamConfig;
	upstreamPath: string;
	price: bigint;
	asset: string;
	network: string;
	payTo: string | PayToSplit[];
	routeKey: string;
}

// ── Hook Types ───────────────────────────────────────────────────────────────

export interface GlobalHooksConfig {
	onRequest?: string;
	onPriceResolved?: string;
	onSettled?: string;
	onResponse?: string;
	onError?: string;
}

export type RouteHooksConfig = Partial<GlobalHooksConfig>;

export interface HookContext {
	req: TollboothRequest;
	route: ResolvedRoute;
}

export interface RequestHookContext {
	req: TollboothRequest;
	route?: ResolvedRoute;
}

export interface SettledHookContext extends HookContext {
	settlement: SettlementInfo;
}

export interface ResponseHookContext extends HookContext {
	settlement?: SettlementInfo;
	response: UpstreamResponse;
}

export interface SettlementSkippedInfo {
	reason: string;
}

export interface SettlementDecision {
	settle: boolean;
	reason?: string;
}

export interface ErrorHookContext extends HookContext {
	settlement?: SettlementInfo;
	settlementSkipped?: SettlementSkippedInfo;
	error: TollboothError;
}

export type RequestHook = (
	ctx: RequestHookContext,
) => Promise<HookResult | undefined>;
export type PriceResolvedHook = (
	ctx: HookContext,
) => Promise<HookResult | undefined>;
export type SettledHook = (
	ctx: SettledHookContext,
) => Promise<HookResult | undefined>;
export type ResponseHookResult =
	| UpstreamResponse
	| SettlementDecision
	| undefined;
export type ResponseHook = (
	ctx: ResponseHookContext,
) => Promise<ResponseHookResult>;
export type ErrorHook = (ctx: ErrorHookContext) => Promise<void>;

export interface HookResult {
	reject?: boolean;
	status?: number;
	body?: string;
}

// ── Request / Response Types ─────────────────────────────────────────────────

export interface TollboothRequest {
	method: string;
	path: string;
	headers: Record<string, string>;
	query: Record<string, string>;
	body?: unknown;
	payer?: string;
	clientIp?: string;
	params: Record<string, string>;
}

export interface UpstreamResponse {
	status: number;
	headers: Record<string, string>;
	body: ReadableStream<Uint8Array> | string | unknown;
}

export interface SettlementInfo {
	payer: string;
	amount: string;
	transaction: string;
	network: string;
}

export interface TollboothError {
	status: number;
	message: string;
	upstream?: string;
}

// ── Pricing Function ─────────────────────────────────────────────────────────

export interface PricingFnInput {
	body: unknown;
	headers: Record<string, string>;
	query: Record<string, string>;
	params: Record<string, string>;
}

export type PricingFn = (
	input: PricingFnInput,
) => string | number | Promise<string | number>;

// ── Payment Requirements ────────────────────────────────────────────────────

export interface PaymentRequirementsPayload {
	scheme: string;
	network: string;
	maxAmountRequired: string;
	resource: string;
	description: string;
	payTo: string;
	maxTimeoutSeconds: number;
	asset: string;
	// EIP-712 domain info required by the facilitator to verify the signature
	extra?: { name: string; version: string };
}

// ── Settlement Strategy ─────────────────────────────────────────────────────

export interface SettlementVerification {
	payer?: string;
}

export interface SettlementStrategy {
	verify(
		payment: unknown,
		requirements: PaymentRequirementsPayload[],
	): Promise<SettlementVerification>;
	settle(verification: SettlementVerification): Promise<SettlementInfo>;
}

export interface SettlementStrategyConfig {
	strategy: "facilitator" | "custom";
	url?: string;
	module?: string;
}

// ── Rate Limiting ────────────────────────────────────────────────────────────

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	limit: number;
	resetMs: number;
}

export interface RateLimitStore {
	check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

// ── Verification Cache ──────────────────────────────────────────────────────

export interface VerificationCacheConfig {
	ttl: string;
}

export interface VerificationCacheEntry {
	requirementIndex: number;
}

export interface VerificationCacheStore {
	get(key: string): Promise<VerificationCacheEntry | undefined>;
	set(key: string, entry: VerificationCacheEntry, ttlMs: number): Promise<void>;
}

// ── Time-Based Pricing Sessions ─────────────────────────────────────────────

export interface TimeSessionStore {
	get(key: string): Promise<number | undefined>;
	set(key: string, expiresAt: number): Promise<void>;
	close(): void;
}

// ── Gateway ──────────────────────────────────────────────────────────────────

export interface TollboothGateway {
	start(options?: { silent?: boolean }): Promise<void>;
	stop(): Promise<void>;
	readonly port: number;
	readonly config: TollboothConfig;
}
