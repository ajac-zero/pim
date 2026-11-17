/**
 * The tool permissions a person sets for their connectors, and "always approve" on an approval, in the shapes the web app already speaks (`/api/permissions`,
 * `/api/approvals/:id/approve|deny`). A permission is a person's choice (Off, Ask, On); an approval is the person's answer to one call. Always approve is the first made from
 * the second: it sets the tool to On, which the person can turn back from the same screen.
 */
import { ForbiddenError } from "@pim/v2-contracts/authz";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { ok, route, type Route } from "@pim/v2-app/http";
import { approvalsOf } from "./compat/boot.ts";
import { type Approval, type ConnectorRow, type McpTool, type Permission, type PermissionRow, resolvePermission } from "./connector-tools.ts";

const CHOICES: Permission[] = ["off", "ask", "on"];

/** Only a person (a session or a token of theirs) sets permissions or decides approvals; an agent never widens its own reach. */
async function person(app: App, p: Principal, write: boolean): Promise<void> {
	await app.identity.authz.enforce(p, write ? "api:write" : "api:read");
	if (p.kind !== "user" && p.kind !== "token") throw new ForbiddenError("tool-permissions", "session-only");
}

export function permissionRoutes(): Route[] {
	const rows = async (app: App, ownerId: string) =>
		app.db.owner(ownerId, async (tx) => ({
			connectors: (await tx.query("SELECT id, kind, name, url, status, credential, enabled_tools, approval, discovered_tools FROM pim_app.connectors WHERE url IS NOT NULL ORDER BY created_at")).rows.map((r) => ({ id: r.id as string, kind: r.kind as string, name: r.name as string, url: r.url as string, status: r.status as string, credential: r.credential as string | null, enabledTools: r.enabled_tools as string[], approval: r.approval as Approval, discovered: r.discovered_tools as (McpTool)[] })),
			permissions: (await tx.query("SELECT audience, app, tool, permission FROM pim_app.tool_permissions")).rows as PermissionRow[],
		}));
	const info = (c: ConnectorRow & { discovered: McpTool[] }, tool: McpTool, permissions: PermissionRow[], agentId?: string) => {
		const r = resolvePermission(c, tool, permissions, agentId);
		const agent = agentId !== undefined;
		return {
			app: c.id, appName: c.name, tool: tool.name, name: `${c.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"), description: tool.description ?? null,
			readOnly: tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructiveHint === true,
			permission: r.permission, default: agent ? (r.default === "off" ? "off" : "on") : r.default, chosen: agent ? r.agentChosen : r.chosen, changed: false, choices: agent ? ["off", "on"] : CHOICES,
		};
	};
	return [
		route("GET", "/api/permissions", async ({ app, principal, url }) => {
				const p = await principal();
				await person(app, p, false);
				if (url.searchParams.has("circle")) return ok({ tools: [] });
				const agent = url.searchParams.get("agent") ?? undefined;
				const { connectors, permissions } = await rows(app, p.ownerId);
				return ok({ tools: connectors.flatMap((c) => c.discovered.map((t) => info(c, t, permissions, agent))) });
		}),
		route("PUT", "/api/permissions", async ({ app, principal, json }) => {
				const p = await principal();
				await person(app, p, true);
				const b = await json();
				if (b.circle) throw new BadRequestError("Circles' tool permissions are not available yet.");
				if (typeof b.app !== "string" || !b.app || typeof b.tool !== "string" || !b.tool) throw new BadRequestError("A connector tool is named by app and tool; only connectors' tools have a permission here.");
				const agent = typeof b.agent === "string" ? b.agent : undefined;
				const choices = agent ? ["on", "off"] : CHOICES;
				if (b.permission !== null && !choices.includes(b.permission)) throw new BadRequestError(`permission must be one of ${choices.join(", ")}, or null for the default`);
				const audience = agent ? `agent:${agent}` : "owner";
				const { connectors, permissions } = await rows(app, p.ownerId);
				const c = connectors.find((x) => x.id === b.app);
				const tool = c?.discovered.find((t) => t.name === b.tool);
				if (!c || !tool) throw new NotFoundError("No such connector tool");
				await app.db.owner(p.ownerId, async (tx) => {
					if (b.permission === null) await tx.query("DELETE FROM pim_app.tool_permissions WHERE audience = $1 AND app = $2 AND tool = $3", [audience, b.app, b.tool]);
					else await tx.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id, audience, app, tool) DO UPDATE SET permission = excluded.permission, updated_at = now()", [p.ownerId, audience, b.app, b.tool, b.permission]);
				});
				const after = (await rows(app, p.ownerId)).permissions;
				void permissions;
				return ok(info(c, tool, after, agent));
		}),
		...(["approve", "deny"] as const).map((verb) => route("POST", `/api/approvals/:id/${verb}`, async ({ app, principal, json, params }) => {
				const p = await principal();
				await person(app, p, true);
				const id = params[0]!;
				const approve = verb === "approve";
				const body = await json().catch(() => ({}) as Record<string, any>);
				const filed = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT tool, args FROM pim_app.approvals WHERE id = $1", [id])).rows[0]);
				if (!filed) throw new NotFoundError("No such approval");
				await app.approvals.decide(p, id, approve);
				if (approve && body.always === true && filed.tool === "connector:call") {
					const { connector, tool } = filed.args?.resource ?? {};
					if (typeof connector === "string" && typeof tool === "string") await app.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission) VALUES ($1,'owner',$2,$3,'on') ON CONFLICT (owner_id, audience, app, tool) DO UPDATE SET permission = 'on', updated_at = now()", [p.ownerId, connector, tool]));
				}
				return ok((await approvalsOf(app, p.ownerId, "WHERE id = $1", [id]))[0]);
		})),
	];
}
