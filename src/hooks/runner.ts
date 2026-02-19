import type {
	ErrorHook,
	ErrorHookContext,
	GlobalHooksConfig,
	HookContext,
	HookResult,
	PriceResolvedHook,
	RequestHook,
	RequestHookContext,
	ResponseHook,
	ResponseHookContext,
	ResponseHookResult,
	RouteHooksConfig,
	SettledHook,
	SettledHookContext,
} from "../types.js";

type HookFn =
	| RequestHook
	| PriceResolvedHook
	| SettledHook
	| ResponseHook
	| ErrorHook;
const hookCache = new Map<string, HookFn>();

/**
 * Load a hook function from a file path. Caches the import.
 */
async function loadHook<T extends HookFn>(path: string): Promise<T> {
	const cached = hookCache.get(path);
	if (cached) return cached as T;

	const mod = await import(/* @vite-ignore */ path);
	const fn = mod.default;

	if (typeof fn !== "function") {
		throw new Error(`Hook "${path}" must export a default function`);
	}

	hookCache.set(path, fn);
	return fn as T;
}

/**
 * Resolve which hook path to use: route-level overrides global.
 */
function resolveHookPath(
	hookName: keyof GlobalHooksConfig,
	routeHooks?: RouteHooksConfig,
	globalHooks?: GlobalHooksConfig,
): string | undefined {
	return routeHooks?.[hookName] ?? globalHooks?.[hookName];
}

/**
 * Run the onRequest hook. Returns a rejection result or void.
 */
export async function runOnRequest(
	ctx: RequestHookContext,
	routeHooks?: RouteHooksConfig,
	globalHooks?: GlobalHooksConfig,
): Promise<HookResult | undefined> {
	const path = resolveHookPath("onRequest", routeHooks, globalHooks);
	if (!path) return;

	const hook = await loadHook<RequestHook>(path);
	return hook(ctx);
}

/**
 * Run the onPriceResolved hook.
 */
export async function runOnPriceResolved(
	ctx: HookContext,
	routeHooks?: RouteHooksConfig,
	globalHooks?: GlobalHooksConfig,
): Promise<HookResult | undefined> {
	const path = resolveHookPath("onPriceResolved", routeHooks, globalHooks);
	if (!path) return;

	const hook = await loadHook<PriceResolvedHook>(path);
	return hook(ctx);
}

/**
 * Run the onSettled hook.
 */
export async function runOnSettled(
	ctx: SettledHookContext,
	routeHooks?: RouteHooksConfig,
	globalHooks?: GlobalHooksConfig,
): Promise<HookResult | undefined> {
	const path = resolveHookPath("onSettled", routeHooks, globalHooks);
	if (!path) return;

	const hook = await loadHook<SettledHook>(path);
	return hook(ctx);
}

/**
 * Run the onResponse hook. Can return a modified response.
 */
export async function runOnResponse(
	ctx: ResponseHookContext,
	routeHooks?: RouteHooksConfig,
	globalHooks?: GlobalHooksConfig,
): Promise<ResponseHookResult> {
	const path = resolveHookPath("onResponse", routeHooks, globalHooks);
	if (!path) return;

	const hook = await loadHook<ResponseHook>(path);
	return hook(ctx);
}

/**
 * Run the onError hook.
 */
export async function runOnError(
	ctx: ErrorHookContext,
	routeHooks?: RouteHooksConfig,
	globalHooks?: GlobalHooksConfig,
): Promise<void> {
	const path = resolveHookPath("onError", routeHooks, globalHooks);
	if (!path) return;

	const hook = await loadHook<ErrorHook>(path);
	await hook(ctx);
}
