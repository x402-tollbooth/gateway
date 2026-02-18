// ── Log Levels ───────────────────────────────────────────────────────────────

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

// ── Configuration ────────────────────────────────────────────────────────────

function getLevel(): LogLevel {
	const env = process.env.LOG_LEVEL?.toLowerCase();
	if (env && env in LEVELS) return env as LogLevel;
	return "info";
}

function getFormat(): "json" | "pretty" {
	const env = process.env.LOG_FORMAT?.toLowerCase();
	if (env === "pretty") return "pretty";
	return "json";
}

// ── Pretty Formatting ────────────────────────────────────────────────────────

const LEVEL_LABELS: Record<LogLevel, string> = {
	debug: "DEBUG",
	info: "INFO ",
	warn: "WARN ",
	error: "ERROR",
};

function formatTime(ts: string): string {
	return ts.slice(11, 19);
}

function formatPretty(
	level: LogLevel,
	msg: string,
	fields: Record<string, unknown>,
): string {
	const time = formatTime(fields.timestamp as string);
	const label = LEVEL_LABELS[level];

	// Custom formatting for well-known messages
	if (msg === "request") {
		const arrow = fields.status ? ` → ${fields.status}` : "";
		const dur = fields.duration_ms != null ? ` (${fields.duration_ms}ms` : "";
		const price = fields.price ? `, ${fields.price}` : "";
		const suffix = dur ? `${dur}${price})` : "";
		return `${time} ${label} ${msg} ${fields.method} ${fields.path}${arrow}${suffix}`;
	}

	if (msg === "payment_settled") {
		return `${time} ${label} ${msg} payer=${fields.payer} tx=${fields.tx_hash}`;
	}

	if (msg === "started") {
		const disc = fields.discovery ? ` (discovery: ${fields.discovery})` : "";
		return `${time} ${label} ⛩️  tollbooth running on ${fields.url}${disc}`;
	}

	// Generic: append key=value pairs
	const extras = Object.entries(fields)
		.filter(([k]) => k !== "timestamp" && k !== "level" && k !== "msg")
		.map(([k, v]) => `${k}=${v}`)
		.join(" ");

	return `${time} ${label} ${msg}${extras ? ` ${extras}` : ""}`;
}

// ── Logger ───────────────────────────────────────────────────────────────────

function emit(
	level: LogLevel,
	msg: string,
	fields?: Record<string, unknown>,
): void {
	if (LEVELS[level] < LEVELS[getLevel()]) return;

	const entry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
		msg,
		...fields,
	};

	const format = getFormat();
	const line =
		format === "pretty"
			? formatPretty(level, msg, entry)
			: JSON.stringify(entry);

	if (level === "error") {
		process.stderr.write(`${line}\n`);
	} else {
		process.stdout.write(`${line}\n`);
	}
}

export const log = {
	debug(msg: string, fields?: Record<string, unknown>) {
		emit("debug", msg, fields);
	},
	info(msg: string, fields?: Record<string, unknown>) {
		emit("info", msg, fields);
	},
	warn(msg: string, fields?: Record<string, unknown>) {
		emit("warn", msg, fields);
	},
	error(msg: string, fields?: Record<string, unknown>) {
		emit("error", msg, fields);
	},
};
