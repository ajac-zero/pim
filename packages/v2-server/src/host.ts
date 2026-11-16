/**
 * One HTTP server per process, whatever roles it runs: `/healthz`, `/readyz` and `POST /drain` answer before anything else (they need no
 * credential, so an orchestrator's probe works), then the ingress secret the proxy sets is required of everything that remains, and the
 * roles' handlers and WebSocket upgrades get what is left. Metrics are on their own port, as `deploy/` expects.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { Registry } from "@pim/v2-ops/observability/metrics";
import { serveMetrics } from "@pim/v2-ops/observability/signals";

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

export type Host = {
	server: Server;
	registry: Registry;
	port: number;
	metricsPort: number;
	/** A role adds what it answers to; the first handler to return true wins. */
	handle(handler: HttpHandler): void;
	upgrade(handler: UpgradeHandler): void;
	/** A role reports whether it can serve; `/readyz` is 200 only when every one does. */
	readiness(check: () => boolean | Promise<boolean>): void;
	onDrain(fn: () => Promise<void>): void;
	close(): Promise<void>;
};

const text = (res: ServerResponse, status: number, body: string) => res.writeHead(status, { "content-type": "text/plain" }).end(body);

export async function createHost(options: { port: number; metricsPort: number; ingressSecret?: string | undefined; metricsHost?: string }): Promise<Host> {
	const handlers: HttpHandler[] = [];
	const upgraders: UpgradeHandler[] = [];
	const checks: (() => boolean | Promise<boolean>)[] = [];
	const drains: (() => Promise<void>)[] = [];
	const registry = new Registry();
	let draining: Promise<void> | undefined;
	const trusted = (req: IncomingMessage) => !options.ingressSecret || req.headers["x-pim-ingress-secret"] === options.ingressSecret;

	const server = createServer(async (req, res) => {
		try {
			const path = (req.url ?? "/").split("?")[0];
			if (req.method === "GET" && path === "/healthz") return void text(res, 200, "ok");
			if (req.method === "GET" && path === "/readyz") {
				const ready = (await Promise.all(checks.map((c) => c()))).every(Boolean) && draining === undefined;
				return void text(res, ready ? 200 : 503, ready ? "ready" : "not ready");
			}
			// A drain is an orchestrator's request from inside the cluster (a preStop hook): it carries no ingress secret, which the proxy would never forward for it.
			if (req.method === "POST" && path === "/drain") {
				draining ??= Promise.all(drains.map((d) => d())).then(() => undefined);
				await draining;
				return void text(res, 202, "drained");
			}
			if (!trusted(req)) return void text(res, 403, "forbidden");
			for (const h of handlers) if (await h(req, res)) return;
			text(res, 404, "not found");
		} catch (error) {
			console.error("http error", error);
			if (!res.headersSent) text(res, 500, "error");
			else res.end();
		}
	});
	server.on("upgrade", (req, socket, head) => {
		if (!trusted(req)) return void socket.destroy();
		for (const u of upgraders) if (u(req, socket, head)) return;
		socket.destroy();
	});
	await new Promise<void>((resolve) => server.listen(options.port, resolve));
	const metrics = await serveMetrics(registry, options.metricsPort, options.metricsHost ?? "0.0.0.0");
	return {
		server,
		registry,
		port: (server.address() as AddressInfo).port,
		metricsPort: (metrics.address() as AddressInfo).port,
		handle: (h) => void handlers.push(h),
		upgrade: (u) => void upgraders.push(u),
		readiness: (c) => void checks.push(c),
		onDrain: (d) => void drains.push(d),
		async close() {
			await Promise.all([new Promise<void>((r) => server.close(() => r())), new Promise<void>((r) => metrics.close(() => r()))]);
		},
	};
}
