import { type IntervalHistogram, monitorEventLoopDelay } from "node:perf_hooks";
import { createServer, type Server } from "node:http";
import type { Pool } from "pg";
import { Registry } from "./metrics.ts";

/** Every signal Pim's services report, by the name the dashboards and alert rules use. Nothing here is labelled by a person, a chat or any content. */
export function createPimMetrics(registry = new Registry()) {
	const m = {
		registry,
		// HTTP and the Gate.
		httpDuration: registry.histogram("pim_http_request_duration_seconds", "HTTP request latency by service (gate, live, canvas, relay), route template, method and status class.", ["service", "route", "method", "status_class"]),
		// Node.
		eventLoopDelay: registry.gauge("pim_nodejs_event_loop_delay_seconds", "Event loop delay from monitorEventLoopDelay, by quantile.", ["service", "quantile"]),
		// PostgreSQL.
		pgPoolWait: registry.histogram("pim_pg_pool_wait_seconds", "Time a caller waited for a pooled connection.", ["service", "pool"]),
		pgQuery: registry.histogram("pim_pg_query_duration_seconds", "Query duration by statement kind.", ["service", "op"]),
		pgCommitBatch: registry.histogram("pim_pg_commit_batch_duration_seconds", "Duration of one group of commits written in one transaction.", ["service", "partition_kind"]),
		pgConnections: registry.gauge("pim_pg_pool_connections", "Pool connections by state (total, idle, waiting).", ["service", "pool", "state"]),
		// Queues and ownership.
		inboxAge: registry.gauge("pim_inbox_oldest_age_seconds", "Age of the oldest unhandled item in an inbox.", ["service", "queue"]),
		dueWorkAge: registry.gauge("pim_due_work_oldest_age_seconds", "How long the oldest due item has been overdue.", ["service", "kind"]),
		ownershipTransfers: registry.counter("pim_partition_ownership_transfers_total", "Partition leases that moved to another Runner, by reason (expired, drained, stolen).", ["service", "reason"]),
		fencingRejects: registry.counter("pim_fencing_rejects_total", "Writes rejected because their lease epoch was stale.", ["service", "kind"]),
		leasesHeld: registry.gauge("pim_partition_leases_held", "Partition leases this Runner holds.", ["service"]),
		// Projections and Live.
		projectionLag: registry.gauge("pim_projection_lag_seconds", "How far a projection is behind the commits it reads.", ["service", "projection"]),
		liveReplayLag: registry.histogram("pim_live_cursor_replay_lag_seconds", "How far behind the commit stream a reconnecting client's cursor was.", ["service"]),
		websockets: registry.gauge("pim_live_websockets_active", "Open WebSocket connections.", ["service"]),
		slowCoalesced: registry.counter("pim_live_slow_client_coalesced_total", "Updates merged for a client that could not keep up.", ["service"]),
		slowOverflow: registry.counter("pim_live_slow_client_overflow_total", "Clients disconnected because their send buffer overflowed.", ["service"]),
		// Models and spend.
		modelDuration: registry.histogram("pim_model_request_duration_seconds", "Model provider request duration.", ["provider"]),
		modelTtft: registry.histogram("pim_model_time_to_first_token_seconds", "Time from request to the first streamed token.", ["provider"]),
		modelErrors: registry.counter("pim_model_errors_total", "Model provider errors by provider and class (timeout_524, rate_limited, server_error, other).", ["provider", "class"]),
		tokens: registry.counter("pim_model_tokens_total", "Tokens by provider and direction (input, output, cache_read, cache_write).", ["provider", "direction"]),
		spend: registry.counter("pim_spend_usd_total", "Spend in US dollars by kind (model, compute).", ["provider", "kind"]),
	};
	return m;
}
export type PimMetrics = ReturnType<typeof createPimMetrics>;

/** Samples the event loop with `monitorEventLoopDelay` and publishes p50, p99 and max at every scrape. Returns a stop function. */
export function monitorEventLoop(metrics: PimMetrics, service: string, resolutionMs = 20): () => void {
	const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: resolutionMs });
	histogram.enable();
	metrics.eventLoopDelay.collect(() => {
		for (const [quantile, value] of [["0.5", histogram.percentile(50)], ["0.99", histogram.percentile(99)], ["max", histogram.max]] as const) metrics.eventLoopDelay.set(Number.isNaN(value) ? 0 : value / 1e9, { service, quantile });
		histogram.reset();
	});
	return () => histogram.disable();
}

const statementKind = (sql: string) => /^\s*(\w+)/.exec(sql)?.[1]?.toLowerCase() ?? "other";

/**
 * Wraps a pg Pool: connection wait time, query duration by statement kind, and pool gauges at every scrape. The SQL text and parameters are never
 * recorded, only the statement's first keyword.
 */
export function instrumentPool(pool: Pool, metrics: PimMetrics, service: string, name = "main"): Pool {
	const connect = pool.connect.bind(pool) as (...args: unknown[]) => Promise<unknown>;
	(pool as unknown as { connect: typeof connect }).connect = async (...args: unknown[]) => {
		const start = performance.now();
		try {
			return await connect(...args);
		} finally {
			metrics.pgPoolWait.observe((performance.now() - start) / 1000, { service, pool: name });
		}
	};
	const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
	(pool as unknown as { query: typeof query }).query = async (...args: unknown[]) => {
		const first = args[0];
		const op = statementKind(typeof first === "string" ? first : ((first as { text?: string })?.text ?? ""));
		const start = performance.now();
		try {
			return await query(...args);
		} finally {
			metrics.pgQuery.observe((performance.now() - start) / 1000, { service, op });
		}
	};
	metrics.pgConnections.collect(() => {
		metrics.pgConnections.set(pool.totalCount, { service, pool: name, state: "total" });
		metrics.pgConnections.set(pool.idleCount, { service, pool: name, state: "idle" });
		metrics.pgConnections.set(pool.waitingCount, { service, pool: name, state: "waiting" });
	});
	return pool;
}

/** `/metrics` and `/healthz` on a port. Binds loopback unless told otherwise: scraping is for the cluster, not the internet. */
export function serveMetrics(registry: Registry, port: number, host = "127.0.0.1"): Promise<Server> {
	const server = createServer((req, res) => {
		if (req.url === "/metrics") {
			res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" }).end(registry.render());
		} else if (req.url === "/healthz") res.writeHead(200).end("ok");
		else res.writeHead(404).end();
	});
	return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
