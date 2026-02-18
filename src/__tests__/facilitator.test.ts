import { describe, expect, test } from "bun:test";
import { generateDiscoveryMetadata } from "../discovery/metadata.js";
import type { TollboothConfig } from "../types.js";

const baseConfig: TollboothConfig = {
	gateway: { port: 3000, discovery: true },
	wallets: { base: "0xtest" },
	accepts: [{ asset: "USDC", network: "base" }],
	defaults: { price: "$0.001", timeout: 60 },
	upstreams: {
		api: { url: "https://api.example.com" },
	},
	routes: {
		"GET /test": {
			upstream: "api",
			price: "$0.01",
		},
	},
};

describe("facilitator in discovery metadata", () => {
	test("hardcoded default facilitator when not configured", () => {
		const metadata = generateDiscoveryMetadata(baseConfig);
		expect(metadata.endpoints[0].facilitator).toBe(
			"https://x402.org/facilitator",
		);
	});

	test("top-level facilitator appears on all endpoints", () => {
		const config: TollboothConfig = {
			...baseConfig,
			facilitator: "https://custom.example.com",
		};
		const metadata = generateDiscoveryMetadata(config);
		expect(metadata.endpoints[0].facilitator).toBe(
			"https://custom.example.com",
		);
	});

	test("route-level facilitator overrides top-level", () => {
		const config: TollboothConfig = {
			...baseConfig,
			facilitator: "https://global.example.com",
			routes: {
				"GET /test": {
					upstream: "api",
					price: "$0.01",
					facilitator: "https://route.example.com",
				},
				"POST /other": {
					upstream: "api",
					price: "$0.02",
				},
			},
		};
		const metadata = generateDiscoveryMetadata(config);
		const testEndpoint = metadata.endpoints.find((e) => e.path === "/test");
		const otherEndpoint = metadata.endpoints.find((e) => e.path === "/other");

		expect(testEndpoint?.facilitator).toBe("https://route.example.com");
		expect(otherEndpoint?.facilitator).toBe("https://global.example.com");
	});
});
