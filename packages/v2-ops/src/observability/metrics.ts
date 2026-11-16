import { redactText } from "./redact.ts";

export type Labels = Readonly<Record<string, string>>;

/** Label names a metric may never carry: they would put people, content or credentials into a time series. */
const FORBIDDEN_LABELS = /^(tenant|tenant_id|user|user_id|owner|owner_id|username|email|prompt|message|content|body|token|key|secret|cookie|authorization|conversation|conversation_id|chat|chat_id|path_raw|url)$/i;
const MAX_SERIES = 2000;

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const cleanValue = (v: string) => redactText(v).slice(0, 80);

function seriesKey(names: readonly string[], labels: Labels): string {
	return names.map((n) => `${n}="${escapeLabel(cleanValue(labels[n] ?? ""))}"`).join(",");
}

abstract class Metric {
	constructor(readonly name: string, readonly help: string, readonly type: "counter" | "gauge" | "histogram", readonly labelNames: readonly string[]) {
		if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(name)) throw new Error(`Bad metric name ${name}`);
		for (const l of labelNames) if (FORBIDDEN_LABELS.test(l) || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(l)) throw new Error(`Metric ${name} may not have a ${l} label`);
	}
	abstract lines(): string[];
	protected header() {
		return [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${this.type}`];
	}
}

export class Counter extends Metric {
	readonly #values = new Map<string, number>();
	constructor(name: string, help: string, labelNames: readonly string[] = []) {
		super(name, help, "counter", labelNames);
	}
	inc(labels: Labels = {}, by = 1) {
		if (by < 0) throw new Error("A counter only goes up");
		const key = seriesKey(this.labelNames, labels);
		if (!this.#values.has(key) && this.#values.size >= MAX_SERIES) return;
		this.#values.set(key, (this.#values.get(key) ?? 0) + by);
	}
	get(labels: Labels = {}) {
		return this.#values.get(seriesKey(this.labelNames, labels)) ?? 0;
	}
	lines() {
		return [...this.header(), ...[...this.#values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ""} ${v}`)];
	}
}

export class Gauge extends Metric {
	readonly #values = new Map<string, number>();
	readonly #collectors: (() => void)[] = [];
	constructor(name: string, help: string, labelNames: readonly string[] = []) {
		super(name, help, "gauge", labelNames);
	}
	set(value: number, labels: Labels = {}) {
		const key = seriesKey(this.labelNames, labels);
		if (!this.#values.has(key) && this.#values.size >= MAX_SERIES) return;
		this.#values.set(key, value);
	}
	/** A function run at every scrape, so the value is read when asked, not when something last changed. */
	collect(fn: () => void) {
		this.#collectors.push(fn);
	}
	get(labels: Labels = {}) {
		return this.#values.get(seriesKey(this.labelNames, labels));
	}
	lines() {
		for (const fn of this.#collectors) fn();
		return [...this.header(), ...[...this.#values].map(([k, v]) => `${this.name}${k ? `{${k}}` : ""} ${v}`)];
	}
}

/** Latency buckets from 1 ms to 60 s: fine near a UI's budget (250 ms) and wide enough for a model call. */
export const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export class Histogram extends Metric {
	readonly #series = new Map<string, { counts: number[]; sum: number; count: number }>();
	readonly buckets: readonly number[];
	constructor(name: string, help: string, labelNames: readonly string[] = [], buckets: readonly number[] = LATENCY_BUCKETS) {
		super(name, help, "histogram", labelNames);
		this.buckets = [...buckets].sort((a, b) => a - b);
	}
	observe(value: number, labels: Labels = {}) {
		const key = seriesKey(this.labelNames, labels);
		let series = this.#series.get(key);
		if (!series) {
			if (this.#series.size >= MAX_SERIES) return;
			series = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
			this.#series.set(key, series);
		}
		series.sum += value;
		series.count++;
		for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]!) series.counts[i]!++;
	}
	/** Time a function. */
	async time<T>(labels: Labels, work: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await work();
		} finally {
			this.observe((performance.now() - start) / 1000, labels);
		}
	}
	count(labels: Labels = {}) {
		return this.#series.get(seriesKey(this.labelNames, labels))?.count ?? 0;
	}
	lines() {
		const out = this.header();
		for (const [key, s] of this.#series) {
			const sep = key ? `${key},` : "";
			this.buckets.forEach((b, i) => out.push(`${this.name}_bucket{${sep}le="${b}"} ${s.counts[i]}`));
			out.push(`${this.name}_bucket{${sep}le="+Inf"} ${s.count}`, `${this.name}_sum${key ? `{${key}}` : ""} ${s.sum}`, `${this.name}_count${key ? `{${key}}` : ""} ${s.count}`);
		}
		return out;
	}
}

export class Registry {
	readonly #metrics = new Map<string, Metric>();
	#add<T extends Metric>(metric: T): T {
		if (this.#metrics.has(metric.name)) throw new Error(`Metric ${metric.name} is already registered`);
		this.#metrics.set(metric.name, metric);
		return metric;
	}
	counter(name: string, help: string, labels: readonly string[] = []) {
		return this.#add(new Counter(name, help, labels));
	}
	gauge(name: string, help: string, labels: readonly string[] = []) {
		return this.#add(new Gauge(name, help, labels));
	}
	histogram(name: string, help: string, labels: readonly string[] = [], buckets?: readonly number[]) {
		return this.#add(new Histogram(name, help, labels, buckets));
	}
	names() {
		return [...this.#metrics.keys()];
	}
	/** Prometheus text exposition format 0.0.4. */
	render(): string {
		return `${[...this.#metrics.values()].flatMap((m) => m.lines()).join("\n")}\n`;
	}
}
