import type { AppCredential, AppSecrets, AppSignInContext, NativeAppDefinition, ToolWidget } from "./define";
import type { McpCallResult, McpToolInfo } from "./mcp";

/**
 * The person's connections to apps extensions implement themselves (see
 * `NativeAppDefinition`): one per app, with its sign-in and credential, in
 * this Pim's database. The Pim's bridge lists them and their tools beside
 * the MCP servers', so everything else treats both alike.
 *
 * Sign-in: `connect` asks the app where to send the person, with a `state`
 * of `<owner>.<nonce>`; they come back to `/mcp/callback/apps`, one address
 * for everyone (which services like Spotify need registered), and the Worker
 * finds their Pim by the owner in `state`.
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

type Row = Record<string, SqlStorageValue>;

export type NativeAppsHost = {
	readonly sql: SqlStorage;
	/** The installed app, by `<extension>/<app>`. */
	app(ref: string): NativeAppDefinition | undefined;
	secrets(app: NativeAppDefinition): AppSecrets;
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class NativeApps {
	readonly #host: NativeAppsHost;
	/** One renewal per connection at a time: concurrent calls wait for the same one. */
	readonly #refreshing = new Map<string, Promise<AppCredential>>();

	constructor(host: NativeAppsHost) {
		this.#host = host;
		host.sql.exec(SCHEMA);
	}

	#rows(): Row[] {
		return this.#host.sql.exec("SELECT * FROM pim_app_connections ORDER BY created_at, id").toArray();
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
				...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
			}));
		});
	}

	/** Starts the person's sign-in to `ref` under the connection id `id`: where to send them. */
	async connect(ref: string, id: string): Promise<{ id: string; state: string; authUrl: string }> {
		const app = this.#host.app(ref);
		if (!app) throw new Error(`No installed app ${ref}`);
		const state = `${this.#host.owner()}.${crypto.randomUUID().replaceAll("-", "")}`;
		const { url, pending } = await app.signIn({ callbackUrl: this.#host.callbackUrl(), state, secrets: this.#host.secrets(app) });
		this.#host.sql.exec(
			"INSERT INTO pim_app_connections (id, app, name, state, sign_in_state, pending, auth_url, created_at) VALUES (?, ?, ?, 'authenticating', ?, ?, ?, ?)",
			id,
			ref,
			app.name,
			state,
			JSON.stringify(pending ?? null),
			url,
			Date.now(),
		);
		this.#host.changed();
		return { id, state: "authenticating", authUrl: url };
	}

	/** The person came back from signing in: their connection is ready, or failed with the app's reason. */
	async finish(url: URL): Promise<{ name: string } | { error: string }> {
		const state = url.searchParams.get("state");
		const [row] = state ? this.#host.sql.exec("SELECT * FROM pim_app_connections WHERE sign_in_state = ?", state).toArray() : [];
		if (!row) return { error: "This sign-in expired, or was finished already. Connect the app again." };
		const id = String(row.id);
		const app = this.#host.app(String(row.app));
		try {
			if (!app) throw new Error("This Pim no longer offers it.");
			const credential = await app.callback({
				callbackUrl: this.#host.callbackUrl(),
				state: state!,
				secrets: this.#host.secrets(app),
				url,
				pending: JSON.parse(String(row.pending)),
			});
			this.#host.sql.exec(
				"UPDATE pim_app_connections SET state = 'ready', credential = ?, sign_in_state = NULL, pending = NULL, auth_url = NULL, error = NULL WHERE id = ?",
				JSON.stringify(credential),
				id,
			);
			return { name: String(row.name) };
		} catch (error) {
			this.#fail(id, message(error));
			return { error: message(error) };
		} finally {
			this.#host.changed();
		}
	}

	/** Runs one of a ready connection's tools with the person's credential, renewed first when it is about to expire. */
	async call(id: string, name: string, args: Record<string, unknown>): Promise<McpCallResult & { widget?: ToolWidget }> {
		const [row] = this.#host.sql.exec("SELECT * FROM pim_app_connections WHERE id = ?", id).toArray();
		const app = row ? this.#host.app(String(row.app)) : undefined;
		const tool = app?.tools.find((candidate) => candidate.name === name);
		if (!row || !app || !tool || row.state !== "ready") return { content: [{ type: "text", text: `${name} isn't available right now.` }], isError: true };
		let credential: AppCredential;
		try {
			credential = await this.#fresh(id, app, JSON.parse(String(row.credential)) as AppCredential);
		} catch (error) {
			this.#fail(id, `Sign in again: ${message(error)}`);
			this.#host.changed();
			return { content: [{ type: "text", text: `${app.name} needs the person to connect it again from the Apps page.` }], isError: true };
		}
		try {
			const result = await tool.execute(args, { credential, secrets: this.#host.secrets(app) });
			if (typeof result === "string") return { content: [{ type: "text", text: result }] };
			return {
				content: [{ type: "text", text: result.text }],
				...(result.isError ? { isError: true } : {}),
				...(result.widget ? { widget: result.widget } : {}),
			};
		} catch (error) {
			return { content: [{ type: "text", text: message(error) }], isError: true };
		}
	}

	remove(id: string): boolean {
		const removed = this.#host.sql.exec("DELETE FROM pim_app_connections WHERE id = ?", id).rowsWritten > 0;
		if (removed) this.#host.changed();
		return removed;
	}

	#fail(id: string, error: string): void {
		this.#host.sql.exec(
			"UPDATE pim_app_connections SET state = 'failed', error = ?, sign_in_state = NULL, pending = NULL, auth_url = NULL WHERE id = ?",
			error,
			id,
		);
	}

	async #fresh(id: string, app: NativeAppDefinition, credential: AppCredential): Promise<AppCredential> {
		if (credential.expiresAt === undefined || credential.expiresAt - REFRESH_MARGIN_MS > Date.now()) return credential;
		if (!app.refresh) throw new Error("the sign-in expired");
		const running = this.#refreshing.get(id);
		if (running) return running;
		const work = app
			.refresh(credential, { secrets: this.#host.secrets(app) })
			.then((renewed) => {
				this.#host.sql.exec("UPDATE pim_app_connections SET credential = ? WHERE id = ?", JSON.stringify(renewed), id);
				return renewed;
			})
			.finally(() => this.#refreshing.delete(id));
		this.#refreshing.set(id, work);
		return work;
	}
}

/** Base64url without padding, as PKCE wants. */
function base64url(bytes: Uint8Array): string {
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string };

/**
 * The sign-in of an app whose service speaks OAuth 2.0: the authorization
 * code flow with PKCE, and refresh tokens. `clientId` and `clientSecret`
 * name the secrets that hold them, which the app lists in its `secrets`.
 * The credential is `{ accessToken, refreshToken?, expiresAt? }`.
 */
export function oauth2(options: {
	readonly authorizeUrl: string;
	readonly tokenUrl: string;
	readonly scopes: readonly string[];
	readonly clientId: string;
	readonly clientSecret?: string;
}): Pick<NativeAppDefinition, "signIn" | "callback" | "refresh"> {
	const token = async (secrets: AppSecrets, params: Record<string, string>): Promise<AppCredential> => {
		const body = new URLSearchParams(params);
		const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
		const id = secrets[options.clientId] ?? "";
		if (options.clientSecret) headers.authorization = `Basic ${btoa(`${id}:${secrets[options.clientSecret] ?? ""}`)}`;
		else body.set("client_id", id);
		const response = await fetch(options.tokenUrl, { method: "POST", headers, body });
		const answer = (await response.json().catch(() => ({}))) as TokenResponse;
		if (!response.ok || !answer.access_token) {
			throw new Error(answer.error_description ?? answer.error ?? `The token endpoint answered ${response.status}`);
		}
		return {
			accessToken: answer.access_token,
			...(answer.refresh_token ? { refreshToken: answer.refresh_token } : {}),
			...(answer.expires_in ? { expiresAt: Date.now() + answer.expires_in * 1000 } : {}),
		};
	};
	return {
		async signIn({ callbackUrl, state, secrets }: AppSignInContext) {
			const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
			const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
			const url = new URL(options.authorizeUrl);
			url.search = new URLSearchParams({
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
			if (typeof credential.refreshToken !== "string") throw new Error("the sign-in expired");
			const renewed = await token(secrets, { grant_type: "refresh_token", refresh_token: credential.refreshToken });
			// Services may keep the refresh token the same and leave it out.
			return { refreshToken: credential.refreshToken, ...renewed };
		},
	};
}
