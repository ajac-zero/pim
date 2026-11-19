import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { App } from "./app.ts";
import { httpStatus, NotFoundError } from "./errors.ts";
import { type Ctx, makeCtx, type Reply, type Route } from "./http.ts";
import { authRoutes } from "./routes/auth.ts";
import { hostedRoutes, serveAppOrigin } from "./routes/hosted.ts";
import { coreRoutes } from "./routes/core.ts";
import { chatgptRoutes } from "./routes/chatgpt.ts";
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
	/** Extra routes, tried after the built-in ones. */
	routes?: Route[];
	/** Routes tried before the built-in ones: where the web app needs a path answered in the shape it was built for (the v1 API), they win. */
	first?: Route[];
	/** Run on every request that matches a route, before it: an answer stops the request there (limits, and what a guest's account may reach). */
	before?: (ctx: Ctx, route: Route) => Promise<Reply | undefined>;
};

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS", "access-control-allow-headers": "Authorization, Content-Type, If-Match, Idempotency-Key, Mcp-Protocol-Version, Mcp-Session-Id", "access-control-expose-headers": "ETag", "access-control-max-age": "86400" };

export const builtInRoutes: Route[] = [...hostedRoutes, ...chatgptRoutes, ...domainRoutes, ...coreRoutes, ...authRoutes];

export function createGate(app: App, options: GateOptions = {}): Server {
	const routes = [...(options.first ?? []), ...builtInRoutes, ...(options.routes ?? [])];
	return createServer(async (req, res) => {
		try {
			// API clients in a browser on another site: tokens work there, cookies do not (SameSite=Strict, and the Origin check of the routes that change something). The MCP
			// endpoint and its sign-in answer them too, for an MCP client that runs in a page.
			if (/^\/(api|mcp|oauth|\.well-known)(\/|\?|$)/.test(req.url ?? "")) {
				for (const [name, value] of Object.entries(CORS)) res.setHeader(name, value);
				if (req.method === "OPTIONS") return void res.writeHead(204).end();
			}
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
		const ctx = makeCtx(app, req, url, m.slice(1).map(decodeURIComponent), { origin, appsOrigin: options.appsOrigin });
		return send(res, (await options.before?.(ctx, r)) ?? (await r.run(ctx)));
	}
	// A path some route answers, with a method none does: 405 and the methods it takes, rather than a 404 that says the path is not there.
	const known = routes.filter((r) => r.pattern.test(url.pathname));
	const allowed = [...new Set(known.map((r) => r.method))];
	if (allowed.length > 0) {
		// What the path's limits and rules say comes first (a turned-off app is not there at all, whatever the method).
		const first = known[0]!;
		const refused = await options.before?.(makeCtx(app, req, url, first.pattern.exec(url.pathname)!.slice(1).map(decodeURIComponent), { origin, appsOrigin: options.appsOrigin }), first);
		if (refused) return send(res, refused);
		return send(res, { status: 405, headers: { allow: allowed.join(", ") }, body: { error: "method_not_allowed", message: `${url.pathname} takes ${allowed.join(", ")}` } });
	}
	throw new NotFoundError();
}

export function send(res: ServerResponse, reply: Reply): void {
	if (reply.stream) {
		res.writeHead(reply.status, { "cache-control": "no-store", ...reply.headers });
		const reader = reply.stream.getReader();
		// A client that goes away ends the stream.
		res.on("close", () => void reader.cancel().catch(() => {}));
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					if (!res.write(value)) await new Promise((resolve) => res.once("drain", resolve).once("close", resolve));
				}
			} catch {
				// The stream failed or the client left: nothing more to say.
			} finally {
				res.end();
			}
		})();
		return;
	}
	const raw = reply.raw !== undefined ? Buffer.from(reply.raw) : reply.status === 302 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(reply.body ?? {}));
	res.writeHead(reply.status, { ...(reply.raw === undefined && reply.status !== 302 ? { "content-type": "application/json" } : {}), "cache-control": "no-store", ...reply.headers, "content-length": String(raw.length) });
	res.end(raw);
}
