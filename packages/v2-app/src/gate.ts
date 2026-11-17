import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { App } from "./app.ts";
import { httpStatus, NotFoundError } from "./errors.ts";
import { makeCtx, type Reply, type Route } from "./http.ts";
import { authRoutes } from "./routes/auth.ts";
import { hostedRoutes, serveAppOrigin } from "./routes/hosted.ts";
import { coreRoutes } from "./routes/core.ts";
import { domainRoutes } from "./routes/domain.ts";

/**
 * The stateless HTTP service. Every handler is a bounded PostgreSQL transaction: nothing here waits on a model, a Harness, a computer or
 * NATS. Chat commands are admitted into the inbox and answered at once. Errors are the typed ones from errors.ts and the contracts'
 * authorization errors; anything else is a 500 with no detail.
 */
export type GateOptions = {
	/** Where the app is served from, such as `https://pim.example.com`. Its scheme decides the cookie (`__Host-pim-session` on https) and its host the passkeys' relying party. */
	publicUrl?: string;
	/** Where apps with a backend get an origin of their own, `https://<label>.<this host>`. Unset, they are reached only at `/hosted/<owner>/<id>/<token>/`. */
	appsOrigin?: string;
	/** Extra routes, tried before the built-in ones: a compatibility route may answer a path the application also does, in another shape. */
	routes?: Route[];
};

export const builtInRoutes: Route[] = [...hostedRoutes, ...domainRoutes, ...coreRoutes, ...authRoutes];

export function createGate(app: App, options: GateOptions = {}): Server {
	const routes = [...(options.routes ?? []), ...builtInRoutes];
	return createServer(async (req, res) => {
		try {
			await handle(app, routes, options, req, res);
		} catch (error) {
			const known = httpStatus(error);
			if (!known) console.error("gate error", error);
			const oauth = (error as { oauth?: string }).oauth;
			send(res, { status: known?.status ?? 500, body: oauth ? { error: oauth, error_description: (error as Error).message } : { error: known?.code ?? "internal", message: known ? (error as Error).message : "Something went wrong" } });
		}
	});
}

export const originOf = (req: IncomingMessage, options: GateOptions) => (options.publicUrl ?? `http://${req.headers.host ?? "localhost"}`).replace(/\/$/, "");

async function handle(app: App, routes: Route[], options: GateOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
	const origin = originOf(req, options);
	const url = new URL(req.url ?? "/", origin);
	const method = req.method ?? "GET";
	// An app with a backend at its own address, `<label>.<apps origin>`, is answered before anything of Pim's.
	const appsHost = options.appsOrigin ? new URL(options.appsOrigin).hostname : null;
	const host = (req.headers.host ?? "").split(":")[0] ?? "";
	if (appsHost && host.endsWith(`.${appsHost}`)) return send(res, await serveAppOrigin(app, req, url, host.slice(0, -(appsHost.length + 1)), { origin, ...(options.appsOrigin ? { appsOrigin: options.appsOrigin } : {}) }));
	for (const r of routes) {
		if (r.method !== method) continue;
		const m = r.pattern.exec(url.pathname);
		if (!m) continue;
		return send(res, await r.run(makeCtx(app, req, url, m.slice(1).map(decodeURIComponent), { origin, appsOrigin: options.appsOrigin })));
	}
	throw new NotFoundError();
}

export function send(res: ServerResponse, reply: Reply): void {
	const raw = reply.raw !== undefined ? Buffer.from(reply.raw) : reply.status === 302 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reply.body ?? {}));
	res.writeHead(reply.status, { ...(reply.raw === undefined && reply.status !== 302 ? { "content-type": "application/json" } : {}), "cache-control": "no-store", ...reply.headers, "content-length": String(raw.length) });
	res.end(raw);
}
