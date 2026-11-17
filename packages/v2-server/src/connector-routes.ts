/**
 * The connector surface the web app speaks: `/api/mcp` (the connected servers, connecting one by its address, removing one), `/api/connections` (the MCP clients the
 * person let into Pim, and disconnecting one) and the tool permissions (`./tool-permission-routes.ts`). Connecting a server makes a custom MCP connector, finds its
 * tools, and switches them on at the connector's approval policy: a person who connects a server means to use it, and each tool is still Off, Ask or On from Settings.
 */
import type { Principal } from "@pim/v2-contracts/identity";
import { BadRequestError } from "@pim/v2-app/errors";
import { ok, route, type Route } from "@pim/v2-app/http";
import { permissionRoutes } from "./tool-permission-routes.ts";

const STATE: Record<string, string> = { connected: "ready", auth_required: "authenticating", disconnected: "ready" };

export function connectorRoutes(): Route[] {
	const asPerson = (p: Principal) => p;
	return [
		...permissionRoutes(),
		route("GET", "/api/mcp", async ({ app, principal }) => {
			const p = asPerson(await principal());
			const servers = (await app.connectors.list(p)).filter((c) => c.url);
			return ok({ servers: servers.map((c) => ({ id: c.id, app: null, name: c.name, url: c.url, state: STATE[c.status] ?? "failed", error: null, authUrl: null, agents: [], tools: c.discoveredTools.map((t) => ({ name: t.name })) })) });
		}),
		route("POST", "/api/mcp", async ({ app, principal, json }) => {
			const p = asPerson(await principal());
			const b = await json();
			const url = typeof b.url === "string" ? b.url : typeof b.app === "string" && /^https?:\/\//.test(b.app) ? b.app : "";
			if (!url) throw new BadRequestError("Give the server's address (url). The catalog's connectors are connected from the catalog.");
			const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : new URL(url).host;
			const { connector } = await app.connectors.create(p, { kind: "custom_mcp", name, url, ...(typeof b.credential === "string" && b.credential ? { credential: b.credential } : {}) });
			try {
				await app.connectors.discover(p, connector.id);
				const found = (await app.connectors.get(p, connector.id)).discoveredTools.map((t) => t.name);
				await app.connectors.setEnabledTools(p, connector.id, found);
				return ok({ id: connector.id, state: "ready" });
			} catch (error) {
				// The server is kept, so the person can sign in or fix it and try again; what went wrong is said, not hidden.
				return ok({ id: connector.id, state: "failed", error: error instanceof Error ? error.message : String(error) });
			}
		}),
		route("DELETE", "/api/mcp/:id", async ({ app, principal, params }) => (await app.connectors.remove(asPerson(await principal()), params[0]!), ok({ deleted: true }))),
		route("GET", "/api/connections", async ({ app, principal }) => ok({ connections: (await app.mcp.connections((await principal()).ownerId)).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.getTime(), expiresAt: c.expiresAt ? c.expiresAt.getTime() : null })) })),
		route("DELETE", "/api/connections/:id", async ({ app, principal, params }) => (await app.mcp.disconnect((await principal()).ownerId, params[0]!), ok({ deleted: true }))),
	];
}
