/**
 * The MCP clients the person let into Pim (`/api/connections`, and disconnecting one) and the tool permissions (`./tool-permission-routes.ts`). The connectors themselves (the
 * directory, `/api/mcp`, sign-in) are `./compat/connectors.ts`.
 */
import { ok, route, type Route } from "@pim/v2-app/http";
import { permissionRoutes } from "./tool-permission-routes.ts";

export function connectorRoutes(): Route[] {
	return [
		...permissionRoutes(),
		route("GET", "/api/connections", async ({ app, principal }) => ok({ connections: (await app.mcp.connections((await principal()).ownerId)).map((c) => ({ id: c.id, name: c.name, createdAt: c.createdAt.getTime(), expiresAt: c.expiresAt ? c.expiresAt.getTime() : null })) })),
		route("DELETE", "/api/connections/:id", async ({ app, principal, params }) => (await app.mcp.disconnect((await principal()).ownerId, params[0]!), ok({ deleted: true }))),
	];
}
