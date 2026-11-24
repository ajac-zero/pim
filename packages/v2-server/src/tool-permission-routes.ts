/**
 * The tool permissions a person sets for Pim's own tools and their connectors', and "always approve" on an approval, in the shapes the web app already speaks (`/api/permissions`,
 * `/api/approvals/:id/approve|deny`). A permission is a person's choice (Off, Ask, On); an approval is the person's answer to one call. Always approve is the first made from
 * the second: it sets the tool to On, which the person can turn back from the same screen. Pim's own tools (`@pim/v2-app/tool-permissions`) are the person's alone to set; a connector's
 * tools are set for each agent (Off until chosen) and for each circle, each tied to the tool's definition when it was chosen. Nothing about a connector's tools is set for the account as a whole.
 */
import { ForbiddenError } from "@pim/v2-contracts/authz";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Tx } from "@pim/v2-app/db";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { ok, route, type Route } from "@pim/v2-app/http";
import { OWN_TOOLS, ownToolOf, choiceChanged, type OwnTool } from "@pim/v2-app/tool-permissions";
import { approvalsOf } from "./compat/boot.ts";
import { type ConnectorRow, type McpTool, type Permission, type PermissionRow, resolvePermission } from "./connector-tools.ts";

const CHOICES: Permission[] = ["off", "ask", "on"];

/** Only a person (a session or a token of theirs) sets permissions or decides approvals; an agent never widens its own reach. */
async function person(app: App, p: Principal, write: boolean): Promise<void> {
	await app.identity.authz.enforce(p, write ? "api:write" : "api:read");
	if (p.kind !== "user" && p.kind !== "token") throw new ForbiddenError("tool-permissions", "session-only");
}

export function permissionRoutes(): Route[] {
	const rows = async (app: App, ownerId: string) =>
		app.db.owner(ownerId, async (tx) => ({
			connectors: (await tx.query("SELECT id, kind, name, url, status, credential, discovered_tools FROM pim_app.connectors WHERE url IS NOT NULL OR kind = 'native' ORDER BY created_at")).rows.map((r) => ({ id: r.id as string, kind: r.kind as string, name: r.name as string, url: r.url as string, status: r.status as string, credential: r.credential as string | null, discovered: r.discovered_tools as (McpTool)[] })),
			permissions: (await tx.query("SELECT audience, app, tool, permission, definition FROM pim_app.tool_permissions")).rows as PermissionRow[],
		}));
	/** A connector's tool as one agent has it: Off until the person chooses, then Off, Ask or On. */
	const info = (c: ConnectorRow & { discovered: McpTool[] }, tool: McpTool, permissions: PermissionRow[], agentId: string) => {
		const r = resolvePermission(c.id, tool, permissions, agentId, tool.definition ?? null);
		return {
			app: c.id, appName: c.name, tool: tool.name, name: `${c.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"), description: tool.description ?? null,
			readOnly: tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructiveHint === true,
			permission: r.permission, default: "off", chosen: r.chosen, changed: r.changed, choices: CHOICES,
		};
	};
	/** A circle's permissions are the host's choices for it, off until set (a circle starts with every tool off); a destructive tool asks even when set On. */
	const circleInfo = (c: ConnectorRow & { discovered: McpTool[] }, tool: McpTool, permissions: PermissionRow[], circle: string) => {
		const row = permissions.find((x) => x.audience === `circle:${circle}` && x.app === c.id && x.tool === tool.name) ?? null;
		const chosen = row?.permission ?? null;
		const destructive = tool.annotations?.destructiveHint === true;
		// A tool the connector changed since the host chose it is off for the circle until they choose again.
		const changed = choiceChanged(row, tool.definition, false);
		return {
			app: c.id, appName: c.name, tool: tool.name, name: `${c.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"), description: tool.description ?? null,
			readOnly: tool.annotations?.readOnlyHint === true, destructive, permission: changed ? "off" : destructive && chosen === "on" ? "ask" : (chosen ?? "off"), default: "off", chosen, changed, choices: destructive ? ["off", "ask"] : CHOICES,
		};
	};
	/** One of Pim's own tools as the permissions screen lists it: for the person (`ownerRow`), with no connector. */
	const ownInfo = (t: OwnTool, permissions: PermissionRow[]) => {
		const chosen = permissions.find((x) => x.audience === "owner" && x.app === "" && x.tool === t.tool)?.permission ?? null;
		return { app: null, appName: null, tool: t.tool, name: t.tool, description: t.description, readOnly: false, destructive: false, permission: chosen ?? t.default, default: t.default, chosen, changed: false, choices: t.explicit ? ["off", "ask"] : CHOICES };
	};
	/** An agent's switch for skills: on, its chats write and install skills (asking first, as `write_skill`'s permission says); off, they do not. On unless the person turned it off. */
	const skillsInfo = (permissions: PermissionRow[], agent: string) => {
		const chosen = permissions.find((x) => x.audience === `agent:${agent}` && x.app === "" && x.tool === "write_skill")?.permission ?? null;
		return { app: null, appName: null, tool: "write_skill", name: "write_skill", description: "Write and install skills for this agent, asking first as write_skill's permission says", readOnly: false, destructive: false, permission: chosen === "off" ? "off" : "on", default: "on", chosen, changed: false, choices: ["off", "on"] };
	};
	const ownCircle = async (app: App, ownerId: string, id: string) => {
		if (!(await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.circles WHERE id = $1 AND owner_id = $2", [id, ownerId])).rowCount))) throw new NotFoundError("No such circle");
	};
	return [
		route("GET", "/api/permissions", async ({ app, principal, url }) => {
				const p = await principal();
				await person(app, p, false);
				const circle = url.searchParams.get("circle");
				const { connectors, permissions } = await rows(app, p.ownerId);
				if (circle) {
					await ownCircle(app, p.ownerId, circle);
					return ok({ tools: connectors.flatMap((c) => c.discovered.map((t) => circleInfo(c, t, permissions, circle))) });
				}
				const agent = url.searchParams.get("agent");
				if (agent) return ok({ tools: connectors.flatMap((c) => c.discovered.map((t) => info(c, t, permissions, agent))), skills: skillsInfo(permissions, agent) });
				// The host's operations are the admin's majordomo's alone.
				const admin = (await app.identity.authz.account(p.ownerId))?.role === "admin";
				return ok({ tools: OWN_TOOLS.filter((t) => admin || !t.tool.startsWith("hostops_")).map((t) => ownInfo(t, permissions)) });
		}),
		route("PUT", "/api/permissions", async ({ app, principal, json }) => {
				const p = await principal();
				await person(app, p, true);
				const b = await json();
				const circle = typeof b.circle === "string" && b.circle ? b.circle : undefined;
				if (circle) await ownCircle(app, p.ownerId, circle);
				const agent = typeof b.agent === "string" ? b.agent : undefined;
				const app_ = typeof b.app === "string" ? b.app : "";
				// An agent's one switch among Pim's own tools is for skills, On or Off; its connectors' tools take all three.
				const choices = agent && app_ === "" ? ["on", "off"] : CHOICES;
				if (typeof b.tool !== "string" || !b.tool) throw new BadRequestError("A tool is named by its app (a connector's id, none for Pim's own) and tool");
				if (b.permission !== null && !choices.includes(b.permission)) throw new BadRequestError(`permission must be one of ${choices.join(", ")}, or null for the default`);
				if (app_ !== "" && !agent && !circle) throw new BadRequestError("A connector's tools are set for each agent or circle: say which with agent or circle");
				const audience = circle ? `circle:${circle}` : agent ? `agent:${agent}` : "owner";
				const store = (tx: Tx, definition: string | null) =>
					b.permission === null
						? tx.query("DELETE FROM pim_app.tool_permissions WHERE audience = $1 AND app = $2 AND tool = $3", [audience, app_, b.tool])
						: tx.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission, definition) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_id, audience, app, tool) DO UPDATE SET permission = excluded.permission, definition = excluded.definition, updated_at = now()", [p.ownerId, audience, app_, b.tool, b.permission, definition]);
				if (app_ === "") {
					// Pim's own tools are the person's; an agent has one switch of its own, for skills.
					if (agent) {
						if (b.tool !== "write_skill") throw new NotFoundError(`That agent has no switch for ${b.tool}`);
						await app.db.owner(p.ownerId, (tx) => store(tx, null));
						return ok(skillsInfo((await rows(app, p.ownerId)).permissions, agent));
					}
					const own = circle ? undefined : OWN_TOOLS.find((t) => t.tool === b.tool);
					if (!own) throw new NotFoundError(`No tool ${b.tool}`);
					if (own.explicit && b.permission === "on") throw new BadRequestError("This tool can only be off or ask: every change requires explicit approval");
					await app.db.owner(p.ownerId, (tx) => store(tx, null));
					return ok(ownInfo(own, (await rows(app, p.ownerId)).permissions));
				}
				// What is stored is tied to the tool as the server describes it now, so ask it first; a server that cannot answer leaves what was discovered.
				await app.connectors.discover(p, app_).catch(() => undefined);
				const { connectors } = await rows(app, p.ownerId);
				const c = connectors.find((x) => x.id === app_);
				const tool = c?.discovered.find((t) => t.name === b.tool);
				if (!c || !tool) throw new NotFoundError("No such connector tool");
				await app.db.owner(p.ownerId, (tx) => store(tx, tool.definition ?? null));
				const after = (await rows(app, p.ownerId)).permissions;
				return ok(circle ? circleInfo(c, tool, after, circle) : info(c, tool, after, agent!));
		}),
		...(["approve", "deny"] as const).map((verb) => route("POST", `/api/approvals/:id/${verb}`, async ({ app, principal, json, params }) => {
				const p = await principal();
				await person(app, p, true);
				const id = params[0]!;
				const approve = verb === "approve";
				const body = await json().catch(() => ({}) as Record<string, any>);
				const filed = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT tool, args FROM pim_app.approvals WHERE id = $1", [id])).rows[0]);
				if (!filed) throw new NotFoundError("No such approval");
				// One of Pim's own tools asked: a tool whose every call needs a person's own decision has no "always", and says so before anything is decided.
				const own = filed.tool === "connector:call" ? undefined : ownToolOf(filed.tool, typeof filed.args?.tool === "string" ? filed.args.tool : undefined);
				if (approve && body.always === true && own?.explicit) throw new BadRequestError("This action requires an explicit decision for each request");
				await app.approvals.decide(p, id, approve);
				if (approve && body.always === true && filed.tool === "connector:call" && filed.args?.requestedBy) {
					// A guest's call: always approve opens the tool to that bot's or circle's guests, not to the host's own agents, and settles their other waiting calls of it.
					for (const other of (await app.guests.alwaysFor(p.ownerId, id)).settled) await app.approvals.decide(p, other, true).catch(() => undefined);
				} else if (approve && body.always === true && filed.tool === "connector:call") {
					// Always approve opens the tool for the agent that asked, and no other: a connector's tools are each agent's own to set.
					const { connector, tool } = filed.args?.resource ?? {};
					// The digest the person saw when asked, not the stored one, which may be older than the tool.
					const agent = filed.args?.agentId;
					if (typeof connector === "string" && typeof tool === "string" && typeof agent === "string") {
						const known = await app.db.owner(p.ownerId, async (tx) => ((await tx.query("SELECT discovered_tools FROM pim_app.connectors WHERE id = $1", [connector])).rows[0]?.discovered_tools ?? []) as McpTool[]);
						const found = known.find((t) => t.name === tool);
						await app.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission, definition) VALUES ($1,$2,$3,$4,'on',$5) ON CONFLICT (owner_id, audience, app, tool) DO UPDATE SET permission = 'on', definition = excluded.definition, updated_at = now()", [p.ownerId, `agent:${agent}`, connector, tool, typeof filed.args?.definition === "string" ? filed.args.definition : (found?.definition ?? null)]));
					}
				} else if (approve && body.always === true && own) {
					// Always approve sets the tool to On for every gated action, and settles the person's other calls of it that wait.
					await app.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.tool_permissions (owner_id, audience, app, tool, permission) VALUES ($1,'owner','',$2,'on') ON CONFLICT (owner_id, audience, app, tool) DO UPDATE SET permission = 'on', definition = NULL, updated_at = now()", [p.ownerId, own.tool]));
					const waiting = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id, args FROM pim_app.approvals WHERE state = 'waiting' AND tool = $1 AND id <> $2 AND args->'requestedBy' IS NULL", [filed.tool, id])).rows);
					for (const other of waiting) if (ownToolOf(filed.tool, typeof other.args?.tool === "string" ? other.args.tool : undefined)?.tool === own.tool) await app.approvals.decide(p, other.id, true).catch(() => undefined);
				}
				return ok((await approvalsOf(app, p.ownerId, "WHERE id = $1", [id]))[0]);
		})),
	];
}
