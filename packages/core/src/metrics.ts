import { monitorEventLoopDelay } from "node:perf_hooks";
import type pg from "pg";

/** A small Prometheus text registry: enough for the dashboards in deploy/observability without a client dependency. Metric names and labels never carry message or tool content. */
type Labels = Record<string, string>;
type GaugeRead = () => Promise<Map<string, number> | number> | Map<string, number> | number;
const key = (labels: Labels) => Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",");

const BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
	readonly #counters = new Map<string, { help: string; values: Map<string, number> }>();
	readonly #gauges = new Map<string, { help: string; read: GaugeRead }>();
	readonly #histograms = new Map<string, { help: string; series: Map<string, { counts: number[]; sum: number; n: number }> }>();

	inc(name: string, labels: Labels = {}, by = 1, help = name): void {
		const c = this.#counters.get(name) ?? this.#counters.set(name, { help, values: new Map() }).get(name)!;
		const k = key(labels);
		c.values.set(k, (c.values.get(k) ?? 0) + by);
	}

	observe(name: string, seconds: number, labels: Labels = {}, help = name): void {
		const h = this.#histograms.get(name) ?? this.#histograms.set(name, { help, series: new Map() }).get(name)!;
		const k = key(labels);
		const s = h.series.get(k) ?? h.series.set(k, { counts: new Array(BUCKETS.length + 1).fill(0), sum: 0, n: 0 }).get(k)!;
		s.sum += seconds;
		s.n++;
		const i = BUCKETS.findIndex((b) => seconds <= b);
		s.counts[i === -1 ? BUCKETS.length : i]!++;
	}

	gauge(name: string, help: string, read: GaugeRead): void {
		this.#gauges.set(name, { help, read });
	}

	/** Times an async function into a histogram. */
	async time<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
		const start = performance.now();
		try {
			return await fn();
		} finally {
			this.observe(name, (performance.now() - start) / 1000, labels);
		}
	}

	/** p-quantile of a histogram's series (upper bucket bound), for load reports and tests. */
	quantile(name: string, q: number, labels: Labels = {}): number | undefined {
		const s = this.#histograms.get(name)?.series.get(key(labels));
		if (!s || s.n === 0) return undefined;
		let seen = 0;
		for (let i = 0; i < s.counts.length; i++) {
			seen += s.counts[i]!;
			if (seen >= q * s.n) return BUCKETS[i] ?? Number.POSITIVE_INFINITY;
		}
		return Number.POSITIVE_INFINITY;
	}

	async render(): Promise<string> {
		const out: string[] = [];
		for (const [name, c] of this.#counters) {
			out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
			for (const [k, v] of c.values) out.push(`${name}${k ? `{${k}}` : ""} ${v}`);
		}
		for (const [name, h] of this.#histograms) {
			out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
			for (const [k, s] of h.series) {
				let cumulative = 0;
				BUCKETS.forEach((b, i) => {
					cumulative += s.counts[i]!;
					out.push(`${name}_bucket{${[k, `le="${b}"`].filter(Boolean).join(",")}} ${cumulative}`);
				});
				out.push(`${name}_bucket{${[k, 'le="+Inf"'].filter(Boolean).join(",")}} ${s.n}`, `${name}_sum${k ? `{${k}}` : ""} ${s.sum}`, `${name}_count${k ? `{${k}}` : ""} ${s.n}`);
			}
		}
		for (const [name, g] of this.#gauges) {
			out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
			try {
				const value = await g.read();
				if (typeof value === "number") out.push(`${name} ${value}`);
				else for (const [k, v] of value) out.push(`${name}${k ? `{${k}}` : ""} ${v}`);
			} catch {
				// A gauge that cannot be read is absent, not an error for the scrape.
			}
		}
		return `${out.join("\n")}\n`;
	}
}

/** Event-loop delay and pool state, the first two things that explain a slow foreground path. */
export function processGauges(metrics: Metrics, pools: Record<string, pg.Pool>): () => void {
	const loop = monitorEventLoopDelay({ resolution: 10 });
	loop.enable();
	metrics.gauge("pim_event_loop_delay_p99_seconds", "Event loop delay, 99th percentile since the last scrape", () => {
		const v = loop.percentile(99) / 1e9;
		loop.reset();
		return v;
	});
	metrics.gauge("pim_pool_connections", "Database pool connections by state", () => new Map(Object.entries(pools).flatMap(([name, p]) => [[`pool="${name}",state="total"`, p.totalCount], [`pool="${name}",state="idle"`, p.idleCount], [`pool="${name}",state="waiting"`, p.waitingCount]] as [string, number][])));
	return () => loop.disable();
}

/** Gauges that read PostgreSQL: queue age, ownership, projection lag, unresolved operations. Cheap, bounded queries. */
export function databaseGauges(metrics: Metrics, steward: pg.Pool): void {
	const scalar = (sql: string) => async () => Number((await steward.query(sql)).rows[0]?.n ?? 0);
	metrics.gauge("pim_signal_oldest_age_seconds", "Age of the oldest undelivered signal (queue age)", scalar("SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0) AS n FROM app.signals WHERE delivered_at IS NULL"));
	metrics.gauge("pim_signals_pending", "Undelivered signals", scalar("SELECT count(*) AS n FROM app.signals WHERE delivered_at IS NULL"));
	metrics.gauge("pim_partitions_owned", "Families with a live lease", scalar("SELECT count(*) AS n FROM rt.partitions WHERE lease_until > now()"));
	metrics.gauge("pim_activation_due", "Families that need an owner now", scalar("SELECT count(*) AS n FROM app.activation WHERE state = 'needs_owner' AND due_at <= now()"));
	metrics.gauge("pim_projection_lag_commits", "Commits the projector has not yet read", scalar("SELECT count(*) AS n FROM rt.commits k LEFT JOIN app.projector_cursors c ON c.partition_id = k.partition_id WHERE k.seq > COALESCE(c.last_seq, 0)"));
	metrics.gauge("pim_external_ops_unresolved", "External operations needing reconciliation", scalar("SELECT count(*) AS n FROM app.external_ops WHERE state IN ('reconciliation_needed', 'cancel_uncertain')"));
}
