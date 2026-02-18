import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { log } from "../logger.js";

let stdoutLines: string[];
let stderrLines: string[];
let originalWrite: typeof process.stdout.write;
let originalErrWrite: typeof process.stderr.write;

beforeEach(() => {
	stdoutLines = [];
	stderrLines = [];
	originalWrite = process.stdout.write;
	originalErrWrite = process.stderr.write;
	process.stdout.write = ((chunk: string) => {
		stdoutLines.push(chunk.trimEnd());
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		stderrLines.push(chunk.trimEnd());
		return true;
	}) as typeof process.stderr.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	process.stderr.write = originalErrWrite;
	delete process.env.LOG_LEVEL;
	delete process.env.LOG_FORMAT;
});

describe("JSON output (default)", () => {
	test("emits valid JSON with required fields", () => {
		log.info("test_msg", { key: "value" });
		expect(stdoutLines).toHaveLength(1);
		const entry = JSON.parse(stdoutLines[0]);
		expect(entry.level).toBe("info");
		expect(entry.msg).toBe("test_msg");
		expect(entry.key).toBe("value");
		expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	test("includes all contextual fields", () => {
		log.info("request", {
			method: "POST",
			path: "/v1/chat",
			route: "POST /v1/chat/completions",
			price: "$0.01",
			duration_ms: 245,
			status: 200,
		});
		const entry = JSON.parse(stdoutLines[0]);
		expect(entry.method).toBe("POST");
		expect(entry.path).toBe("/v1/chat");
		expect(entry.route).toBe("POST /v1/chat/completions");
		expect(entry.price).toBe("$0.01");
		expect(entry.duration_ms).toBe(245);
		expect(entry.status).toBe(200);
	});

	test("payment log includes payer, tx_hash, amount, asset", () => {
		log.info("payment_settled", {
			payer: "0xabc",
			tx_hash: "0xdef",
			amount: "10000",
			asset: "USDC",
		});
		const entry = JSON.parse(stdoutLines[0]);
		expect(entry.msg).toBe("payment_settled");
		expect(entry.payer).toBe("0xabc");
		expect(entry.tx_hash).toBe("0xdef");
		expect(entry.amount).toBe("10000");
		expect(entry.asset).toBe("USDC");
	});

	test("error level writes to stderr", () => {
		log.error("something_failed", { error: "boom" });
		expect(stdoutLines).toHaveLength(0);
		expect(stderrLines).toHaveLength(1);
		const entry = JSON.parse(stderrLines[0]);
		expect(entry.level).toBe("error");
		expect(entry.msg).toBe("something_failed");
	});

	test("each log line is a single JSON object", () => {
		log.info("first");
		log.info("second");
		expect(stdoutLines).toHaveLength(2);
		expect(() => JSON.parse(stdoutLines[0])).not.toThrow();
		expect(() => JSON.parse(stdoutLines[1])).not.toThrow();
	});
});

describe("LOG_LEVEL filtering", () => {
	test("filters debug when level is info", () => {
		process.env.LOG_LEVEL = "info";
		log.debug("hidden");
		log.info("visible");
		expect(stdoutLines).toHaveLength(1);
		expect(JSON.parse(stdoutLines[0]).msg).toBe("visible");
	});

	test("shows debug when level is debug", () => {
		process.env.LOG_LEVEL = "debug";
		log.debug("visible");
		expect(stdoutLines).toHaveLength(1);
		expect(JSON.parse(stdoutLines[0]).msg).toBe("visible");
	});

	test("filters info and debug when level is warn", () => {
		process.env.LOG_LEVEL = "warn";
		log.debug("hidden");
		log.info("hidden");
		log.warn("visible");
		expect(stdoutLines).toHaveLength(1);
		expect(JSON.parse(stdoutLines[0]).msg).toBe("visible");
		expect(stderrLines).toHaveLength(0);
	});

	test("warn writes to stdout", () => {
		process.env.LOG_LEVEL = "warn";
		log.warn("warning");
		expect(stdoutLines).toHaveLength(1);
		expect(JSON.parse(stdoutLines[0]).level).toBe("warn");
	});

	test("only error when level is error", () => {
		process.env.LOG_LEVEL = "error";
		log.debug("hidden");
		log.info("hidden");
		log.warn("hidden");
		log.error("visible");
		expect(stdoutLines).toHaveLength(0);
		expect(stderrLines).toHaveLength(1);
	});

	test("defaults to info when LOG_LEVEL is unset", () => {
		delete process.env.LOG_LEVEL;
		log.debug("hidden");
		log.info("visible");
		expect(stdoutLines).toHaveLength(1);
	});

	test("defaults to info when LOG_LEVEL is invalid", () => {
		process.env.LOG_LEVEL = "banana";
		log.debug("hidden");
		log.info("visible");
		expect(stdoutLines).toHaveLength(1);
	});
});

describe("pretty format", () => {
	test("outputs human-readable format", () => {
		process.env.LOG_FORMAT = "pretty";
		log.info("request", {
			method: "POST",
			path: "/v1/chat",
			status: 200,
			duration_ms: 245,
			price: "$0.01",
		});
		expect(stdoutLines).toHaveLength(1);
		const line = stdoutLines[0];
		// Should contain time, level, message, and formatted request info
		expect(line).toMatch(/^\d{2}:\d{2}:\d{2}/);
		expect(line).toContain("INFO");
		expect(line).toContain("request");
		expect(line).toContain("POST");
		expect(line).toContain("/v1/chat");
		expect(line).toContain("200");
		expect(line).toContain("245ms");
		expect(line).toContain("$0.01");
	});

	test("formats payment_settled nicely", () => {
		process.env.LOG_FORMAT = "pretty";
		log.info("payment_settled", {
			payer: "0xabc",
			tx_hash: "0xdef",
		});
		const line = stdoutLines[0];
		expect(line).toContain("payment_settled");
		expect(line).toContain("payer=0xabc");
		expect(line).toContain("tx=0xdef");
	});

	test("formats generic messages with key=value", () => {
		process.env.LOG_FORMAT = "pretty";
		log.info("custom_event", { foo: "bar", count: 42 });
		const line = stdoutLines[0];
		expect(line).toContain("INFO");
		expect(line).toContain("custom_event");
		expect(line).toContain("foo=bar");
		expect(line).toContain("count=42");
	});

	test("pretty is not valid JSON", () => {
		process.env.LOG_FORMAT = "pretty";
		log.info("test");
		expect(() => JSON.parse(stdoutLines[0])).toThrow();
	});
});

describe("LOG_FORMAT defaults", () => {
	test("defaults to json when LOG_FORMAT is unset", () => {
		delete process.env.LOG_FORMAT;
		log.info("test");
		expect(() => JSON.parse(stdoutLines[0])).not.toThrow();
	});

	test("defaults to json when LOG_FORMAT is invalid", () => {
		process.env.LOG_FORMAT = "xml";
		log.info("test");
		expect(() => JSON.parse(stdoutLines[0])).not.toThrow();
	});
});
