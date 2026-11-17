/**
 * The app bridge: what `window.pim` in a framed app reaches. The web app relays each call to `POST …/versions/:version/bridge` as the person using the app, and
 * asks them first when the call needs a permission (`{ needs }`), which `…/grants` then records for that version of the app (a new version, which is new code, asks again).
 *
 * The boundaries are v1's: an app reaches only its viewer's space and, for `shared.*`, the app owner's, and only through what the viewer may already see of the
 * app (their own, shared with a circle they are in, or published). What it keeps for the viewer (`storage.*`) needs no permission; the model and a connector's
 * tool need a grant; a tool is callable only when its owner switched it On (one that asks first, or is off, is refused, since a page can't show the person
 * what it is about to do); a call is made as the person, never with the app's own authority.
 */
import type { App } from "@pim/v2-app/app";
import type { Tx } from "@pim/v2-app/db";
import { openString } from "@pim/v2-app/crypto";
import { BadRequestError, NotFoundError, PimError, RefusedError } from "@pim/v2-app/errors";
import { type Route, route } from "@pim/v2-app/http";
import type { Principal } from "@pim/v2-contracts/identity";
import { publicUrl } from "../agent-tools.ts";
import { type ConnectorRow, McpAuthError, type McpTool, type PermissionRow, parseCredential, resolvePermission, resultText, type Transport, withSession } from "../connector-tools.ts";
import { digestOf, ok } from "./admin-util.ts";
import { askModel } from "./app-model.ts";
import { framePage } from "./app-frame.ts";
import { num, ownVersion, publishedCopy, readable, sharedLatest } from "./admin-apps.ts";

type Env = Record<string, string | undefined>;
type Scope = "own" | "shared";

/** What one app may keep through the bridge, keys and values together in UTF-8 bytes, per scope and in all (v1's limits). */
export const MAX_DATA_BYTES = 1_000_000;
export const MAX_DATA_TOTAL_BYTES = 10_000_000;
const MAX_KEY = 200;
const MAX_PROMPT = 20_000;

/** One version of an app as the viewer reaches it: the key their space knows it by, the digest grants are held to, and whose space holds what everyone using it sees. */
type Subject = { key: string; sha: string; hostOwner: string; hostKey: string };

const bytes = (s: string) => Buffer.byteLength(s);
const checkKey = (key: unknown): string => {
	if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY) throw new BadRequestError(`A key is 1 to ${MAX_KEY} characters`);
	return key;
};

/** A storage call (`storage.get`, `shared.set`, ...) on what an app keeps in one space, in one scope. */
async function dataCall(tx: Tx, ownerId: string, appKey: string, scope: Scope, op: string, args: Record<string, unknown>): Promise<unknown> {
	switch (op) {
		case "get":
			return (await tx.query("SELECT value FROM pim_app.app_data WHERE owner_id = $1 AND app_key = $2 AND scope = $3 AND key = $4", [ownerId, appKey, scope, checkKey(args.key)])).rows[0]?.value ?? null;
		case "list": {
			const prefix = typeof args.prefix === "string" ? args.prefix : "";
			return (await tx.query("SELECT key FROM pim_app.app_data WHERE owner_id = $1 AND app_key = $2 AND scope = $3 AND left(key, $4) = $5 ORDER BY key", [ownerId, appKey, scope, prefix.length, prefix])).rows.map((r) => r.key as string);
		}
		case "set": {
			const key = checkKey(args.key);
			if (typeof args.value !== "string") throw new BadRequestError("An app can keep only text: use JSON.stringify for anything else.");
			const size = bytes(key) + bytes(args.value);
			// Both limits count what this key already holds as replaced.
			const [here, all, old] = await Promise.all([
				tx.query("SELECT COALESCE(SUM(size), 0)::bigint AS n FROM pim_app.app_data WHERE owner_id = $1 AND app_key = $2 AND scope = $3", [ownerId, appKey, scope]),
				tx.query("SELECT COALESCE(SUM(size), 0)::bigint AS n FROM pim_app.app_data WHERE owner_id = $1", [ownerId]),
				tx.query("SELECT size FROM pim_app.app_data WHERE owner_id = $1 AND app_key = $2 AND scope = $3 AND key = $4", [ownerId, appKey, scope, key]),
			]);
			const replaced = Number(old.rows[0]?.size ?? 0);
			const used = Number(here.rows[0]!.n) - replaced;
			if (used + size > MAX_DATA_BYTES) throw new PimError(413, "too_large", `An app can keep up to ${MAX_DATA_BYTES} bytes; this would make ${used + size}.`);
			const total = Number(all.rows[0]!.n) - replaced;
			if (total + size > MAX_DATA_TOTAL_BYTES) throw new PimError(429, "quota", `Apps can keep up to ${MAX_DATA_TOTAL_BYTES} bytes in all; ${total} are used. Delete an app first.`);
			await tx.query("INSERT INTO pim_app.app_data (owner_id, app_key, scope, key, value, size) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (owner_id, app_key, scope, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = now()", [ownerId, appKey, scope, key, args.value, size]);
			return null;
		}
		case "delete":
			await tx.query("DELETE FROM pim_app.app_data WHERE owner_id = $1 AND app_key = $2 AND scope = $3 AND key = $4", [ownerId, appKey, scope, checkKey(args.key)]);
			return null;
		default:
			throw new BadRequestError(`There is no pim.${op}`);
	}
}

type ToolFound = { connector: ConnectorRow; tool: McpTool; capability: string; label: string };

/** The connector tools the person has switched On: `name` is `<connector id>/<tool>`, or a bare tool name that only one connector has. */
async function toolFor(app: App, ownerId: string, name: unknown): Promise<ToolFound> {
	if (typeof name !== "string" || name === "") throw new BadRequestError("pim.tools.call needs a tool name");
	const { rows, perms } = await app.db.owner(ownerId, async (tx) => ({
		rows: (await tx.query("SELECT id, kind, name, url, status, credential, discovered_tools, enabled_tools, approval FROM pim_app.connectors WHERE url IS NOT NULL")).rows,
		perms: (await tx.query("SELECT audience, app, tool, permission FROM pim_app.tool_permissions WHERE audience = 'owner'")).rows as PermissionRow[],
	}));
	const found: ToolFound[] = [];
	for (const r of rows) {
		const connector: ConnectorRow = { id: r.id, kind: r.kind, name: r.name, url: r.url, status: r.status, credential: r.credential, enabledTools: r.enabled_tools, approval: r.approval };
		for (const tool of r.discovered_tools as McpTool[]) {
			if (name !== `${connector.id}/${tool.name}` && name !== tool.name) continue;
			found.push({ connector, tool, capability: `tool:${connector.id}/${tool.name}`, label: `${connector.name}: ${tool.annotations?.title ?? tool.name}` });
		}
	}
	if (found.length === 0) throw new NotFoundError(`No connector tool ${name}`);
	if (found.length > 1) throw new BadRequestError(`More than one connector has ${name}: name it <connector id>/<tool>`);
	const one = found[0]!;
	if (one.connector.credential !== null && one.connector.status !== "connected") throw new PimError(503, "unavailable", `${one.connector.name} isn't connected right now.`);
	if (resolvePermission(one.connector, one.tool, perms).permission !== "on") throw new RefusedError(`${one.connector.name}'s ${one.tool.name} asks you before it runs, or is off, so an app can't use it.`, "tool_not_on");
	return one;
}

const granted = (app: App, ownerId: string, s: Subject, capability: string) =>
	app.db.owner(ownerId, async (tx) => (await tx.query("SELECT 1 FROM pim_app.app_grants WHERE owner_id = $1 AND app_key = $2 AND sha256 = $3 AND capability = $4", [ownerId, s.key, s.sha, capability])).rowCount! > 0);

export type Bridge = { call(p: Principal, s: Subject, op: unknown, args: Record<string, unknown>): Promise<{ value: unknown } | { needs: { capability: string; label: string } }>; grant(p: Principal, s: Subject, capability: unknown): Promise<string> };

export function createBridge(app: App, env: Env, fetcher: typeof fetch = fetch): Bridge {
	const transport: Transport = { fetch: fetcher, allowPrivate: env.PIM_CONNECTOR_ALLOW_PRIVATE === "1", check: publicUrl };
	return {
		async call(p, s, op, args) {
			if (typeof op !== "string") throw new BadRequestError("op is required");
			const [group, name] = op.split(".") as [string, string | undefined];
			const write = name === "set" || name === "delete" || group === "tools";
			await app.identity.authz.enforce(p, write ? "api:write" : "api:read");
			if (group === "storage" && name) return { value: await app.db.owner(p.ownerId, (tx) => dataCall(tx, p.ownerId, s.key, "own", name, args)) };
			// What everyone using the app sees is the app owner's: written in their space, by whoever may see the app.
			if (group === "shared" && name) return { value: await app.db.owner(s.hostOwner, (tx) => dataCall(tx, s.hostOwner, s.hostKey, "shared", name, args)) };
			if (op === "model.ask") {
				const prompt = args.prompt;
				if (typeof prompt !== "string" || prompt.trim() === "") throw new BadRequestError("pim.ask needs a prompt");
				if (prompt.length > MAX_PROMPT) throw new PimError(413, "too_large", `A prompt can be at most ${MAX_PROMPT} characters`);
				if (!(await granted(app, p.ownerId, s, "model"))) return { needs: { capability: "model", label: "model" } };
				return { value: await askModel(app, p, env, prompt, fetcher) };
			}
			if (op === "tools.call") {
				const t = await toolFor(app, p.ownerId, args.name);
				if (!(await granted(app, p.ownerId, s, t.capability))) return { needs: { capability: t.capability, label: t.label } };
				const input = args.input ?? {};
				if (typeof input !== "object" || input === null || Array.isArray(input)) throw new BadRequestError("A tool's input must be an object");
				const { connector } = t;
				const bearer = connector.credential ? parseCredential(await openString(app.crypto, connector.credential, `connector:${p.ownerId}/${connector.id}`)).bearer : null;
				try {
					const result = await withSession(transport, connector.url, bearer, (rpc) => rpc("tools/call", { name: t.tool.name, arguments: input }), 30_000);
					if (result?.isError === true) throw new PimError(502, "tool_failed", resultText(result));
					return { value: resultText(result) };
				} catch (error) {
					if (error instanceof McpAuthError) throw new PimError(502, "tool_failed", `${connector.name} refused the connection's credential; connect it again in Settings.`);
					throw error;
				}
			}
			throw new BadRequestError(`There is no pim.${op}`);
		},
		async grant(p, s, capability) {
			await app.identity.authz.enforce(p, "api:write");
			if (capability !== "model") {
				if (typeof capability !== "string" || !capability.startsWith("tool:")) throw new BadRequestError("capability must be model or tool:<name>");
				// A tool that isn't On can't be granted, so a grant is never kept for something the page could not use.
				if ((await toolFor(app, p.ownerId, capability.slice("tool:".length))).capability !== capability) throw new BadRequestError("Name the tool as tool:<connector id>/<tool>");
			}
			await app.db.owner(p.ownerId, (tx) => tx.query("INSERT INTO pim_app.app_grants (owner_id, app_key, sha256, capability) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [p.ownerId, s.key, s.sha, capability]));
			return capability;
		},
	};
}

const noStore = (body: unknown, status = 200) => ({ ...ok(body, status), headers: { "cache-control": "no-store" } });

/** The version of an app the viewer may use, as a bridge subject: their own, one a circle shares with them (its latest), or a published one (pinned). */
type Resolve = (app: App, p: Principal, params: string[]) => Promise<Subject>;
const own: Resolve = async (app, p, [id, version]) => {
	const { v } = await app.db.owner(p.ownerId, (tx) => ownVersion(tx, p.ownerId, id!, num(version)));
	return { key: id!, sha: digestOf(v.files), hostOwner: p.ownerId, hostKey: id! };
};
const shared: Resolve = async (app, p, [host, id, version]) => {
	const r = await sharedLatest(app, p, host!, id!);
	if (num(version) !== r.latest_version) throw new NotFoundError("No such version");
	return { key: `${r.owner_id}/${id}`, sha: digestOf(r.files), hostOwner: r.owner_id, hostKey: id! };
};
const published: Resolve = async (app, p, [publicId]) => {
	const c = await publishedCopy(app, publicId!);
	return { key: `gallery/${publicId}`, sha: digestOf(c.v.files), hostOwner: c.pub.owner_id, hostKey: c.pub.artifact_id };
};

export function bridgeRoutes(env: Env): Route[] {
	const routes: Route[] = [];
	const bridges = new WeakMap<App, Bridge>();
	const bridgeOf = (app: App) => bridges.get(app) ?? (bridges.set(app, createBridge(app, env)), bridges.get(app)!);
	for (const [prefix, resolve] of [["/api/artifacts/:id", own], ["/api/shared-artifacts/:host/:id", shared], ["/api/published-artifacts/:id", published]] as const) {
		routes.push(
			route("POST", `${prefix}/versions/:version/bridge`, async ({ app, principal, params, json }) => {
				const p = await principal();
				await readable(app, p);
				const { op, args } = await json();
				return noStore(await bridgeOf(app).call(p, await resolve(app, p, params), op, args && typeof args === "object" ? args : {}));
			}),
			route("POST", `${prefix}/versions/:version/grants`, async ({ app, principal, params, json }) => {
				const p = await principal();
				await readable(app, p);
				return noStore({ granted: await bridgeOf(app).grant(p, await resolve(app, p, params), (await json()).capability) }, 201);
			}),
		);
	}
	// A published app at its public address: the same sandboxed page, for anyone with the link. It has no space around it, so its bridge calls fail.
	routes.push(
		route("GET", "/p/:id", async ({ app, params, origin }) => {
			const c = await publishedCopy(app, params[0]!);
			if (c.kind === "backend") throw new NotFoundError();
			const page = framePage(c.kind, c.v.files, origin);
			return { ...page, headers: { ...page.headers, "x-robots-tag": "noindex" } };
		}),
	);
	return routes;
}
