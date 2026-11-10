/** An error with the HTTP status the API answers it with. */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

export function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

export async function readJson<T extends object>(request: Request): Promise<Partial<T>> {
	// An empty POST still has a body stream on Workers; no content means no fields.
	const raw = request.body ? await request.text() : "";
	if (raw.trim() === "") return {};
	try {
		const value: unknown = JSON.parse(raw);
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as Partial<T>;
	} catch {
		throw new HttpError(400, "Body must be a JSON object");
	}
}

export type RouteHandler = (params: Readonly<Record<string, string>>, request: Request, url: URL) => unknown;

export type Route = readonly [method: string, pattern: string, handler: RouteHandler];

/**
 * Matches `path` (such as `/sessions/1/messages`) against `/sessions/:session/messages`
 * style patterns and answers with the handler's value as JSON.
 */
export async function dispatch(routes: readonly Route[], request: Request, path: string): Promise<Response> {
	const url = new URL(request.url);
	const segments = path.split("/").filter(Boolean).map(decodeURIComponent);
	let pathMatched = false;
	for (const [method, pattern, handler] of routes) {
		const params = match(pattern, segments);
		if (!params) continue;
		pathMatched = true;
		if (method !== request.method) continue;
		try {
			const result = await handler(params, request, url);
			return result instanceof Response ? result : json(result ?? null);
		} catch (error) {
			if (error instanceof HttpError) return json({ error: error.message }, error.status);
			console.error("pim request failed", error);
			return json({ error: error instanceof Error ? error.message : String(error) }, 500);
		}
	}
	return pathMatched ? json({ error: "Method not allowed" }, 405) : json({ error: "Not found" }, 404);
}

/** The params `segments` give `pattern`'s, or null when they don't match it. */
export function match(pattern: string, segments: readonly string[]): Record<string, string> | null {
	const parts = pattern.split("/").filter(Boolean);
	if (parts.length !== segments.length) return null;
	const params: Record<string, string> = {};
	for (const [index, part] of parts.entries()) {
		if (part.startsWith(":")) params[part.slice(1)] = segments[index]!;
		else if (part !== segments[index]) return null;
	}
	return params;
}

/** The pattern of the route `path` is for, such as `/sessions/:session/messages`: the path without what it names, for logs. */
export function routeOf(routes: readonly Route[], path: string): string | undefined {
	const segments = path.split("/").filter(Boolean);
	return routes.find(([, pattern]) => match(pattern, segments) !== null)?.[1];
}
