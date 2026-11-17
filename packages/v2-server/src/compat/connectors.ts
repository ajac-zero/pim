/**
 * The web app's connector screens over `ConnectorService` (`../connector-service.ts`): the directory of connectors, the person's connections (`/api/mcp`), connecting and disconnecting
 * one, where each service sends the browser back after a sign-in (`/mcp/callback/…`), and a native connector's own page and actions (Google Drive's file picker). Ported from v1's
 * `src/space/routes.ts` (`/app-directory`, `/mcp`, `/app-actions`) and `native-apps.ts`.
 */
import { randomBytes } from "node:crypto";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { ok, route, type Route } from "@pim/v2-app/http";
import { publicUrl } from "../agent-tools.ts";
import { ConnectorService } from "../connector-service.ts";
import { type Env } from "../native/native.ts";
import { receiveWatchEvent } from "../watches.ts";
import { drivePage } from "../native/drive.ts";
import { customApps } from "./admin-gallery.ts";

const html = (status: number, body: string, headers: Record<string, string> = {}) => ({ status, raw: body, headers: { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", ...headers } });
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What the person sees in the tab the service sent them back to. */
const resultPage = (result: { name: string } | { error: string }) =>
	html(200, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pim</title><body style="font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1.5rem;color:#222"><h1 style="font-size:1.25rem">${"name" in result ? `${escape(result.name)} is connected` : "It didn't connect"}</h1><p>${"name" in result ? "You can close this tab and go back to Pim: its tools are ready." : escape(result.error)}</p><p><a href="/">Back to Pim</a></p></body></html>`, { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'", "referrer-policy": "no-referrer" });

const transportOf = (env: Env) => ({ fetch, allowPrivate: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", check: publicUrl });

export function connectorScreens(env: Env = process.env): Route[] {
	const service = (app: Parameters<Route["run"]>[0]["app"]) => new ConnectorService(app, env, transportOf(env));
	return [
		// The connectors people can connect.
		route("GET", "/api/app-directory", async ({ app, principal }) => {
			await app.identity.authz.enforce(await principal(), "api:read");
			return ok({ apps: service(app).directory(await customApps(app)) });
		}),
		route("GET", "/api/mcp", async ({ app, principal }) => {
			const p = await principal();
			const s = service(app);
			return ok({ servers: await s.list(p, s.directory(await customApps(app))) });
		}),
		route("POST", "/api/mcp", async ({ app, principal, json, origin }) => {
			const p = await principal();
			const b = await json();
			const s = service(app);
			const directory = s.directory(await customApps(app));
			const chosen = typeof b.app === "string" ? directory.find((d) => d.ref === b.app) : undefined;
			let result;
			if (chosen) result = await s.connect(p, origin, { ref: chosen.ref, name: chosen.name, url: chosen.url }, directory);
			else {
				const url = typeof b.url === "string" ? b.url : typeof b.app === "string" && /^https?:\/\//.test(b.app) ? b.app : "";
				if (!url) throw new BadRequestError(typeof b.app === "string" ? (s.notOffered(b.app) ?? "app must be the id of a connector this Pim offers") : "Give the connector's id (app), or a server's address (url).");
				result = await s.connect(p, origin, { url, ...(typeof b.name === "string" && b.name.trim() ? { name: b.name.trim() } : {}), ...(typeof b.credential === "string" && b.credential ? { credential: b.credential } : {}) });
			}
			if (typeof b.approval === "string" && chosen) await s.setApproval(p, result.id, b.approval);
			return ok(result, 201);
		}),
		route("PUT", "/api/mcp/:id", async ({ app, principal, params, json }) => {
			const p = await principal();
			const s = service(app);
			await s.setApproval(p, params[0]!, String((await json()).approval));
			const found = (await s.list(p, s.directory(await customApps(app)))).find((c) => c.id === params[0]);
			if (!found) throw new NotFoundError(`No connector ${params[0]}`);
			return ok(found);
		}),
		route("DELETE", "/api/mcp/:id", async ({ app, principal, params }) => (await service(app).disconnect(await principal(), params[0]!), ok({ deleted: true }))),
		// Skills and events a connector offers beyond tools are not carried yet (docs/architecture/v2-connectors.md).
		route("GET", "/api/mcp/:id/skills", async ({ app, principal }) => (await app.identity.authz.enforce(await principal(), "api:read"), ok({ skills: [] }))),
		route("GET", "/api/mcp/:id/events", async ({ app, principal }) => (await app.identity.authz.enforce(await principal(), "api:read"), ok({ events: [] }))),

		// Where a service sends the browser back after a sign-in: `/mcp/callback/apps` for a native connector (one address for everyone, which providers need registered), and
		// `/mcp/callback/<owner>` for a remote server Pim registered itself with. The sign-in's own state finds the connection.
		route("GET", "/mcp/callback/:who", async ({ app, url, maybePrincipal }) => resultPage(await service(app).finish(url.searchParams, await maybePrincipal().catch(() => null)))),
		// The client metadata document of a sign-in that takes one in place of a registration (Amp's).
		route("GET", "/mcp/client/:owner", async ({ params, origin }) => ok({ client_id: `${origin}/mcp/client/${params[0]}`, client_name: "Pim", redirect_uris: [`${origin}/mcp/callback/${params[0]}`], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" })),

		// A server's delivery of an event a watch asked for (Standard Webhooks, signed with the watch's own secret). One without those headers is the generic connector webhook.
		route("POST", "/mcp/events/:owner/:key", async ({ app, params, bytes, req }) => {
			const raw = await bytes(1_000_000);
			const header = (n: string) => (typeof req.headers[n] === "string" ? (req.headers[n] as string) : undefined);
			if (header("webhook-signature") === undefined) return ok(await app.connectors.receiveEvent(params[0]!, params[1]!, raw, header("x-pim-signature") ?? header("x-hub-signature-256"), header("x-pim-delivery") ?? header("x-github-delivery")), 202);
			const headers = new Headers(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])));
			const r = await receiveWatchEvent({ app, crypto: app.crypto, transport: transportOf(env), publicUrl: undefined, now: Date.now }, params[0]!, params[1]!, headers, raw);
			return r.status === 204 ? { status: 204 } : ok(r.body ?? {}, r.status);
		}),
		// A native connector's action, for the person in their own browser only, such as Drive's file picker.
		route("POST", "/api/app-actions/:extension/:app/:action", async ({ app, principal, params, json }) => {
			const p = await principal();
			if (p.kind !== "user") throw new BadRequestError("Only the person, signed in to Pim in their browser, can do this");
			const s = service(app);
			const ref = `${params[0]}/${params[1]}`;
			const body = await json();
			return ok({ result: (await s.act(p, ref, params[2]!, body)) ?? null });
		}),
		// The connector's page for the person once connected: Drive's file picker.
		route("GET", "/app-pages/:extension/:app", async ({ app, principal, params }) => {
			const p = await principal();
			const ref = `${params[0]}/${params[1]}`;
			if (ref !== "google/drive" || !service(app).directory([]).some((d) => d.ref === ref)) throw new NotFoundError("No such page");
			const nonce = randomBytes(16).toString("base64");
			const page = drivePage(nonce);
			void p;
			return html(200, page.html, { "content-security-policy": page.contentSecurityPolicy, "referrer-policy": "no-referrer" });
		}),
	];
}
