import { describe, expect, test } from "vitest";
import { resolveClientIp } from "../network/client-ip.js";

describe("resolveClientIp", () => {
	test("no proxy: uses direct remote client ip", () => {
		const req = new Request("http://localhost/test");
		expect(
			resolveClientIp(req, {
				remoteIp: "198.51.100.10",
				trustProxy: false,
			}),
		).toBe("198.51.100.10");
	});

	test("single proxy hop: trustProxy=1 resolves original client from x-forwarded-for", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "203.0.113.50" },
		});
		expect(
			resolveClientIp(req, {
				remoteIp: "10.0.0.5",
				trustProxy: 1,
			}),
		).toBe("203.0.113.50");
	});

	test("multiple proxy hops: trustProxy=2 resolves original client from x-forwarded-for chain", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "203.0.113.50, 70.41.3.18" },
		});
		expect(
			resolveClientIp(req, {
				remoteIp: "10.0.0.5",
				trustProxy: 2,
			}),
		).toBe("203.0.113.50");
	});

	test("uses Forwarded header when present", () => {
		const req = new Request("http://localhost/test", {
			headers: {
				forwarded: "for=203.0.113.43;proto=https, for=10.0.0.2;by=10.0.0.1",
				"x-forwarded-for": "198.51.100.5",
			},
		});
		expect(
			resolveClientIp(req, {
				remoteIp: "10.0.0.1",
				trustProxy: true,
			}),
		).toBe("203.0.113.43");
	});

	test("supports x-real-ip fallback when trustProxy is enabled", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-real-ip": "203.0.113.111" },
		});
		expect(
			resolveClientIp(req, {
				remoteIp: "10.0.0.5",
				trustProxy: true,
			}),
		).toBe("203.0.113.111");
	});

	test("does not trust headers when remote proxy ip is outside configured cidrs", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "203.0.113.50" },
		});
		expect(
			resolveClientIp(req, {
				remoteIp: "10.0.0.5",
				trustProxy: { hops: 1, cidrs: ["192.0.2.0/24"] },
			}),
		).toBe("10.0.0.5");
	});

	test("validates intermediate proxy hops against cidrs", () => {
		const req = new Request("http://localhost/test", {
			headers: { "x-forwarded-for": "203.0.113.50, 172.16.0.5" },
		});
		expect(
			resolveClientIp(req, {
				remoteIp: "10.0.0.5",
				trustProxy: { hops: 2, cidrs: ["10.0.0.0/8"] },
			}),
		).toBe("10.0.0.5");
	});
});
