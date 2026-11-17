/**
 * The Gate's side of connectors made from the directory: what a person can connect, connecting it (a native connector's OAuth sign-in, or a remote MCP server's, with discovery,
 * dynamic registration and PKCE), finishing the sign-in when the service sends the browser back, and ending a connection. What a connector does once connected (its tools) is the
 * Runner's (`connector-tools.ts`); a connection is a row of `pim_app.connectors` with its sealed credential bundle (`native/oauth-client.ts` shows its shape).
 *
 * Where it stands is on the row: `status` `auth_required` with the `auth_url` to send the person to, `connected`, or `disconnected` with an `error`. The sign-in itself (the PKCE
 * verifier, the client, the token endpoint) is a flow in `pim_app.auth_flows` for fifteen minutes and finishes once. The service sends the browser back to
 * `/mcp/callback/apps` (a native connector, as in v1, so the address registered at the provider is the same) or `/mcp/callback/<owner>` (a remote server, which Pim registered itself).
 */
import type { Principal } from "@pim/v2-contracts/identity";
import { CapabilityUnavailableError } from "@pim/v2-contracts/authz";
import type { App } from "@pim/v2-app/app";
import type { Tool } from "@pim/v2-app/connectors";
import { BadRequestError, NotFoundError } from "@pim/v2-app/errors";
import { openString } from "@pim/v2-app/crypto";
import { mcpFetchTools, parseCredential, refresh, type Transport } from "./connector-tools.ts";
import { type CustomApp } from "./compat/admin-gallery.ts";
import { ApiError } from "./native/http.ts";
import { endpointsOf, type Env, missingSettings, nativeApp, type NativeApp, offeredNativeApps } from "./native/native.ts";
import { authorizeUrl, type Bundle, bundleOf, discover, GrantGone, newVerifier, probe, registerClient, tokenRequest } from "./native/oauth-client.ts";
import { POPULAR_APPS } from "./native/popular-apps.ts";

export const SIGN_IN_MS = 15 * 60_000;
export const NATIVE_CALLBACK = "/mcp/callback/apps";

export type DirectoryApp = { ref: string; name: string; description: string; url: string | null; custom: boolean; icon: string | null; category: string | null; page?: { url: string; label: { en: string; es: string } } };
export type ConnectedApp = { id: string; app: string | null; name: string; url: string; state: "ready" | "authenticating" | "failed"; error: string | null; authUrl: string | null; approval: string; agents: string[]; tools: { name: string }[] };

/** What a flow in `auth_flows` holds while a person signs in. */
type Pending = { mode: "native" | "mcp"; owner: string; connector: string; verifier: string; redirectUri: string; tokenEndpoint: string; clientId: string; clientSecret?: string; resource?: string };

type Row = { id: string; kind: string; name: string; url: string | null; status: string; app_ref: string | null; auth_url: string | null; error: string | null; credential: string | null; enabled_tools: string[]; discovered_tools: Tool[]; approval: string };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class ConnectorService {
	constructor(private readonly app: App, private readonly env: Env, private readonly transport: Transport, private readonly now: () => number = Date.now) {}

	// ---- the directory ----

	/** What this Pim offers: the popular servers (GitHub once its OAuth app is set), the native connectors whose client the admin set, then the admin's own. */
	directory(custom: readonly CustomApp[]): DirectoryApp[] {
		return [
			...POPULAR_APPS.filter((a) => typeof a.client !== "object" || (this.env[a.client.id] && this.env[a.client.secret])).map((a) => ({ ref: `pim.apps/${a.id}`, name: a.name, description: a.description, url: a.url, custom: false, icon: a.icon, category: a.category })),
			...offeredNativeApps(this.env).map((a) => ({ ref: a.ref, name: a.name, description: a.description, url: null, custom: false, icon: a.icon ?? null, category: a.category, ...(a.page ? { page: { url: `/app-pages/${a.ref}`, label: a.page.label } } : {}) })),
			...custom.map((c) => ({ ref: `custom/${c.id}`, name: c.name, description: c.description, url: c.url, custom: true, icon: c.icon, category: c.category })),
		];
	}

	/** Why a native connector is not offered here: what its admin must set. For the answer to a person who asks for one anyway. */
	notOffered(ref: string): string | null {
		const native = nativeApp(ref);
		if (!native) return null;
		const missing = missingSettings(native, this.env);
		return missing.length ? `This Pim isn't set up for ${native.name} yet: its admin must set ${missing.join(", ")}.` : null;
	}

	// ---- the connections ----

	async #rows(ownerId: string): Promise<Row[]> {
		return this.app.db.owner(ownerId, async (tx) => (await tx.query("SELECT id, kind, name, url, status, app_ref, auth_url, error, credential, enabled_tools, discovered_tools, approval FROM pim_app.connectors ORDER BY created_at")).rows as Row[]);
	}

	async list(p: Principal, directory: readonly DirectoryApp[]): Promise<ConnectedApp[]> {
		await this.app.identity.authz.enforce(p, "api:read");
		const agents = await this.app.agents.list(p).catch(() => []);
		return (await this.#rows(p.ownerId)).filter((r) => r.url || r.kind === "native").map((r) => ({
			id: r.id,
			// A connection to a directory entry the deployment no longer offers can only be disconnected.
			app: r.app_ref && directory.some((d) => d.ref === r.app_ref) ? r.app_ref : null,
			name: r.name,
			url: r.url ?? "",
			state: r.status === "auth_required" ? "authenticating" : r.status === "connected" ? "ready" : r.error ? "failed" : "ready",
			error: r.error ?? (r.app_ref && !directory.some((d) => d.ref === r.app_ref) ? "This Pim no longer offers it." : null),
			authUrl: r.status === "auth_required" ? r.auth_url : null,
			approval: r.approval,
			agents: agents.filter((a) => a.apps.includes(r.id) || (r.app_ref !== null && a.apps.includes(r.app_ref)) || a.apps.includes(r.name)).map((a) => a.id),
			tools: r.discovered_tools.map((t) => ({ name: t.name })),
		}));
	}

	/**
	 * Connects a directory entry (or a server by its address): a failed or abandoned connection to it is cleared, then the sign-in starts. A server that needs none is connected at once.
	 * Answers where to send the person, or how it stands.
	 */
	async connect(p: Principal, origin: string, target: { ref: string; name: string; url: string | null } | { url: string; name?: string; credential?: string }, directory: readonly DirectoryApp[] = []): Promise<{ id: string; state: "ready" | "authenticating" | "failed"; authUrl?: string; error?: string }> {
		await this.app.identity.authz.enforce(p, "api:write");
		if (p.kind !== "user" && p.kind !== "token") throw new BadRequestError("Only a person connects a connector.");
		const ref = "ref" in target ? target.ref : null;
		const native = ref ? nativeApp(ref) : undefined;
		if (ref && !directory.some((d) => d.ref === ref)) throw new BadRequestError(this.notOffered(ref) ?? "app must be the id of a connector this Pim offers");
		if (ref) {
			const existing = (await this.#rows(p.ownerId)).find((r) => r.app_ref === ref);
			if (existing && existing.status === "connected") return { id: existing.id, state: "ready" };
			if (existing) await this.app.connectors.remove(p, existing.id);
		}
		const name = (("name" in target && target.name) || (native ? native.name : new URL((target as { url: string }).url).host)).slice(0, 100);
		const { connector } = await this.app.connectors.create(p, native ? { kind: "native", name } : { kind: "custom_mcp", name, url: target.url!, ...("credential" in target && target.credential ? { credential: target.credential } : {}) });
		if (ref) await this.app.db.owner(p.ownerId, (tx) => tx.query("UPDATE pim_app.connectors SET app_ref = $2 WHERE id = $1", [connector.id, ref]));
		try {
			if (native) return { id: connector.id, ...(await this.#startNative(p, origin, native, connector.id)) };
			return { id: connector.id, ...(await this.#startMcp(p, origin, connector.id, target.url!, ref ? POPULAR_APPS.find((a) => `pim.apps/${a.id}` === ref)?.client : undefined, "credential" in target && !!target.credential)) };
		} catch (error) {
			// The connection is kept, so the person sees what went wrong and can try again.
			await this.#signIn(p.ownerId, connector.id, { status: "disconnected", error: message(error) });
			return { id: connector.id, state: "failed", error: message(error) };
		}
	}

	async #startNative(p: Principal, origin: string, native: NativeApp, id: string) {
		const missing = missingSettings(native, this.env);
		if (missing.length) throw new CapabilityUnavailableError(native.name, `its admin must set ${missing.join(", ")}`);
		const endpoints = endpointsOf(this.env);
		const verifier = newVerifier();
		const redirectUri = `${origin}${NATIVE_CALLBACK}`;
		const pending: Pending = { mode: "native", owner: p.ownerId, connector: id, verifier, redirectUri, tokenEndpoint: native.tokenUrl(endpoints), clientId: this.env[native.client.id]!, clientSecret: this.env[native.client.secret]! };
		const state = await this.app.signin.startFlow("oauth", pending, SIGN_IN_MS);
		const url = authorizeUrl(native.authorizeUrl(endpoints), { clientId: pending.clientId, redirectUri, scope: native.scopes.join(" "), state, verifier, ...(native.authorizeParams ? { extra: native.authorizeParams } : {}) });
		await this.#signIn(p.ownerId, id, { status: "auth_required", authUrl: url });
		return { state: "authenticating" as const, authUrl: url };
	}

	async #startMcp(p: Principal, origin: string, id: string, url: string, client: "metadata-document" | { id: string; secret: string } | undefined, hasCredential: boolean) {
		// A token the person gave stands in for a sign-in; a server that wants none is simply connected.
		const found = hasCredential ? { open: true as const } : await probe(this.transport, url);
		if (found.open) return { state: "ready" as const, ...(await this.#discoverAll(p.ownerId, id)) };
		const server = await discover(this.transport, url, found);
		const redirectUri = `${origin}/mcp/callback/${p.ownerId}`;
		let registered: { client_id: string; client_secret?: string };
		if (typeof client === "object") registered = { client_id: this.env[client.id]!, client_secret: this.env[client.secret]! };
		else if (client === "metadata-document") registered = { client_id: `${origin}/mcp/client/${p.ownerId}` };
		else if (server.registration_endpoint) registered = await registerClient(this.transport, server.registration_endpoint, redirectUri);
		else throw new Error("The server's sign-in does not let Pim register, and this Pim has no client for it. Connect it with a token instead.");
		const verifier = newVerifier();
		const scope = found.scope ?? (server.scopes_supported?.length ? server.scopes_supported.join(" ") : undefined);
		const pending: Pending = { mode: "mcp", owner: p.ownerId, connector: id, verifier, redirectUri, tokenEndpoint: server.token_endpoint, clientId: registered.client_id, ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}), resource: server.resource };
		const state = await this.app.signin.startFlow("oauth", pending, SIGN_IN_MS);
		const authUrl = authorizeUrl(server.authorization_endpoint, { clientId: registered.client_id, redirectUri, ...(scope ? { scope } : {}), state, verifier, resource: server.resource });
		await this.#signIn(p.ownerId, id, { status: "auth_required", authUrl });
		return { state: "authenticating" as const, authUrl };
	}

	/** Where a connection's sign-in stands: waiting for the person (`authUrl`), failed (`error`), or neither. */
	async #signIn(ownerId: string, id: string, state: { status: "auth_required" | "disconnected"; authUrl?: string | null; error?: string | null }): Promise<void> {
		await this.app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.connectors SET status = $2, auth_url = $3, error = $4 WHERE id = $1", [id, state.status, state.authUrl ?? null, state.error ?? null]));
	}

	/** Records a connector's tools and switches them on at its approval policy: a person who connects a service means to use it, and each tool is still Off, Ask or On from Settings. */
	async #discoverAll(ownerId: string, id: string): Promise<{ error?: string }> {
		const row = (await this.#rows(ownerId)).find((r) => r.id === id);
		if (!row) throw new NotFoundError("No such connector");
		const native = row.kind === "native" ? nativeApp(row.app_ref ?? "") : undefined;
		let tools: Tool[];
		try {
			tools = native
				? native.tools.map((t) => ({ name: t.name, description: t.description.slice(0, 500), ...(t.readOnly || t.destructive ? { annotations: { ...(t.readOnly ? { readOnlyHint: true } : {}), ...(t.destructive ? { destructiveHint: true } : {}) } } : {}) }))
				: await mcpFetchTools(this.transport)(row.url!, row.credential ? await openString(this.app.crypto, row.credential, `connector:${ownerId}/${id}`) : null);
		} catch (error) {
			await this.#signIn(ownerId, id, { status: "disconnected", error: message(error) });
			return { error: message(error) };
		}
		await this.app.connectors.recordDiscovery(ownerId, id, tools);
		await this.app.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.connectors SET enabled_tools = $2, status = CASE WHEN credential IS NULL AND kind = 'native' THEN status ELSE 'connected' END, auth_url = NULL, error = NULL WHERE id = $1", [id, tools.map((t) => t.name)]));
		return {};
	}

	/**
	 * The service sends the browser back with `state` and a code (or an error). The state is the sign-in's own secret, good once, so a return nobody started finds nothing; one that
	 * arrives in a browser signed in as someone else is refused. Answers the connector's name, or why it did not connect.
	 */
	async finish(params: URLSearchParams, viewer: Principal | null): Promise<{ name: string; id: string } | { error: string }> {
		const pending = await this.app.signin.flow<Pending>(params.get("state") ?? undefined, "oauth", { consume: true });
		if (!pending || pending.mode === undefined) return { error: "This sign-in expired, or was already used. Connect it again from Connectors." };
		if (viewer && viewer.ownerId !== pending.owner) return { error: "This sign-in was started by someone else's Pim account." };
		const id = pending.connector;
		const fail = async (why: string) => (await this.#signIn(pending.owner, id, { status: "disconnected", error: why }).catch(() => undefined), { error: why });
		try {
			await this.app.identity.authz.requireLive(pending.owner);
			const row = (await this.#rows(pending.owner)).find((r) => r.id === id);
			if (!row) return { error: "That connection was removed before the sign-in finished." };
			const denied = params.get("error");
			if (denied) return await fail(serviceError(params.get("error_description") ?? denied));
			const code = params.get("code");
			if (!code) return await fail("The sign-in came back without a code.");
			const native = pending.mode === "native" ? nativeApp(row.app_ref ?? "") : undefined;
			const answer = await tokenRequest(this.transport.fetch, pending.tokenEndpoint, { grant_type: "authorization_code", code, redirect_uri: pending.redirectUri, code_verifier: pending.verifier, client_id: pending.clientId, ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}), ...(pending.resource ? { resource: pending.resource } : {}) });
			const bundle = bundleOf(answer, { token_endpoint: pending.tokenEndpoint, client_id: pending.clientId, ...(pending.clientSecret ? { client_secret: pending.clientSecret } : {}) }, this.now());
			if (native?.check) {
				const problem = native.check(String(bundle.scope ?? "").split(/\s+/).filter(Boolean), bundle.refresh_token);
				if (problem) {
					await this.#revoke(native, bundle);
					return await fail(problem);
				}
			}
			await this.app.connectors.setCredential(pending.owner, id, JSON.stringify(bundle));
			const found = await this.#discoverAll(pending.owner, id);
			if (found.error) return { error: found.error };
			return { name: row.name, id };
		} catch (error) {
			return fail(error instanceof GrantGone || error instanceof ApiError ? error.message : message(error));
		}
	}

	async #revoke(native: NativeApp, bundle: Bundle): Promise<void> {
		const url = native.revokeUrl?.(endpointsOf(this.env));
		const token = bundle.refresh_token ?? bundle.access_token;
		if (!url || !token) return;
		await this.transport.fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000), redirect: "manual" }).then((r) => r.body?.cancel()).catch(() => undefined);
	}

	/** Ends a connection: Pim forgets it at once, and a native connector's grant is revoked at its service if it can be (whether or not that works, the connection is gone). */
	async disconnect(p: Principal, id: string): Promise<void> {
		await this.app.identity.authz.enforce(p, "api:write");
		const row = (await this.#rows(p.ownerId)).find((r) => r.id === id);
		if (!row) throw new NotFoundError("No such connector");
		const native = row.kind === "native" ? nativeApp(row.app_ref ?? "") : undefined;
		const credential = row.credential && native?.revokeUrl ? await openString(this.app.crypto, row.credential, `connector:${p.ownerId}/${id}`).catch(() => null) : null;
		await this.app.connectors.remove(p, id);
		if (native && credential) await this.#revoke(native, parseCredential(credential).bundle ?? { access_token: credential });
	}

	// ---- a connector's own actions, for the person in their browser ----

	/** The credential, renewed if it is about to expire, and what to call to change it. */
	async #open(ownerId: string, row: Row): Promise<{ bundle: Bundle; update: (change: (b: Record<string, unknown>) => Record<string, unknown>) => Promise<void> }> {
		const aad = `connector:${ownerId}/${row.id}`;
		const stored = row.credential ? await openString(this.app.crypto, row.credential, aad) : null;
		const parsed = stored ? parseCredential(stored).bundle : null;
		if (!parsed) throw new BadRequestError("Connect it first.");
		let bundle: Bundle = parsed;
		if (bundle.expires_at !== undefined && bundle.expires_at <= this.now() + 60_000) {
			const renewed = await refresh(bundle as never, this.transport.fetch, this.now());
			if (!renewed) throw new BadRequestError("The sign-in expired. Connect it again from Connectors.");
			bundle = renewed as Bundle;
			await this.app.connectors.setCredential(ownerId, row.id, JSON.stringify(bundle));
		}
		return { bundle, update: async (change) => { bundle = change(bundle) as Bundle; await this.app.connectors.setCredential(ownerId, row.id, JSON.stringify(bundle)); } };
	}

	/** One of a native connector's actions (Drive's file picker): the person's own, in their own signed-in browser. */
	async act(p: Principal, ref: string, action: string, input: Record<string, unknown>): Promise<unknown> {
		await this.app.identity.authz.enforce(p, "api:write");
		const native = nativeApp(ref);
		const run = native?.actions?.[action];
		if (!native || !run) throw new NotFoundError(`${ref} has no action ${action}`);
		const row = (await this.#rows(p.ownerId)).find((r) => r.app_ref === ref && r.status === "connected");
		if (!row) throw new BadRequestError(`${native.name} isn't connected.`);
		const { bundle, update } = await this.#open(p.ownerId, row);
		return run(input, { bearer: bundle.access_token, bundle, endpoints: endpointsOf(this.env), fetch: this.transport.fetch, env: this.env, update });
	}

	/** Which tools ask first by default: those that do not declare themselves read-only (`writes`), every tool (`all`), or none. */
	async setApproval(p: Principal, id: string, approval: string): Promise<void> {
		await this.app.identity.authz.enforce(p, "api:write");
		if (!["writes", "all", "none"].includes(approval)) throw new BadRequestError("approval must be one of writes, all, none");
		const n = await this.app.db.owner(p.ownerId, async (tx) => (await tx.query("UPDATE pim_app.connectors SET approval = $2 WHERE id = $1", [id, approval])).rowCount);
		if (!n) throw new NotFoundError("No such connector");
	}
}

const serviceError = (text: string) => text.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 300) || "The sign-in was refused.";
