import type { IncomingMessage } from "node:http";
import type { Principal } from "@pim/v2-contracts/identity";
import type { App } from "./app.ts";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "./errors.ts";

export type Reply = { status: number; body?: unknown; headers?: Record<string, string | string[]>; raw?: Uint8Array | string };
export type Ctx = {
	app: App;
	req: IncomingMessage;
	url: URL;
	params: string[];
	/** The address the app is served from, `https://pim.example.com`. */
	origin: string;
	/** Where apps with a backend get an origin of their own (`https://apps.example.net`), if the deployment sets one. */
	appsOrigin: string | undefined;
	secure: boolean;
	/** The signed-in principal; throws 401 without one. */
	principal: () => Promise<Principal>;
	/** The principal if there is a valid credential, else null. */
	maybePrincipal: () => Promise<Principal | null>;
	/** The JSON body, at most `limit` bytes (1 MB unless a route that takes pictures asks for more). */
	json: (limit?: number) => Promise<Record<string, any>>;
	form: () => Promise<URLSearchParams>;
	bytes: (limit?: number) => Promise<Uint8Array>;
	cookie: (name: string) => string | undefined;
};
export type Route = { method: string; pattern: RegExp; run: (ctx: Ctx) => Promise<Reply> };

export const ok = (body: unknown, status = 200, headers?: Reply["headers"]): Reply => ({ status, body, ...(headers ? { headers } : {}) });
export const route = (method: string, path: string, run: Route["run"]): Route => ({ method, pattern: new RegExp(`^${path.replace(/:[a-z]+/gi, "([^/]+)").replace(/\*/g, "(.+)")}$`), run });

/** The session cookie: `__Host-` bound on HTTPS, and a plain name only where the app is served over plain http (local development). */
export const sessionCookieName = (secure: boolean) => (secure ? "__Host-pim-session" : "pim_session");
export const challengeCookieName = (secure: boolean) => (secure ? "__Host-pim-challenge" : "pim_challenge");
export const oauthCookieName = (secure: boolean) => (secure ? "__Host-pim-oauth" : "pim_oauth");

export function setCookie(name: string, value: string, seconds: number, secure: boolean, sameSite: "Strict" | "Lax" = "Strict"): string {
	return `${name}=${value}; Path=/; ${secure ? "Secure; " : ""}HttpOnly; SameSite=${sameSite}; Max-Age=${seconds}`;
}
export const clearCookie = (name: string, secure: boolean) => setCookie(name, "", 0, secure);

export function readCookie(req: IncomingMessage, name: string): string | undefined {
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const [key, ...value] = part.trim().split("=");
		if (key === name) return value.join("=");
	}
	return undefined;
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new BadRequestError("Request body too large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

/** Paths that are served to the public or run someone's published code: a token in their URL is never a credential. */
const STRICT_PATHS = /^\/(p|hosted|app-pages|shared)\//;

/**
 * The credential a request carries: a bearer header, else the session cookie, else `?token=`: on a WebSocket upgrade (a browser cannot set headers on one) and,
 * as v1 allowed, on a read of the API (`GET /api/...?token=`, for a script or a browser address bar). Never on a write, nor on published-app or artifact paths.
 */
export function bearerOf(req: IncomingMessage, url: URL, secure: boolean): { bearer?: string; viaCookie: boolean } {
	const auth = req.headers.authorization;
	if (auth?.startsWith("Bearer ")) return { bearer: auth.slice(7), viaCookie: false };
	const cookie = readCookie(req, sessionCookieName(secure));
	if (cookie) return { bearer: cookie, viaCookie: true };
	const upgrade = req.headers.upgrade?.toLowerCase() === "websocket";
	const token = url.searchParams.get("token");
	const apiRead = ["GET", "HEAD"].includes(req.method ?? "GET") && /^\/api(\/|$)/.test(url.pathname);
	if (token && (upgrade || apiRead) && !STRICT_PATHS.test(url.pathname)) return { bearer: token, viaCookie: false };
	return { viaCookie: false };
}

/** A request from another site that carries ambient cookies must not act: browsers send Origin on writes and WebSockets. */
export function fromAnotherSite(req: IncomingMessage): boolean {
	const origin = req.headers.origin;
	const reads = ["GET", "HEAD"].includes(req.method ?? "GET");
	const socket = req.headers.upgrade?.toLowerCase() === "websocket";
	if (origin === undefined) return false; // non-browser clients send none
	if (reads && !socket) return false;
	try {
		return new URL(origin).host !== req.headers.host;
	} catch {
		return true;
	}
}

export function makeCtx(app: App, req: IncomingMessage, url: URL, params: string[], opts: { origin: string; appsOrigin?: string | undefined }): Ctx {
	const secure = opts.origin.startsWith("https:");
	let cached: Promise<Principal | null> | undefined;
	const resolve = () =>
		(cached ??= (async () => {
			const { bearer, viaCookie } = bearerOf(req, url, secure);
			if (!bearer) return null;
			if (viaCookie && fromAnotherSite(req)) throw new ForbiddenError("request", "csrf");
			return app.identity.authenticate(bearer);
		})());
	return {
		app, req, url, params, origin: opts.origin, appsOrigin: opts.appsOrigin, secure,
		principal: async () => (await resolve()) ?? Promise.reject(new UnauthorizedError()),
		maybePrincipal: () => resolve().catch((error) => (error instanceof UnauthorizedError ? null : Promise.reject(error))),
		json: async (limit = 1_000_000) => {
			const body = await readBody(req, limit);
			try {
				return body.length ? JSON.parse(Buffer.from(body).toString("utf8")) : {};
			} catch {
				throw new BadRequestError("The body is not valid JSON");
			}
		},
		form: async () => new URLSearchParams(Buffer.from(await readBody(req, 100_000)).toString("utf8")),
		bytes: (limit = 25_000_000) => readBody(req, limit),
		cookie: (name) => readCookie(req, name),
	};
}
