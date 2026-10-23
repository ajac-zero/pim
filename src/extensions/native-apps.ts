import { base64UrlDecode, base64UrlEncode } from "../auth/encoding";
import type { AppCredential, AppSecrets, AppSignInContext, AppToolContext, NativeAppDefinition, ToolWidget } from "./define";
import type { McpCallResult, McpToolInfo } from "./mcp";

/**
 * The person's connections to apps extensions implement themselves (see
 * `NativeAppDefinition`): one per app, with its sign-in and credential, in
 * this space's database. The space's bridge lists them and their tools beside
 * the MCP servers', so everything else treats both alike.
 *
 * Sign-in: `connect` asks the app where to send the person, with a `state`
 * of `<owner>.<nonce>`; they come back to `/mcp/callback/apps`, one address
 * for everyone (which services like Spotify need registered), and the Worker
 * finds their space by the owner in `state`. The Worker hands the return on
 * only from a browser signed in as that owner, so a sign-in someone else
 * started can't land in their space. A sign-in is good for
 * `SIGN_IN_TTL_MS`, and finishes once.
 *
 * Credentials and sign-ins under way are encrypted with the deployment's
 * `APP_CREDENTIALS_KEY` once it is set, bound to the owner, the connection
 * and the app, so one can't be read elsewhere or moved to another
 * connection. Ones kept before the key was set are encrypted when next used.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_app_connections (
	id TEXT PRIMARY KEY,
	app TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	state TEXT NOT NULL,
	credential TEXT,
	sign_in_state TEXT,
	pending TEXT,
	auth_url TEXT,
	error TEXT,
	created_at INTEGER NOT NULL
);
`;

/** How long before it expires a credential is renewed. */
const REFRESH_MARGIN_MS = 60_000;

/** How long a person has to finish signing in, from when they started. */
export const SIGN_IN_TTL_MS = 15 * 60_000;

/** How long revoking a grant at the service may take before Pim gives up on it. */
const REVOKE_TIMEOUT_MS = 10_000;

/** What an encrypted value starts with; plain JSON never does. */
const ENCRYPTED = "sealed:v1:";

type Row = Record<string, SqlStorageValue>;

/**
 * One sign-in of a connection: its id and app, and the random generation
 * every sign-in gets. A connection removed and made again under the same id
 * is a new generation, so work begun on the old one (a call, an action, a
 * renewal) can't read, renew or change the new one's credential.
 */
type Sign = { readonly id: string; readonly app: string; readonly generation: string };

const signOf = (row: Row): Sign => ({ id: String(row.id), app: String(row.app), generation: String(row.generation) });

const newGeneration = () => base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));

export type NativeAppsHost = {
	readonly sql: SqlStorage;
	/** The installed app, by `<extension>/<app>`. */
	app(ref: string): NativeAppDefinition | undefined;
	secrets(app: NativeAppDefinition): AppSecrets;
	/** The deployment's `APP_CREDENTIALS_KEY`, if it is set. */
	credentialsKey(): string | null;
	/** `/mcp/callback/apps` on this Pim's public address. */
	callbackUrl(): string;
	owner(): string;
	/** A connection was made, signed in, failed or removed: the tools change. */
	changed(): void;
};

/** A native app's connection, as the bridge lists servers. */
export type NativeConnection = {
	readonly id: string;
	/** The app it connects, `<extension>/<app>`. */
	readonly app: string;
	readonly name: string;
	readonly state: "authenticating" | "ready" | "failed";
	readonly error: string | null;
	readonly authUrl: string | null;
};

/**
 * Thrown by an app's `callback`, `refresh` or tools when the person's grant
 * is gone: revoked, expired, or never renewable. Pim forgets the credential,
 * shows the app as failed with this message, and the person connects it
 * again. Any other error is passing: the connection stays, and the next call
 * tries again.
 */
export class ReconnectRequired extends Error {
	override readonly name = "ReconnectRequired";
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A credential as stored, and as read. */
type Stored = { readonly stored: string; readonly credential: AppCredential };

const keys = new Map<string, Promise<CryptoKey>>();

/** The AES-GCM key `APP_CREDENTIALS_KEY` holds, imported once per isolate. */
function importKey(raw: string): Promise<CryptoKey> {
	let key = keys.get(raw);
	if (!key) {
		key = (async () => {
			let bytes: Uint8Array<ArrayBuffer>;
			try {
				bytes = base64UrlDecode(raw.trim());
			} catch {
				bytes = new Uint8Array();
			}
			if (bytes.length !== 32) throw new Error("This Pim's APP_CREDENTIALS_KEY must be 32 random bytes in base64, such as `openssl rand -base64 32` makes.");
			return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
		})();
		keys.set(raw, key);
	}
	return key;
}

export class NativeApps {
	readonly #host: NativeAppsHost;
	/** One renewal per sign-in at a time, by generation: concurrent calls wait for the same one. */
	readonly #refreshing = new Map<string, Promise<Stored>>();
	/** Sign-ins being finished now, by state: the same return arriving twice finishes once. */
	readonly #finishing = new Set<string>();

	constructor(host: NativeAppsHost) {
		this.#host = host;
		host.sql.exec(SCHEMA);
		// Connections made before generations existed get one each.
		const columns = host.sql.exec("PRAGMA table_info(pim_app_connections)").toArray();
		if (!columns.some((column) => column.name === "generation")) host.sql.exec("ALTER TABLE pim_app_connections ADD COLUMN generation TEXT");
		for (const row of host.sql.exec("SELECT id FROM pim_app_connections WHERE generation IS NULL").toArray()) {
			host.sql.exec("UPDATE pim_app_connections SET generation = ? WHERE id = ? AND generation IS NULL", newGeneration(), row.id);
		}
	}

	#rows(): Row[] {
		return this.#host.sql.exec("SELECT * FROM pim_app_connections ORDER BY created_at, id").toArray();
	}

	#row(id: string): Row | undefined {
		return this.#host.sql.exec("SELECT * FROM pim_app_connections WHERE id = ?", id).toArray()[0];
	}

	connections(): NativeConnection[] {
		return this.#rows().map((row) => ({
			id: String(row.id),
			app: String(row.app),
			name: String(row.name),
			state: String(row.state) as NativeConnection["state"],
			// An app the deployment took out can't be used.
			error: this.#host.app(String(row.app)) ? (row.error === null ? null : String(row.error)) : "This Pim no longer offers it.",
			authUrl: row.auth_url === null ? null : String(row.auth_url),
		}));
	}

	has(id: string): boolean {
		return this.#host.sql.exec("SELECT 1 FROM pim_app_connections WHERE id = ?", id).toArray().length > 0;
	}

	/** The ready connections' tools, as the bridge lists MCP tools. */
	tools(): McpToolInfo[] {
		return this.#rows().flatMap((row) => {
			const app = this.#host.app(String(row.app));
			if (!app || row.state !== "ready") return [];
			return app.tools.map((tool) => ({
				serverId: String(row.id),
				name: tool.name,
				description: tool.description,
				inputSchema: tool.parameters as unknown as Record<string, unknown>,
				...(tool.readOnly || tool.destructive ? { annotations: {
					...(tool.readOnly ? { readOnlyHint: true } : {}),
					...(tool.destructive ? { destructiveHint: true } : {}),
				} } : {}),
			}));
		});
	}

	/** Starts the person's sign-in to `ref` under the connection id `id`: where to send them. */
	async connect(ref: string, id: string): Promise<{ id: string; state: string; authUrl: string }> {
		const app = this.#host.app(ref);
		if (!app) throw new Error(`No installed app ${ref}`);
		const state = `${this.#host.owner()}.${base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)))}`;
		const { url, pending } = await app.signIn({ callbackUrl: this.#host.callbackUrl(), state, secrets: this.#host.secrets(app) });
		const kept = await this.#encrypt(app, { id, app: ref }, "pending", pending ?? null);
		this.#host.sql.exec(
			"INSERT INTO pim_app_connections (id, app, name, state, sign_in_state, pending, auth_url, created_at, generation) VALUES (?, ?, ?, 'authenticating', ?, ?, ?, ?, ?)",
			id,
			ref,
			app.name,
			state,
			kept,
			url,
			Date.now(),
			newGeneration(),
		);
		this.#host.changed();
		return { id, state: "authenticating", authUrl: url };
	}

	/**
	 * The person came back from signing in to `url`: their connection is
	 * ready, or failed with the app's reason. The Worker checked they are
	 * signed in as this space's owner.
	 */
	async finish(url: URL): Promise<{ name: string } | { error: string }> {
		const state = url.searchParams.get("state");
		const [row] = state && !this.#finishing.has(state) ? this.#host.sql.exec("SELECT * FROM pim_app_connections WHERE sign_in_state = ?", state).toArray() : [];
		if (!state || !row) return { error: "This sign-in expired, or was finished already. Connect the app again." };
		const id = String(row.id);
		const ref = String(row.app);
		if (Number(row.created_at) + SIGN_IN_TTL_MS < Date.now()) {
			this.#fail(id, "The sign-in took too long. Connect the app again.");
			this.#host.changed();
			return { error: "This sign-in expired. Connect the app again." };
		}
		const app = this.#host.app(ref);
		this.#finishing.add(state);
		try {
			if (!app) throw new Error("This Pim no longer offers it.");
			const pending = await this.#decrypt({ id, app: ref }, "pending", String(row.pending));
			const credential = await app.callback({ callbackUrl: this.#host.callbackUrl(), state, secrets: this.#host.secrets(app), url, pending });
			const kept = await this.#encrypt(app, { id, app: ref }, "credential", credential);
			// The same sign-in, unless the person disconnected meanwhile.
			const written = this.#host.sql.exec(
				"UPDATE pim_app_connections SET state = 'ready', credential = ?, sign_in_state = NULL, pending = NULL, auth_url = NULL, error = NULL WHERE id = ? AND sign_in_state = ?",
				kept,
				id,
				state,
			).rowsWritten;
			if (written === 0) {
				void this.#revoke(app, credential);
				return { error: `${app.name} was disconnected while signing in.` };
			}
			return { name: String(row.name) };
		} catch (error) {
			this.#host.sql.exec(
				"UPDATE pim_app_connections SET state = 'failed', error = ?, credential = NULL, sign_in_state = NULL, pending = NULL, auth_url = NULL WHERE id = ? AND sign_in_state = ?",
				message(error),
				id,
				state,
			);
			return { error: message(error) };
		} finally {
			this.#finishing.delete(state);
			this.#host.changed();
		}
	}

	/** Runs one of a ready connection's tools with the person's credential, renewed first when it is about to expire. */
	async call(id: string, name: string, args: Record<string, unknown>): Promise<McpCallResult & { widget?: ToolWidget }> {
		const row = this.#row(id);
		const app = row ? this.#host.app(String(row.app)) : undefined;
		const tool = app?.tools.find((candidate) => candidate.name === name);
		if (!row || !app || !tool || row.state !== "ready") return { content: [{ type: "text", text: `${name} isn't available right now.` }], isError: true };
		const sign = signOf(row);
		let current: Stored;
		try {
			current = await this.#fresh(sign, app, row);
		} catch (error) {
			if (error instanceof ReconnectRequired) return this.#reconnect(sign, app, error);
			return { content: [{ type: "text", text: `${app.name} couldn't renew its sign-in just now (${message(error)}). Try again in a moment.` }], isError: true };
		}
		const context: AppToolContext = {
			credential: current.credential,
			secrets: this.#host.secrets(app),
			renew: async () => (current = await this.#renew(sign, app, current.stored)).credential,
		};
		try {
			const result = await tool.execute(args, context);
			if (typeof result === "string") return { content: [{ type: "text", text: result }] };
			return {
				content: [{ type: "text", text: result.text }],
				...(result.isError ? { isError: true } : {}),
				...(result.widget ? { widget: result.widget } : {}),
			};
		} catch (error) {
			if (error instanceof ReconnectRequired) return this.#reconnect(sign, app, error);
			return { content: [{ type: "text", text: message(error) }], isError: true };
		}
	}

	/**
	 * Runs one of an app's actions (`NativeAppDefinition.actions`) for the
	 * person, with their ready connection to it. The caller checked it is the
	 * person, in their own browser. Throws what the person should read.
	 */
	async act(ref: string, name: string, input: Record<string, unknown>): Promise<unknown> {
		const row = this.#host.sql.exec("SELECT * FROM pim_app_connections WHERE app = ?", ref).toArray()[0];
		const app = this.#host.app(ref);
		const action = app?.actions && Object.hasOwn(app.actions, name) ? app.actions[name] : undefined;
		if (!app || !action) throw new Error(`${ref} has no action ${name}`);
		if (!row || row.state !== "ready") throw new Error(`Connect ${app.name} first, from the Apps page.`);
		const sign = signOf(row);
		let current: Stored;
		try {
			current = await this.#fresh(sign, app, row);
		} catch (error) {
			if (error instanceof ReconnectRequired) this.#reconnect(sign, app, error);
			throw error;
		}
		try {
			return await action(input, {
				credential: current.credential,
				secrets: this.#host.secrets(app),
				renew: async () => (current = await this.#renew(sign, app, current.stored)).credential,
				update: (change) => this.#update(sign, app, change),
			});
		} catch (error) {
			if (error instanceof ReconnectRequired) this.#reconnect(sign, app, error);
			throw error;
		}
	}

	/** The ready connection `sign` is a sign-in of, unless it was removed or made again since. */
	#current(sign: Sign, app: NativeAppDefinition): Row & { credential: string } {
		const row = this.#host.sql.exec("SELECT * FROM pim_app_connections WHERE id = ? AND generation = ?", sign.id, sign.generation).toArray()[0];
		if (!row || row.state !== "ready" || row.credential === null) throw new Error(`${app.name} was disconnected.`);
		return row as Row & { credential: string };
	}

	/** Applies `change` to the sign-in's latest credential, after any renewal under way, without undoing one that finishes meanwhile. */
	async #update(sign: Sign, app: NativeAppDefinition, change: (credential: AppCredential) => AppCredential): Promise<void> {
		for (let attempt = 0; attempt < 3; attempt++) {
			await this.#refreshing.get(sign.generation)?.catch(() => undefined);
			const stored = String(this.#current(sign, app).credential);
			const next = await this.#encrypt(app, sign, "credential", change((await this.#decrypt(sign, "credential", stored)) as AppCredential));
			const written = this.#host.sql.exec(
				"UPDATE pim_app_connections SET credential = ? WHERE id = ? AND generation = ? AND credential = ?",
				next,
				sign.id,
				sign.generation,
				stored,
			).rowsWritten;
			if (written > 0) return;
		}
		throw new Error(`${app.name} was busy renewing its sign-in. Try again.`);
	}

	/**
	 * Ends a connection: Pim forgets its credential at once, then asks the
	 * service to revoke the grant, if the app can. Whether that worked, the
	 * connection is gone.
	 */
	async remove(id: string): Promise<boolean> {
		const row = this.#row(id);
		if (!row) return false;
		this.#host.sql.exec("DELETE FROM pim_app_connections WHERE id = ?", id);
		this.#refreshing.delete(String(row.generation));
		this.#host.changed();
		await this.#revokeRow(row);
		return true;
	}

	/** Revokes every connection's grant at its service, for a space being erased; the erasure deletes the rows. */
	async revokeAll(): Promise<void> {
		await Promise.allSettled(this.#rows().map((row) => this.#revokeRow(row)));
	}

	async #revokeRow(row: Row): Promise<void> {
		const app = this.#host.app(String(row.app));
		if (!app?.revoke || row.credential === null) return;
		try {
			const credential = (await this.#decrypt({ id: String(row.id), app: String(row.app) }, "credential", String(row.credential))) as AppCredential;
			await this.#revoke(app, credential);
		} catch (error) {
			console.warn(`revoking ${String(row.app)}'s grant failed: ${message(error)}`);
		}
	}

	async #revoke(app: NativeAppDefinition, credential: AppCredential): Promise<void> {
		if (!app.revoke) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("the service took too long")), REVOKE_TIMEOUT_MS);
		});
		await Promise.race([app.revoke(credential, { secrets: this.#host.secrets(app) }), timeout])
			.catch((error) => console.warn(`revoking a grant to ${app.name} failed: ${message(error)}`))
			.finally(() => clearTimeout(timer));
	}

	/**
	 * The grant is gone: the sign-in fails, without its credential, until the
	 * person connects the app again. A connection they removed and made again
	 * meanwhile (which the removal's revocation can make the service refuse)
	 * is another sign-in, and is left alone.
	 */
	#reconnect(sign: Sign, app: NativeAppDefinition, error: ReconnectRequired): McpCallResult {
		const failed = this.#host.sql.exec(
			"UPDATE pim_app_connections SET state = 'failed', error = ?, credential = NULL, sign_in_state = NULL, pending = NULL, auth_url = NULL WHERE id = ? AND generation = ? AND state = 'ready'",
			`Sign in again: ${error.message}`,
			sign.id,
			sign.generation,
		).rowsWritten;
		if (failed > 0) {
			this.#refreshing.delete(sign.generation);
			this.#host.changed();
		}
		return { content: [{ type: "text", text: `${app.name} needs the person to connect it again from the Apps page.` }], isError: true };
	}

	#fail(id: string, error: string): void {
		this.#host.sql.exec(
			"UPDATE pim_app_connections SET state = 'failed', error = ?, credential = NULL, sign_in_state = NULL, pending = NULL, auth_url = NULL WHERE id = ?",
			error,
			id,
		);
	}

	/** The sign-in's credential, renewed first if it is about to expire, and encrypted if it was kept before the key was set. */
	async #fresh(sign: Sign, app: NativeAppDefinition, row: Row): Promise<Stored> {
		let stored = String(row.credential);
		const credential = (await this.#decrypt(sign, "credential", stored)) as AppCredential;
		if (!stored.startsWith(ENCRYPTED) && this.#host.credentialsKey() !== null) {
			const encrypted = await this.#encrypt(app, sign, "credential", credential);
			const written = this.#host.sql.exec(
				"UPDATE pim_app_connections SET credential = ? WHERE id = ? AND generation = ? AND credential = ?",
				encrypted,
				sign.id,
				sign.generation,
				stored,
			).rowsWritten;
			if (written > 0) stored = encrypted;
		}
		if (credential.expiresAt === undefined || credential.expiresAt - REFRESH_MARGIN_MS > Date.now()) return { stored, credential };
		return this.#renew(sign, app, stored);
	}

	/**
	 * Renews the sign-in's credential stored as `stale`, once however many
	 * calls ask: one that was renewed already comes back as it is now. Only
	 * ever this sign-in's: work begun on a connection removed or made again
	 * since fails, and gets nothing of the new one's.
	 */
	#renew(sign: Sign, app: NativeAppDefinition, stale: string): Promise<Stored> {
		const running = this.#refreshing.get(sign.generation);
		if (running) return running;
		const work = (async (): Promise<Stored> => {
			const latest = String(this.#current(sign, app).credential);
			const credential = (await this.#decrypt(sign, "credential", latest)) as AppCredential;
			// Renewed since (a renewal always sets a new expiry), rather than only changed by an action: use it.
			if (latest !== stale && credential.expiresAt !== ((await this.#decrypt(sign, "credential", stale)) as AppCredential).expiresAt) {
				return { stored: latest, credential };
			}
			if (!app.refresh) throw new ReconnectRequired("the sign-in expired.");
			const renewed = await app.refresh(credential, { secrets: this.#host.secrets(app) });
			const stored = await this.#encrypt(app, sign, "credential", renewed);
			const written = this.#host.sql.exec(
				"UPDATE pim_app_connections SET credential = ? WHERE id = ? AND generation = ? AND credential = ?",
				stored,
				sign.id,
				sign.generation,
				latest,
			).rowsWritten;
			if (written === 0) throw new Error(`${app.name} was disconnected.`);
			return { stored, credential: renewed };
		})().finally(() => {
			if (this.#refreshing.get(sign.generation) === work) this.#refreshing.delete(sign.generation);
		});
		this.#refreshing.set(sign.generation, work);
		return work;
	}

	/** What the database keeps for `value`: encrypted once the deployment has a key, required for apps that ask for it. */
	async #encrypt(app: NativeAppDefinition, where: { id: string; app: string }, purpose: "credential" | "pending", value: unknown): Promise<string> {
		const json = JSON.stringify(value);
		const raw = this.#host.credentialsKey();
		if (raw === null) {
			if (app.encrypted) throw new Error(`This Pim keeps ${app.name}'s sign-ins encrypted, and its APP_CREDENTIALS_KEY isn't set.`);
			return json;
		}
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.#binding(where, purpose) }, await importKey(raw), new TextEncoder().encode(json));
		return `${ENCRYPTED}${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(sealed))}`;
	}

	/** A value `#encrypt` kept, read back. One Pim can't read is a sign-in to make again. */
	async #decrypt(where: { id: string; app: string }, purpose: "credential" | "pending", stored: string): Promise<unknown> {
		if (!stored.startsWith(ENCRYPTED)) return JSON.parse(stored);
		const raw = this.#host.credentialsKey();
		if (raw === null) throw new ReconnectRequired("this Pim's APP_CREDENTIALS_KEY is no longer set.");
		const [iv = "", sealed = ""] = stored.slice(ENCRYPTED.length).split(".");
		try {
			const opened = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: base64UrlDecode(iv), additionalData: this.#binding(where, purpose) },
				await importKey(raw),
				base64UrlDecode(sealed),
			);
			return JSON.parse(new TextDecoder().decode(opened));
		} catch {
			throw new ReconnectRequired("Pim can no longer read this sign-in (APP_CREDENTIALS_KEY changed?).");
		}
	}

	/** What an encrypted value is bound to: this owner, connection and app, and what it is. */
	#binding(where: { id: string; app: string }, purpose: string): Uint8Array {
		return new TextEncoder().encode(["pim.app-credential.v1", this.#host.owner(), where.id, where.app, purpose].join("\n"));
	}
}

/** Base64url without padding, as PKCE wants. */
function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

/**
 * At most `maxBytes` of a response's body, and whether there was more; the
 * rest is never read. A declared length past the limit still gives the
 * first `maxBytes`, as a body without one does.
 */
export async function readBody(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = response.body?.getReader();
	if (!reader) return { bytes: new Uint8Array(), truncated: false };
	const chunks: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	while (!truncated) {
		const { done, value } = await reader.read();
		if (done) break;
		const room = maxBytes - size;
		chunks.push(value.length > room ? value.subarray(0, room) : value);
		size += Math.min(value.length, room);
		if (value.length > room) truncated = true;
	}
	if (truncated) await reader.cancel().catch(() => undefined);
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return { bytes, truncated };
}

/** A small JSON object from a service, such as a token or an error: `{}` when it is longer than `maxBytes`, or isn't one. */
export async function readJsonObject(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
	try {
		const { bytes, truncated } = await readBody(response, maxBytes);
		if (truncated) return {};
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** A service's own words, such as its error description, as one short line. */
export const serviceText = (text: string) =>
	text
		.slice(0, 1000)
		.replace(/[\u0000-\u001F\u007F]+/g, " ")
		.trim()
		.slice(0, 300);

/** The most bytes of a token endpoint's answer read. */
const TOKEN_BYTES = 64 * 1024;

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string; error_description?: string };

/** How long a token endpoint may take to answer. */
const TOKEN_TIMEOUT_MS = 15_000;

/**
 * The sign-in of an app whose service speaks OAuth 2.0: the authorization
 * code flow with PKCE, and refresh tokens. `clientId` and `clientSecret`
 * name the secrets that hold them, which the app lists in its `secrets`;
 * `authorizeParams` adds the service's own to the authorization URL. The
 * credential is `{ accessToken, refreshToken?, expiresAt?, scope? }`; a
 * renewal keeps the refresh token when the service leaves it out, and a
 * refused one (`invalid_grant`) means connecting again.
 */
export function oauth2(options: {
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly scopes: readonly string[];
	readonly clientId: string;
	readonly clientSecret?: string;
	readonly authorizeParams?: Readonly<Record<string, string>>;
}): Pick<NativeAppDefinition, "signIn" | "callback" | "refresh"> {
	const token = async (secrets: AppSecrets, params: Record<string, string>): Promise<AppCredential> => {
		const body = new URLSearchParams(params);
		const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
		const id = secrets[options.clientId] ?? "";
		if (options.clientSecret) headers.authorization = `Basic ${btoa(`${id}:${secrets[options.clientSecret] ?? ""}`)}`;
		else body.set("client_id", id);
		const response = await fetch(options.tokenUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
		const answer = (await readJsonObject(response, TOKEN_BYTES)) as TokenResponse;
		if (!response.ok || typeof answer.access_token !== "string") {
			const told = typeof answer.error_description === "string" ? answer.error_description : typeof answer.error === "string" ? answer.error : "";
			const reason = serviceText(told) || `The token endpoint answered ${response.status}`;
			// The grant was revoked, expired, or never was: only signing in again helps.
			throw answer.error === "invalid_grant" ? new ReconnectRequired(reason) : new Error(reason);
		}
		return {
			accessToken: answer.access_token,
			...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
			...(answer.expires_in ? { expiresAt: Date.now() + answer.expires_in * 1000 } : {}),
			...(typeof answer.scope === "string" ? { scope: answer.scope } : {}),
		};
	};
	return {
		async signIn({ callbackUrl, state, secrets }: AppSignInContext) {
			const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
			const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
			const url = new URL(options.authorizeUrl);
			url.search = new URLSearchParams({
				...options.authorizeParams,
				response_type: "code",
				client_id: secrets[options.clientId] ?? "",
				redirect_uri: callbackUrl,
				scope: options.scopes.join(" "),
				state,
				code_challenge: challenge,
				code_challenge_method: "S256",
			}).toString();
			return { url: url.toString(), pending: { verifier } };
		},
		async callback({ url, callbackUrl, secrets, pending }) {
			const error = url.searchParams.get("error");
			if (error) throw new Error(url.searchParams.get("error_description") ?? error);
			const code = url.searchParams.get("code");
			if (!code) throw new Error("The sign-in came back without a code.");
			return token(secrets, {
				grant_type: "authorization_code",
				code,
				redirect_uri: callbackUrl,
				code_verifier: (pending as { verifier: string }).verifier,
			});
		},
		async refresh(credential, { secrets }) {
			if (typeof credential.refreshToken !== "string") throw new ReconnectRequired("the sign-in expired.");
			const renewed = await token(secrets, { grant_type: "refresh_token", refresh_token: credential.refreshToken });
			// Services may keep the refresh token the same and leave it out; what else the app kept stays.
			const { expiresAt: _expired, ...kept } = credential;
			return { ...kept, ...renewed };
		},
	};
}
