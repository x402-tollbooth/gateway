export const PROMETHEUS_CONTENT_TYPE =
	"text/plain; version=0.0.4; charset=utf-8";

const REQUEST_DURATION_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
const SETTLEMENT_DURATION_BUCKETS = [
	0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];
const UPSTREAM_DURATION_BUCKETS = [
	0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
];

type Labels = Record<string, string>;

interface MetricSpec {
	name: string;
	help: string;
	type: "counter" | "gauge" | "histogram";
}

function formatHelp(spec: MetricSpec): string {
	return `# HELP ${spec.name} ${spec.help}\n# TYPE ${spec.name} ${spec.type}`;
}

function escapeLabelValue(value: string): string {
	return value
		.replaceAll("\\", "\\\\")
		.replaceAll("\n", "\\n")
		.replaceAll('"', '\\"');
}

function makeLabelKey(labelNames: string[], labels: Labels): string {
	return labelNames
		.map((name) => `${name}=${labels[name] ?? ""}`)
		.join("\u0000");
}

function renderLabelSet(labelNames: string[], labels: Labels): string {
	if (labelNames.length === 0) return "";
	const parts = labelNames.map(
		(name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`,
	);
	return `{${parts.join(",")}}`;
}

class CounterMetric {
	private samples = new Map<string, { labels: Labels; value: number }>();

	constructor(
		private spec: MetricSpec,
		private labelNames: string[],
	) {}

	inc(labels: Labels = {}, by = 1): void {
		const key = makeLabelKey(this.labelNames, labels);
		const sample = this.samples.get(key);
		if (sample) {
			sample.value += by;
			return;
		}
		this.samples.set(key, { labels: { ...labels }, value: by });
	}

	render(): string {
		const lines = [formatHelp(this.spec)];
		for (const key of [...this.samples.keys()].sort()) {
			const sample = this.samples.get(key);
			if (!sample) continue;
			lines.push(
				`${this.spec.name}${renderLabelSet(this.labelNames, sample.labels)} ${sample.value}`,
			);
		}
		return `${lines.join("\n")}\n`;
	}
}

class GaugeMetric {
	private samples = new Map<string, { labels: Labels; value: number }>();

	constructor(
		private spec: MetricSpec,
		private labelNames: string[],
	) {}

	inc(labels: Labels = {}, by = 1): void {
		const key = makeLabelKey(this.labelNames, labels);
		const sample = this.samples.get(key);
		if (sample) {
			sample.value += by;
			return;
		}
		this.samples.set(key, { labels: { ...labels }, value: by });
	}

	dec(labels: Labels = {}, by = 1): void {
		this.inc(labels, -by);
	}

	render(): string {
		const lines = [formatHelp(this.spec)];
		for (const key of [...this.samples.keys()].sort()) {
			const sample = this.samples.get(key);
			if (!sample) continue;
			lines.push(
				`${this.spec.name}${renderLabelSet(this.labelNames, sample.labels)} ${sample.value}`,
			);
		}
		return `${lines.join("\n")}\n`;
	}
}

class HistogramMetric {
	private samples = new Map<
		string,
		{ labels: Labels; count: number; sum: number; buckets: number[] }
	>();

	constructor(
		private spec: MetricSpec,
		private labelNames: string[],
		private bucketBounds: number[],
	) {}

	observe(labels: Labels = {}, value: number): void {
		const key = makeLabelKey(this.labelNames, labels);
		let sample = this.samples.get(key);
		if (!sample) {
			sample = {
				labels: { ...labels },
				count: 0,
				sum: 0,
				buckets: new Array(this.bucketBounds.length + 1).fill(0),
			};
			this.samples.set(key, sample);
		}

		sample.count += 1;
		sample.sum += value;

		for (let i = 0; i < this.bucketBounds.length; i++) {
			if (value <= this.bucketBounds[i]) {
				sample.buckets[i] += 1;
			}
		}
		sample.buckets[this.bucketBounds.length] += 1;
	}

	render(): string {
		const lines = [formatHelp(this.spec)];
		for (const key of [...this.samples.keys()].sort()) {
			const sample = this.samples.get(key);
			if (!sample) continue;

			for (let i = 0; i < this.bucketBounds.length; i++) {
				const labels = {
					...sample.labels,
					le: this.bucketBounds[i].toString(),
				};
				lines.push(
					`${this.spec.name}_bucket${renderLabelSet([...this.labelNames, "le"], labels)} ${sample.buckets[i]}`,
				);
			}

			lines.push(
				`${this.spec.name}_bucket${renderLabelSet([...this.labelNames, "le"], { ...sample.labels, le: "+Inf" })} ${sample.buckets[this.bucketBounds.length]}`,
			);
			lines.push(
				`${this.spec.name}_sum${renderLabelSet(this.labelNames, sample.labels)} ${sample.sum}`,
			);
			lines.push(
				`${this.spec.name}_count${renderLabelSet(this.labelNames, sample.labels)} ${sample.count}`,
			);
		}
		return `${lines.join("\n")}\n`;
	}
}

export type PaymentOutcome = "success" | "rejected" | "missing";
export type SettlementOutcome = "success" | "failure";
export type SettlementStrategyLabel = "facilitator" | "custom";

export class TollboothPrometheusMetrics {
	private readonly requestsTotal = new CounterMetric(
		{
			name: "tollbooth_requests_total",
			help: "Total number of handled requests",
			type: "counter",
		},
		["route", "method", "status"],
	);

	private readonly paymentsTotal = new CounterMetric(
		{
			name: "tollbooth_payments_total",
			help: "Payment outcomes by route",
			type: "counter",
		},
		["route", "outcome"],
	);

	private readonly settlementsTotal = new CounterMetric(
		{
			name: "tollbooth_settlements_total",
			help: "Settlement outcomes by strategy",
			type: "counter",
		},
		["strategy", "outcome"],
	);

	private readonly cacheHitsTotal = new CounterMetric(
		{
			name: "tollbooth_cache_hits_total",
			help: "Verification cache hits by route",
			type: "counter",
		},
		["route"],
	);

	private readonly cacheMissesTotal = new CounterMetric(
		{
			name: "tollbooth_cache_misses_total",
			help: "Verification cache misses by route",
			type: "counter",
		},
		["route"],
	);

	private readonly rateLimitBlocksTotal = new CounterMetric(
		{
			name: "tollbooth_rate_limit_blocks_total",
			help: "Rate limit blocks by route",
			type: "counter",
		},
		["route"],
	);

	private readonly upstreamErrorsTotal = new CounterMetric(
		{
			name: "tollbooth_upstream_errors_total",
			help: "Upstream errors by upstream and status",
			type: "counter",
		},
		["upstream", "status"],
	);

	private readonly requestDurationSeconds = new HistogramMetric(
		{
			name: "tollbooth_request_duration_seconds",
			help: "Request duration in seconds",
			type: "histogram",
		},
		["route", "method"],
		REQUEST_DURATION_BUCKETS,
	);

	private readonly settlementDurationSeconds = new HistogramMetric(
		{
			name: "tollbooth_settlement_duration_seconds",
			help: "Settlement duration in seconds",
			type: "histogram",
		},
		["strategy"],
		SETTLEMENT_DURATION_BUCKETS,
	);

	private readonly upstreamDurationSeconds = new HistogramMetric(
		{
			name: "tollbooth_upstream_duration_seconds",
			help: "Upstream round-trip duration in seconds",
			type: "histogram",
		},
		["upstream"],
		UPSTREAM_DURATION_BUCKETS,
	);

	private readonly activeRequests = new GaugeMetric(
		{
			name: "tollbooth_active_requests",
			help: "Number of in-flight requests",
			type: "gauge",
		},
		[],
	);

	incRequest(route: string, method: string, status: number): void {
		this.requestsTotal.inc({
			route,
			method: method.toUpperCase(),
			status: String(status),
		});
	}

	observeRequestDuration(route: string, method: string, seconds: number): void {
		this.requestDurationSeconds.observe(
			{ route, method: method.toUpperCase() },
			seconds,
		);
	}

	incPayment(route: string, outcome: PaymentOutcome): void {
		this.paymentsTotal.inc({ route, outcome });
	}

	incSettlement(
		strategy: SettlementStrategyLabel,
		outcome: SettlementOutcome,
	): void {
		this.settlementsTotal.inc({ strategy, outcome });
	}

	observeSettlementDuration(
		strategy: SettlementStrategyLabel,
		seconds: number,
	): void {
		this.settlementDurationSeconds.observe({ strategy }, seconds);
	}

	incCacheHit(route: string): void {
		this.cacheHitsTotal.inc({ route });
	}

	incCacheMiss(route: string): void {
		this.cacheMissesTotal.inc({ route });
	}

	incRateLimitBlock(route: string): void {
		this.rateLimitBlocksTotal.inc({ route });
	}

	incUpstreamError(upstream: string, status: number): void {
		this.upstreamErrorsTotal.inc({ upstream, status: String(status) });
	}

	observeUpstreamDuration(upstream: string, seconds: number): void {
		this.upstreamDurationSeconds.observe({ upstream }, seconds);
	}

	incActiveRequests(): void {
		this.activeRequests.inc();
	}

	decActiveRequests(): void {
		this.activeRequests.dec();
	}

	render(): string {
		return [
			this.requestsTotal.render(),
			this.paymentsTotal.render(),
			this.settlementsTotal.render(),
			this.cacheHitsTotal.render(),
			this.cacheMissesTotal.render(),
			this.rateLimitBlocksTotal.render(),
			this.upstreamErrorsTotal.render(),
			this.requestDurationSeconds.render(),
			this.settlementDurationSeconds.render(),
			this.upstreamDurationSeconds.render(),
			this.activeRequests.render(),
		].join("\n");
	}
}
