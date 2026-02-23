import { isIP } from "node:net";
import type { TrustProxyConfig } from "../types.js";

interface ResolveClientIpOptions {
	trustProxy?: TrustProxyConfig;
	remoteIp?: string;
}

interface TrustProxySettings {
	enabled: boolean;
	hops: number | null;
	cidrs?: string[];
}

const BRACKETED_IPV6_RE = /^\[([^\]]+)\](?::\d+)?$/;
const IPV4_WITH_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/;

/**
 * Resolve the effective client IP for a request.
 *
 * By default forwarded headers are ignored. They are only used when trustProxy
 * is explicitly configured.
 */
export function resolveClientIp(
	request: Request,
	options: ResolveClientIpOptions = {},
): string | undefined {
	const remoteIp = normalizeIp(options.remoteIp);
	const trust = normalizeTrustProxy(options.trustProxy);
	if (!trust.enabled) return remoteIp;

	const chain = extractForwardedChain(request);
	if (chain.length === 0) return remoteIp;

	// If CIDR allowlists are configured, only trust known proxy addresses.
	if (trust.cidrs) {
		if (remoteIp && !isTrustedIp(remoteIp, trust.cidrs)) {
			return remoteIp;
		}

		const trustedProxyHops =
			trust.hops == null ? chain.length - 1 : trust.hops - 1;
		const proxiesToValidate =
			trustedProxyHops <= 0
				? []
				: chain.slice(Math.max(0, chain.length - trustedProxyHops));

		for (const proxyIp of proxiesToValidate) {
			if (!isTrustedIp(proxyIp, trust.cidrs)) {
				return remoteIp;
			}
		}
	}

	// trustProxy: true OR object without hops => trust full chain
	if (trust.hops == null) {
		return chain[0] ?? remoteIp;
	}

	const idx = Math.max(0, chain.length - trust.hops);
	return chain[idx] ?? remoteIp;
}

function normalizeTrustProxy(
	trustProxy: TrustProxyConfig | undefined,
): TrustProxySettings {
	if (trustProxy === true) return { enabled: true, hops: null };
	if (trustProxy === false || trustProxy == null) {
		return { enabled: false, hops: null };
	}
	if (typeof trustProxy === "number")
		return { enabled: true, hops: trustProxy };
	return {
		enabled: true,
		hops: trustProxy.hops ?? null,
		cidrs: trustProxy.cidrs,
	};
}

function extractForwardedChain(request: Request): string[] {
	const forwarded = parseForwardedHeader(request.headers.get("forwarded"));
	if (forwarded.length > 0) return forwarded;

	const xForwardedFor = parseAddressList(
		request.headers.get("x-forwarded-for"),
	);
	if (xForwardedFor.length > 0) return xForwardedFor;

	const xRealIp = normalizeIp(request.headers.get("x-real-ip"));
	return xRealIp ? [xRealIp] : [];
}

function parseForwardedHeader(header: string | null): string[] {
	if (!header) return [];
	const ips: string[] = [];

	for (const entry of header.split(",")) {
		for (const pair of entry.split(";")) {
			const [keyRaw, ...valueParts] = pair.trim().split("=");
			if (!keyRaw || valueParts.length === 0) continue;
			if (keyRaw.toLowerCase() !== "for") continue;

			const valueRaw = valueParts.join("=").trim();
			const parsed = parseForwardedForValue(valueRaw);
			if (parsed) ips.push(parsed);
		}
	}

	return ips;
}

function parseForwardedForValue(value: string): string | undefined {
	let token = stripQuotes(value.trim());
	if (!token || token.toLowerCase() === "unknown" || token.startsWith("_")) {
		return undefined;
	}

	const bracketed = token.match(BRACKETED_IPV6_RE);
	if (bracketed) {
		token = bracketed[1];
	}

	const ipv4WithPort = token.match(IPV4_WITH_PORT_RE);
	if (ipv4WithPort) {
		token = ipv4WithPort[1];
	}

	return normalizeIp(token);
}

function parseAddressList(header: string | null): string[] {
	if (!header) return [];
	return header
		.split(",")
		.map((part) => normalizeIp(part))
		.filter((ip): ip is string => ip != null);
}

function stripQuotes(value: string): string {
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function normalizeIp(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	let value = stripQuotes(raw.trim());
	if (!value) return undefined;

	const bracketed = value.match(BRACKETED_IPV6_RE);
	if (bracketed) {
		value = bracketed[1];
	}

	const ipv4WithPort = value.match(IPV4_WITH_PORT_RE);
	if (ipv4WithPort) {
		value = ipv4WithPort[1];
	}

	// Strip IPv6 zone IDs (e.g. fe80::1%lo0) before validation.
	const zone = value.indexOf("%");
	if (zone !== -1) {
		value = value.slice(0, zone);
	}

	return isIP(value) > 0 ? value.toLowerCase() : undefined;
}

function isTrustedIp(ip: string, cidrs: string[]): boolean {
	return cidrs.some((cidr) => isIpInCidr(ip, cidr));
}

function isIpInCidr(ip: string, cidr: string): boolean {
	const ipBytes = ipToBytes(ip);
	if (!ipBytes) return false;

	const slashIdx = cidr.indexOf("/");
	const base = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx);
	const prefixRaw = slashIdx === -1 ? null : cidr.slice(slashIdx + 1);

	const baseBytes = ipToBytes(base);
	if (!baseBytes || baseBytes.length !== ipBytes.length) return false;

	const maxBits = ipBytes.length * 8;
	const prefix =
		prefixRaw == null || prefixRaw === ""
			? maxBits
			: Number.parseInt(prefixRaw, 10);
	if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) return false;

	return bytesMatchPrefix(ipBytes, baseBytes, prefix);
}

function bytesMatchPrefix(
	a: number[],
	b: number[],
	prefixBits: number,
): boolean {
	const fullBytes = Math.floor(prefixBits / 8);
	const remBits = prefixBits % 8;

	for (let i = 0; i < fullBytes; i++) {
		if (a[i] !== b[i]) return false;
	}

	if (remBits === 0) return true;

	const mask = (0xff << (8 - remBits)) & 0xff;
	return (a[fullBytes] & mask) === (b[fullBytes] & mask);
}

function ipToBytes(ip: string): number[] | undefined {
	const version = isIP(ip);
	if (version === 4) {
		const octets = ip.split(".").map((x) => Number.parseInt(x, 10));
		return octets.length === 4 && octets.every((x) => x >= 0 && x <= 255)
			? octets
			: undefined;
	}
	if (version === 6) return parseIpv6(ip);
	return undefined;
}

function parseIpv6(ip: string): number[] | undefined {
	let normalized = ip.toLowerCase();
	const zoneIdx = normalized.indexOf("%");
	if (zoneIdx !== -1) normalized = normalized.slice(0, zoneIdx);

	if (normalized.includes(".")) {
		const lastColon = normalized.lastIndexOf(":");
		if (lastColon === -1) return undefined;
		const ipv4Bytes = ipToBytes(normalized.slice(lastColon + 1));
		if (!ipv4Bytes || ipv4Bytes.length !== 4) return undefined;
		const a = (ipv4Bytes[0] << 8) | ipv4Bytes[1];
		const b = (ipv4Bytes[2] << 8) | ipv4Bytes[3];
		normalized = `${normalized.slice(0, lastColon)}:${a.toString(16)}:${b.toString(16)}`;
	}

	const parts = normalized.split("::");
	if (parts.length > 2) return undefined;

	const left = parts[0] ? parts[0].split(":").filter(Boolean) : [];
	const right =
		parts.length === 2 && parts[1] ? parts[1].split(":").filter(Boolean) : [];

	const parseGroup = (group: string): number | undefined => {
		if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
		return Number.parseInt(group, 16);
	};

	const leftVals = left.map(parseGroup);
	const rightVals = right.map(parseGroup);
	if (leftVals.some((x) => x == null) || rightVals.some((x) => x == null)) {
		return undefined;
	}

	const leftNums = leftVals as number[];
	const rightNums = rightVals as number[];

	let groups: number[];
	if (parts.length === 1) {
		if (leftNums.length !== 8) return undefined;
		groups = leftNums;
	} else {
		const missing = 8 - leftNums.length - rightNums.length;
		if (missing < 1) return undefined;
		groups = [...leftNums, ...new Array(missing).fill(0), ...rightNums];
	}

	if (groups.length !== 8) return undefined;

	const bytes: number[] = [];
	for (const group of groups) {
		bytes.push((group >> 8) & 0xff, group & 0xff);
	}
	return bytes;
}

export function isValidIpOrCidr(value: string): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (isIP(trimmed) > 0) return true;

	const slash = trimmed.indexOf("/");
	if (slash === -1) return false;

	const base = trimmed.slice(0, slash);
	const prefixRaw = trimmed.slice(slash + 1);
	const baseBytes = ipToBytes(base);
	if (!baseBytes) return false;

	const prefix = Number.parseInt(prefixRaw, 10);
	return (
		Number.isInteger(prefix) && prefix >= 0 && prefix <= baseBytes.length * 8
	);
}
