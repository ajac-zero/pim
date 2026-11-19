import { createHmac, timingSafeEqual } from "node:crypto";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import type { Principal } from "@pim/v2-contracts/identity";
import type { EnvelopeCrypto } from "@pim/v2-contracts/platform";
import { Authorizer } from "./authz.ts";
import { openString, sealString } from "./crypto.ts";
import type { Db } from "./db.ts";
import { BadRequestError, NotFoundError, RefusedError, UnauthorizedError } from "./errors.ts";
import { newId, secret } from "./ids.ts";
import type { Triggers } from "./triggers.ts";
import type { SignIn } from "./signin.ts";

export type ConnectorKind = "builtin" | "native" | "custom_mcp";
export type Tool = { name: string; description?: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }; /** A digest of the tool as the server describes it, whole (`toolDefinition`): what a permission given to it is tied to. */ definition?: string };
export type Connector = { id: string; kind: ConnectorKind; name: string; url: string | null; status: string; hasCredential: boolean; discoveredTools: Tool[]; enabledTools: string[]; eventsPath: string };

/** Fetches a connector's tools (`tools/list`). Injected so the Gate never reaches a third party without a bound. */
export type ToolFetcher = (url: string, credential: string | null) => Promise<Tool[]>;
/** Turns an authorization code from a connector's sign-in into the credential to keep; absent where no MCP OAuth client is configured. */
export type CodeExchanger = (connector: { id: string; url: string | null }, code: string) => Promise<string>;

export const fetchTools: ToolFetcher = async (url, credential) => {
	const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), signal: AbortSignal.timeout(5000) });
	if (!res.ok) throw new BadRequestError(`The connector answered ${res.status}`);
	const body = (await res.json().catch(() => null)) as { result?: { tools?: Tool[] } } | null;
	if (!Array.isArray(body?.result?.tools)) throw new BadRequestError("The connector sent no tool list");
	return body!.result!.tools!.filter((t) => typeof t?.name === "string").map((t) => ({ name: t.name, ...(t.description ? { description: String(t.description).slice(0, 500) } : {}), ...(t.annotations ? { annotations: { ...(typeof t.annotations.readOnlyHint === "boolean" ? { readOnlyHint: t.annotations.readOnlyHint } : {}), ...(typeof t.annotations.destructiveHint === "boolean" ? { destructiveHint: t.annotations.destructiveHint } : {}) } } : {}) }));
};

/**
 * Connectors: the built-in and native (Google, Gmail, Drive) ones and custom MCP servers. Credentials and webhook secrets are sealed. Tool discovery is
 * default-off: tools a server reports land in `discovered_tools`, and nothing reaches an agent until `enableTools` names it. Webhook events arrive at
 * `/mcp/events/<owner>/<key>`, signed with HMAC-SHA256 under the connector's own secret, and fire the triggers watching that connector.
 */
export class Connectors {
	constructor(
		private readonly db: Db,
		private readonly crypto: EnvelopeCrypto,
		private readonly triggers: Triggers,
		private readonly signin: SignIn,
		private readonly opts: { fetchTools?: ToolFetcher; exchange?: CodeExchanger; /** A deployment that lets connectors live at private addresses (a homelab) may reach a server over plain http. */ allowHttp?: boolean } = {},
		private readonly authz = new Authorizer(db),
	) {}

	#row(ownerId: string, r: any): Connector {
		return { id: r.id, kind: r.kind, name: r.name, url: r.url, status: r.status, hasCredential: r.credential !== null, discoveredTools: r.discovered_tools, enabledTools: r.enabled_tools, eventsPath: `/mcp/events/${ownerId}/${r.event_key}` };
	}

	/** Creates a connector. The webhook secret is returned here once; only its sealed form is kept. */
	async create(p: Principal, input: { kind: ConnectorKind; name: string; url?: string; credential?: string }): Promise<{ connector: Connector; eventSecret: string }> {
		await this.authz.enforce(p, "api:write");
		if (!["builtin", "native", "custom_mcp"].includes(input.kind)) throw new BadRequestError("kind is builtin, native or custom_mcp");
		if (!input.name?.trim()) throw new BadRequestError("A connector needs a name");
		if (input.kind === "custom_mcp") {
			if (p.kind !== "user" && p.kind !== "token") throw new RefusedError("Only a person adds a custom connector.", "session-only");
			if (!/^https:\/\//.test(input.url ?? "") && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(input.url ?? "") && !(this.opts.allowHttp && /^http:\/\//.test(input.url ?? ""))) throw new BadRequestError("A custom connector's url is https");
		}
		const id = newId("cn");
		const eventSecret = secret();
		const key = secret(12);
		const credential = input.credential ? await sealString(this.crypto, input.credential, `connector:${p.ownerId}/${id}`) : null;
		const sealedSecret = await sealString(this.crypto, eventSecret, `connector-events:${p.ownerId}/${id}`);
		const row = await this.db.owner(p.ownerId, async (tx) => (await tx.query("INSERT INTO pim_app.connectors (id, owner_id, kind, name, url, credential, event_key, event_secret, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *", [id, p.ownerId, input.kind, input.name.trim(), input.url ?? null, credential, key, sealedSecret, credential ? "connected" : "disconnected"])).rows[0]);
		return { connector: this.#row(p.ownerId, row), eventSecret };
	}

	async list(p: Principal): Promise<Connector[]> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT * FROM pim_app.connectors ORDER BY created_at")).rows.map((r) => this.#row(p.ownerId, r)));
	}

	async get(p: Principal, id: string): Promise<Connector> {
		await this.authz.enforce(p, "api:read");
		return this.db.owner(p.ownerId, async (tx) => {
			const r = (await tx.query("SELECT * FROM pim_app.connectors WHERE id = $1", [id])).rows[0];
			if (!r) throw new NotFoundError("No such connector");
			return this.#row(p.ownerId, r);
		});
	}

	async remove(p: Principal, id: string): Promise<void> {
		await this.authz.enforce(p, "api:write");
		await this.db.owner(p.ownerId, async (tx) => {
			if (!(await tx.query("DELETE FROM pim_app.connectors WHERE id = $1", [id])).rowCount) throw new NotFoundError("No such connector");
			// Triggers watching it can never fire again.
			await tx.query("UPDATE pim_app.triggers SET lifecycle = 'paused', updated_at = now() WHERE source = 'connector_event' AND spec->'source'->>'connectorId' = $1 AND lifecycle = 'enabled'", [id]);
		});
	}

	/** Records what a server reported. New tools are known, never enabled; tools that were enabled and are gone stay listed as enabled until someone removes them. */
	async recordDiscovery(ownerId: string, id: string, tools: Tool[]): Promise<{ discovered: number; added: string[] }> {
		return this.db.owner(ownerId, async (tx) => {
			const r = (await tx.query("SELECT discovered_tools FROM pim_app.connectors WHERE id = $1 FOR UPDATE", [id])).rows[0];
			if (!r) throw new NotFoundError("No such connector");
			const known = new Set((r.discovered_tools as Tool[]).map((t) => t.name));
			const added = tools.filter((t) => !known.has(t.name)).map((t) => t.name);
			await tx.query("UPDATE pim_app.connectors SET discovered_tools = $2 WHERE id = $1", [id, JSON.stringify(tools)]);
			return { discovered: tools.length, added };
		});
	}

	/** Asks the server for its tools, within five seconds, and records them. */
	async discover(p: Principal, id: string): Promise<{ discovered: number; added: string[] }> {
		await this.authz.enforce(p, "api:write");
		const stored = await this.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT url, credential FROM pim_app.connectors WHERE id = $1", [id])).rows[0]);
		if (!stored) throw new NotFoundError("No such connector");
		if (!stored.url) throw new CapabilityUnavailableError("tool discovery", "this connector has no server address");
		const credential = stored.credential ? await openString(this.crypto, stored.credential, `connector:${p.ownerId}/${id}`) : null;
		return this.recordDiscovery(p.ownerId, id, await (this.opts.fetchTools ?? fetchTools)(stored.url, credential));
	}

	/** Turns tools on for agents. Only tools the server reported can be enabled. */
	async setEnabledTools(p: Principal, id: string, names: string[]): Promise<string[]> {
		await this.authz.enforce(p, "api:write");
		return this.db.owner(p.ownerId, async (tx) => {
			const r = (await tx.query("SELECT discovered_tools FROM pim_app.connectors WHERE id = $1 FOR UPDATE", [id])).rows[0];
			if (!r) throw new NotFoundError("No such connector");
			const known = new Set((r.discovered_tools as Tool[]).map((t) => t.name));
			const unknown = names.filter((n) => !known.has(n));
			if (unknown.length) throw new BadRequestError(`Not reported by this connector: ${unknown.join(", ")}`);
			const enabled = [...new Set(names)];
			await tx.query("UPDATE pim_app.connectors SET enabled_tools = $2 WHERE id = $1", [id, enabled]);
			return enabled;
		});
	}

	/** Stores a credential (a native connector's sign-in, or what a connector's OAuth gave back), sealed. */
	async setCredential(ownerId: string, id: string, credential: string): Promise<void> {
		const sealed = await sealString(this.crypto, credential, `connector:${ownerId}/${id}`);
		const n = await this.db.owner(ownerId, async (tx) => (await tx.query("UPDATE pim_app.connectors SET credential = $2, status = 'connected' WHERE id = $1", [id, sealed])).rowCount);
		if (!n) throw new NotFoundError("No such connector");
	}

	/** Starts a connector's sign-in: returns the state to put in the authorization link, and keeps it for the callback. */
	async beginAuth(p: Principal, id: string): Promise<{ state: string }> {
		await this.authz.enforce(p, "api:write");
		await this.get(p, id);
		await this.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.connectors SET status = 'auth_required' WHERE id = $1", [id]));
		return { state: await this.signin.startFlow("oauth", { connector: id, owner: p.ownerId }, 10 * 60_000) };
	}

	/** `/mcp/callback/<owner>`: the service sends the browser back with its state and a code. */
	async finishAuth(ownerId: string, state: string | null, code: string | null): Promise<{ connectorId: string }> {
		const flow = await this.signin.flow<{ connector: string; owner: string }>(state ?? undefined, "oauth", { consume: true });
		if (!flow || flow.owner !== ownerId) throw new BadRequestError("This sign-in expired or started in another browser.");
		await this.authz.requireLive(ownerId);
		if (!code) throw new BadRequestError("The service sent no code.");
		if (!this.opts.exchange) throw new CapabilityUnavailableError("connector sign-in", "no MCP OAuth client is configured on this deployment");
		const url = await this.db.owner(ownerId, async (tx) => (await tx.query("SELECT url FROM pim_app.connectors WHERE id = $1", [flow.connector])).rows[0]?.url ?? null);
		await this.setCredential(ownerId, flow.connector, await this.opts.exchange({ id: flow.connector, url }, code));
		return { connectorId: flow.connector };
	}

	/**
	 * A webhook delivery. The path key finds the connector; the signature (`sha256=<hex>` of the raw body under the connector's secret) proves the sender.
	 * An unknown key and a bad signature are both 401. A suspended or deleted owner receives nothing. A repeated delivery id is stored and fired once.
	 */
	async receiveEvent(ownerId: string, key: string, rawBody: Uint8Array, signature: string | undefined, deliveryId?: string, now = new Date()): Promise<{ accepted: boolean; fired: number }> {
		const found = await this.db.lookup(key, async (tx) => (await tx.query("SELECT id, owner_id, event_secret FROM pim_app.connectors WHERE event_key = $1", [key])).rows[0]);
		if (!found || found.owner_id !== ownerId) throw new UnauthorizedError("Unknown connector");
		const secretValue = await openString(this.crypto, found.event_secret, `connector-events:${ownerId}/${found.id}`);
		const expected = Buffer.from(createHmac("sha256", secretValue).update(rawBody).digest("hex"));
		const given = Buffer.from((signature ?? "").replace(/^sha256=/, ""));
		if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new UnauthorizedError("Bad signature");
		await this.authz.requireLive(ownerId, "connector-event");
		let payload: unknown;
		try {
			payload = JSON.parse(Buffer.from(rawBody).toString("utf8"));
		} catch {
			throw new BadRequestError("The event is not JSON");
		}
		const delivery = deliveryId ?? null;
		const fresh = await this.db.owner(ownerId, async (tx) => !!(await tx.query("INSERT INTO pim_app.connector_events (owner_id, connector_id, delivery_id, payload, received_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", [ownerId, found.id, delivery, JSON.stringify(payload), now])).rowCount);
		if (!fresh && delivery) return { accepted: true, fired: 0 };
		const event = String((payload as { event?: unknown; type?: unknown })?.event ?? (payload as { type?: unknown })?.type ?? "");
		return { accepted: true, fired: await this.triggers.fireConnectorEvent(ownerId, found.id, event, payload as Record<string, unknown>, delivery ?? `${now.getTime()}`) };
	}
}
