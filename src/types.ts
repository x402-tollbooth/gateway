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
	upstreams: Record<string, UpstreamConfig>;
	routes: Record<string, RouteConfig>;
	hooks?: GlobalHooksConfig;
	facilitator?: string | FacilitatorMapping;
}

export interface GatewayConfig {
	port: number;
	discovery: boolean;
	hostname?: string;
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
}

export interface UpstreamConfig {
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
}

// ── Route Types ──────────────────────────────────────────────────────────────

export interface RouteConfig {
	upstream: string;
	type?: "token-based" | "openai-compatible";
	path?: string;
	price?: string | PricingFnRef;
	match?: MatchRule[];
	fallback?: string;
	accepts?: AcceptedPayment[];
	payTo?: string | PayToSplit[];
	hooks?: RouteHooksConfig;
	metadata?: Record<string, unknown>;
	facilitator?: string | FacilitatorMapping;
	rateLimit?: RateLimitConfig;
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

// ── Gateway ──────────────────────────────────────────────────────────────────

export interface TollboothGateway {
	start(options?: { silent?: boolean }): Promise<void>;
	stop(): Promise<void>;
	readonly port: number;
	readonly config: TollboothConfig;
}
