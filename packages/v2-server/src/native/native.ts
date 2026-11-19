/**
 * The connectors Pim implements itself because their service has no MCP server of its own (Gmail, Google Drive, Spotify): each is an OAuth sign-in and a few tools that call the
 * service's API with the person's token. Ported from v1's `src/extensions/{gmail,google,google-drive,spotify}.ts`, minus the Cloudflare runtime and the widgets.
 *
 * A connector is offered once the deployment's environment holds its OAuth client (`GOOGLE_GMAIL_CLIENT_ID`/`_SECRET`, `GOOGLE_DRIVE_CLIENT_ID`/`_SECRET`, `SPOTIFY_CLIENT_ID`/`_SECRET`),
 * as in v1: with none set, the directory does not list it. The service's addresses can be pointed elsewhere (`PIM_GOOGLE_AUTH_URL`, `PIM_GOOGLE_TOKEN_URL`, `PIM_GOOGLE_REVOKE_URL`,
 * `PIM_GMAIL_API_URL`, `PIM_DRIVE_API_URL`, `PIM_SPOTIFY_AUTH_URL`, `PIM_SPOTIFY_TOKEN_URL`, `PIM_SPOTIFY_API_URL`): a proxy, or a stand-in in tests. The tools call only the configured API's origin.
 */
import type { TSchema } from "typebox";
import { driveApp } from "./drive.ts";
import { gmailApp } from "./gmail.ts";
import { spotifyApp } from "./spotify.ts";

export type Env = Readonly<Record<string, string | undefined>>;

export type Endpoints = {
	googleAuth: string;
	googleToken: string;
	googleRevoke: string;
	gmailApi: string;
	driveApi: string;
	spotifyAuth: string;
	spotifyToken: string;
	spotifyApi: string;
};

/** What a tool is given: the person's current access token, the credential's other fields (Drive's picked files), and where the service's API is. */
export type ToolContext = { readonly bearer: string; readonly bundle: Record<string, unknown>; readonly endpoints: Endpoints; readonly fetch: typeof fetch };

export type NativeTool = {
	readonly name: string;
	readonly description: string;
	/** A TypeBox schema, which is JSON Schema as it stands. */
	readonly parameters: TSchema;
	readonly readOnly?: boolean;
	readonly destructive?: boolean;
	execute(args: Record<string, any>, context: ToolContext): Promise<string>;
};

export type ActionContext = ToolContext & { readonly env: Env; update(change: (bundle: Record<string, unknown>) => Record<string, unknown>): Promise<void> };

/** What a native connector's sign-in and tools need. */
export type NativeApp = {
	/** `<extension>/<app>`: stored in people's agents, so never renamed. */
	readonly ref: string;
	readonly name: string;
	readonly description: string;
	readonly icon?: string;
	readonly category: string;
	/** The environment variables holding its OAuth client; it is offered once both are set. */
	readonly client: { readonly id: string; readonly secret: string };
	/** Other settings it needs before it is offered. */
	readonly needs?: readonly string[];
	readonly scopes: readonly string[];
	readonly authorizeUrl: (e: Endpoints) => string;
	readonly tokenUrl: (e: Endpoints) => string;
	readonly revokeUrl?: (e: Endpoints) => string;
	readonly authorizeParams?: Readonly<Record<string, string>>;
	/** Why a sign-in that granted more or less than the connector asks for is refused, or null to accept it. */
	readonly check?: (granted: readonly string[], refreshToken: string | undefined) => string | null;
	readonly tools: readonly NativeTool[];
	/** The person's own browser actions (Drive's file picker), run with the credential, which they may change. */
	readonly actions?: Readonly<Record<string, (input: Record<string, unknown>, context: ActionContext) => Promise<unknown>>>;
	/** The connector's page for the person once connected, and what its button says. */
	readonly page?: { readonly path: string; readonly label: { en: string; es: string } };
};

export const endpointsOf = (env: Env): Endpoints => ({
	googleAuth: env.PIM_GOOGLE_AUTH_URL ?? "https://accounts.google.com/o/oauth2/v2/auth",
	googleToken: env.PIM_GOOGLE_TOKEN_URL ?? "https://oauth2.googleapis.com/token",
	googleRevoke: env.PIM_GOOGLE_REVOKE_URL ?? "https://oauth2.googleapis.com/revoke",
	gmailApi: (env.PIM_GMAIL_API_URL ?? "https://gmail.googleapis.com/gmail/v1/users/me").replace(/\/+$/, ""),
	driveApi: (env.PIM_DRIVE_API_URL ?? "https://www.googleapis.com/drive/v3/files").replace(/\/+$/, ""),
	spotifyAuth: env.PIM_SPOTIFY_AUTH_URL ?? "https://accounts.spotify.com/authorize",
	spotifyToken: env.PIM_SPOTIFY_TOKEN_URL ?? "https://accounts.spotify.com/api/token",
	spotifyApi: (env.PIM_SPOTIFY_API_URL ?? "https://api.spotify.com/v1").replace(/\/+$/, ""),
});

/** Every native connector Pim implements, offered or not. */
export const NATIVE_APPS: readonly NativeApp[] = [gmailApp, driveApp, spotifyApp];

export const nativeApp = (ref: string): NativeApp | undefined => NATIVE_APPS.find((a) => a.ref === ref);

/** The environment variables that are not set: what the admin must set before the connector is offered. */
export const missingSettings = (app: NativeApp, env: Env): string[] => [app.client.id, app.client.secret, ...(app.needs ?? [])].filter((name) => !env[name]);

/** Those the deployment's environment sets up. */
export const offeredNativeApps = (env: Env): NativeApp[] => NATIVE_APPS.filter((a) => missingSettings(a, env).length === 0);
