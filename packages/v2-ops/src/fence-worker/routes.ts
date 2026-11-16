// The fence Worker's HTTP surface. It imports nothing from `cloudflare:workers`, so it can be read and tested like any module.

/** The Durable Object bindings of the legacy Worker, by binding name, with the class each is bound to. */
export const FENCE_CLASSES = {
	Pim: "Pim",
	Auth: "Auth",
	Directory: "Directory",
	Gallery: "Gallery",
	CodingScheduler: "CodingSchedulerDO",
	CodingThread: "CodingThreadDO",
	HostOps: "HostOps",
	WorkspaceContainer: "WorkspaceContainer",
	WorkspaceCatalog: "WorkspaceCatalog",
} as const;
export type FenceBinding = keyof typeof FENCE_CLASSES;

type Stub = {
	fenceProbe(): unknown;
	fenceAlarm(): Promise<number | null>;
	fenceTables(): unknown;
	fenceRows(table: string, after: number, limit: number): unknown;
	fenceKv(startAfter: string | undefined, limit: number): Promise<unknown>;
	fenceDestroyContainer(): unknown;
};
type Namespace = { getByName(name: string): Stub };

export type Env = {
	/** The bearer token that opens the export routes. Unset: the routes answer 503 like everything else. */
	FENCE_EXPORT_TOKEN?: string;
	/** "true" lets POST /fence/v1/do/WorkspaceContainer/<id>/destroy stop a running container. */
	FENCE_ALLOW_CONTAINER_DESTROY?: string;
	CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };
	Pim: Namespace;
	Auth: Namespace;
	Directory: Namespace;
	Gallery: Namespace;
	CodingScheduler: Namespace;
	CodingThread: Namespace;
	HostOps: Namespace;
	WorkspaceContainer: Namespace;
	WorkspaceCatalog: Namespace;
	ARTIFACTS: R2Bucket;
	BLOBS: R2Bucket;
	OAUTH_KV: KVNamespace;
};

const maintenance = () => Response.json({ error: "Maintenance", message: "This Pim is being moved and answers nothing right now." }, { status: 503, headers: { "retry-after": "3600" } });
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });

async function digest(text: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Constant-time comparison through equal-length digests. */
async function authorized(request: Request, env: Env): Promise<boolean> {
	const expected = env.FENCE_EXPORT_TOKEN;
	if (!expected || expected.length < 32) return false;
	const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}

export async function handleFetch(request: Request, env: Env): Promise<Response> {
	try {
		return await route(request, env);
	} catch (error) {
		// A bad table name or a failing read is a failed export, never a crash that could be mistaken for the product answering.
		return json({ error: error instanceof Error ? error.message : "export failed" }, 500);
	}
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/fence/v1/")) return maintenance();
	// An export route without a valid token looks like every other path: the existence of the export is not advertised.
	if (!(await authorized(request, env))) return maintenance();
	const parts = url.pathname.slice("/fence/v1/".length).split("/").map(decodeURIComponent);
	const get = request.method === "GET";

	if (get && parts[0] === "version") return json({ version: env.CF_VERSION_METADATA ?? null, classes: FENCE_CLASSES });

	if (parts[0] === "do" && parts.length >= 4) {
		const [, binding, name, op] = parts as [string, string, string, string];
		if (!(binding in FENCE_CLASSES)) return json({ error: "unknown binding" }, 404);
		const stub = (env[binding as FenceBinding] as Namespace).getByName(name);
		if (get && op === "probe") return json(await stub.fenceProbe());
		if (get && op === "alarm") return json({ alarm: await stub.fenceAlarm() });
		if (get && op === "tables") return json(await stub.fenceTables());
		if (get && op === "rows") return json(await stub.fenceRows(url.searchParams.get("table") ?? "", Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 500)));
		if (get && op === "kv") return json(await stub.fenceKv(url.searchParams.get("after") ?? undefined, Math.min(Number(url.searchParams.get("limit") ?? 500), 1000)));
		if (request.method === "POST" && op === "destroy" && binding === "WorkspaceContainer") {
			if (env.FENCE_ALLOW_CONTAINER_DESTROY !== "true") return json({ error: "container destroy is not enabled for this deploy" }, 403);
			return json(await stub.fenceDestroyContainer());
		}
		return json({ error: "no such export" }, 404);
	}

	if (get && parts[0] === "r2" && (parts[1] === "ARTIFACTS" || parts[1] === "BLOBS")) {
		const bucket = env[parts[1]];
		if (parts[2] === "object") {
			const key = url.searchParams.get("key") ?? "";
			const object = await bucket.get(key);
			if (!object) return json({ error: "not found" }, 404);
			return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", "x-object-size": String(object.size), "cache-control": "no-store" } });
		}
		const page = await bucket.list({ include: ["httpMetadata"], limit: Math.min(Number(url.searchParams.get("limit") ?? 500), 1000), ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}), ...(url.searchParams.get("prefix") ? { prefix: url.searchParams.get("prefix")! } : {}) });
		return json({ objects: page.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, contentType: o.httpMetadata?.contentType ?? null })), truncated: page.truncated, cursor: page.truncated ? page.cursor : null });
	}

	if (get && parts[0] === "kv" && parts[1] === "OAUTH_KV") {
		const key = url.searchParams.get("key");
		if (key !== null) return json({ key, value: await env.OAUTH_KV.get(key, "text") });
		const page = await env.OAUTH_KV.list({ limit: 1000, ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}) });
		return json({ keys: page.keys.map((k) => ({ name: k.name, expiration: k.expiration ?? null })), done: page.list_complete, cursor: page.list_complete ? null : page.cursor });
	}
	return json({ error: "no such export" }, 404);
}
