#!/usr/bin/env bun

import { loadConfig } from "./config/loader.js";
import { createGateway } from "./gateway.js";

const args = process.argv.slice(2);
const command = args[0] ?? "start";

switch (command) {
	case "start":
	case "dev": {
		const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
		try {
			const config = loadConfig(configPath);
			const gateway = createGateway(config);
			await gateway.start();
		} catch (error) {
			console.error(
				"❌",
				error instanceof Error ? error.message : "Failed to start tollbooth",
			);
			process.exit(1);
		}
		break;
	}

	case "validate": {
		const configPath = args.find((a) => a.startsWith("--config="))?.split("=")[1];
		try {
			const config = loadConfig(configPath);
			const routeCount = Object.keys(config.routes).length;
			const upstreamCount = Object.keys(config.upstreams).length;
			console.log(`✅ Config is valid`);
			console.log(`   ${upstreamCount} upstream(s), ${routeCount} route(s)`);
		} catch (error) {
			console.error(
				"❌",
				error instanceof Error ? error.message : "Invalid config",
			);
			process.exit(1);
		}
		break;
	}

	case "help":
	default:
		console.log(`
⛩️  tollbooth — Turn any API into a paid x402 API

Usage:
  tollbooth start [--config=path]    Start the gateway
  tollbooth dev [--config=path]      Start in dev mode (with watch)
  tollbooth validate [--config=path] Validate config without starting
  tollbooth help                     Show this help message
`);
		break;
}
