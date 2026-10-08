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
	if (!request.body) return {};
	try {
		const value: unknown = await request.json();
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
		const parts = pattern.split("/").filter(Boolean);
		if (parts.length !== segments.length) continue;
		const params: Record<string, string> = {};
		const matches = parts.every((part, index) => {
			const segment = segments[index]!;
			if (part.startsWith(":")) {
				params[part.slice(1)] = segment;
				return true;
			}
			return part === segment;
		});
		if (!matches) continue;
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
