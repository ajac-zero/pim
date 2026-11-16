// The shared parts of Forge's portable HTTP handlers: each is `(req: Request) => Promise<Response | null>`, `null` meaning "not mine", so a host composes them and falls through to its own routes.
import { type Actor } from "../authz";
import { ForgeError, httpStatus } from "../errors";

/** Who is calling. The host (Gate) owns sessions and tokens; Forge only asks. `via` tells a browser session from an API token: admin routes refuse tokens. */
export type Caller = { actor: Actor; via: "session" | "token" };
export type Authenticate = (req: Request) => Promise<Caller | null>;
export type Handler = (req: Request) => Promise<Response | null>;

export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The error body the coding API has always had: `{error, code}`. */
export function errorResponse(error: unknown): Response {
	const status = httpStatus(error);
	if (error instanceof ForgeError) return json(status, { error: error.message, code: error.code });
	const code = (error as { code?: string } | null)?.code;
	if (code === "forbidden") return json(403, { error: (error as Error).message, code: "forbidden" });
	if (code === "capability_unavailable") return json(503, { error: (error as Error).message, code: "unavailable" });
	console.warn(JSON.stringify({ event: "pim.forge.http_error", error: String(error).slice(0, 300) }));
	return json(500, { error: "Something went wrong", code: "internal" });
}

/** The JSON body of a request, refused when it is too big or not an object. */
export async function readJson(req: Request, max = 256 * 1024): Promise<Record<string, any>> {
	const text = await req.text();
	if (text.length > max) throw new ForgeError("invalid", "The request body is too big");
	if (text === "") return {};
	try {
		const v = JSON.parse(text);
		if (v === null || typeof v !== "object" || Array.isArray(v)) throw 0;
		return v;
	} catch {
		throw new ForgeError("invalid", "The body must be a JSON object");
	}
}

/** Matches `/a/:b/c` style patterns; `*` as the last segment takes the rest. */
export function match(pattern: string, path: string): Record<string, any> | null {
	const p = pattern.split("/").filter(Boolean);
	const s = path.split("/").filter(Boolean);
	const params: Record<string, any> = {};
	for (let i = 0; i < p.length; i++) {
		if (p[i] === "*") {
			params["*"] = s.slice(i).join("/");
			return params;
		}
		if (s[i] === undefined) return null;
		if (p[i]!.startsWith(":")) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
		else if (p[i] !== s[i]) return null;
	}
	return s.length === p.length ? params : null;
}

/** Runs `fn` and turns what it throws into the API's error body. */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
	try {
		return await fn();
	} catch (e) {
		return errorResponse(e);
	}
}

export const notGuest = (caller: Caller | null): Caller => {
	if (!caller) throw new ForgeError("forbidden", "Sign in first");
	if (caller.actor.role === "guest") throw new ForgeError("forbidden", "Guests can't use coding threads");
	return caller;
};
