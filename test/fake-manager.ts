import { posix } from "node:path";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { WorkspaceCapacityError, WorkspaceFileError, WorkspaceLimitError, WorkspaceNotFoundError, WorkspacePathError, type WorkspaceRef, type WorkspaceSpec } from "../src/coding/workspace/types";

/** The sandbox-manager's bearer token and address in tests. */
export const TOKEN = "s3cret-manager-token";
export const URL_BASE = "http://127.0.0.1:8080";

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (error: unknown): Response | null => {
	if (error instanceof WorkspacePathError) return json(403, { error: "path escapes /workspace", code: "path_escape" });
	if (error instanceof WorkspaceLimitError) return json(507, { error: "the write would take the workspace over its disk quota", code: "disk_full" });
	if (error instanceof WorkspaceFileError) return json(/Not a|Is a/.test(error.message) ? 409 : 404, { error: `no such file or directory: ${error.message}`, code: /Not a|Is a/.test(error.message) ? "conflict" : "not_found" });
	return null;
};

type FakeNodes = Map<string, { type: string; target?: string }>;

/** A fetch stub that speaks the sandbox-manager's route contract (sandbox-manager/README.md), backed by a FakeWorkspaceProvider. Where the real manager differs from the fake's workspace it follows the manager: `stat` describes a symlink itself, a deleted-with-keepVolume session is listed as gone, exec and files on a stopped session are 409, and `/exec/stream` answers NDJSON as the command prints. `readlink -f` is a command of the fake's shell. */
export function fakeManager(max = 3) {
	const backing = new FakeWorkspaceProvider({ maxConcurrent: max });
	const requests: { method: string; path: string; auth: string | null; body?: unknown }[] = [];
	const refs = new Map<string, WorkspaceRef>();
	const kept = new Map<string, number>();
	/** The manager's disk, which a test may fill: below 15% free it refuses new workspaces with `low_disk`, as the real one does by default. */
	const disk = { freeDiskPct: 42.5 };
	backing.register("readlink", async ({ argv, workspace }) => {
		const nodes = (workspace as unknown as { nodes: FakeNodes }).nodes;
		let path = posix.normalize(argv.at(-1) ?? "");
		for (let hops = 0; hops < 32; hops++) {
			const parts = path.split("/").filter(Boolean);
			const at = parts.findIndex((_, i) => nodes.get(`/${parts.slice(0, i + 1).join("/")}`)?.type === "symlink");
			if (at < 0) break;
			const link = `/${parts.slice(0, at + 1).join("/")}`;
			path = posix.normalize(posix.join(posix.dirname(link), nodes.get(link)?.target ?? "", ...parts.slice(at + 1)));
			if (nodes.get(link)?.target?.startsWith("/")) path = posix.normalize(posix.join(nodes.get(link)?.target ?? "", ...parts.slice(at + 1)));
		}
		return { stdout: `${path}\n` };
	});

	// Like a real fetch, a request whose signal aborts rejects, whatever the manager was doing.
	const handler = (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> =>
		new Promise((resolve, reject) => {
			const abort = () => reject(new DOMException("aborted", "AbortError"));
			if (init.signal?.aborted) return abort();
			init.signal?.addEventListener("abort", abort);
			route(input, init).then(resolve, reject);
		});

	const route = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		const auth = new Headers(init.headers).get("authorization");
		const raw = typeof init.body === "string" ? init.body : undefined;
		const body = raw ? JSON.parse(raw) : undefined;
		requests.push({ method, path: url.pathname + url.search, auth, body });
		if (url.pathname === "/health") return json(200, { runsc: true, freeDiskPct: disk.freeDiskPct, maxConcurrent: max, running: refs.size, free: max - refs.size, sessions: refs.size });
		if (auth !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" });
		if (url.pathname === "/sessions" && method === "GET") {
			const live = (await backing.list()).map((i) => ({ sessionId: i.ref.sessionId, state: i.state, createdAt: i.createdAt }));
			const gone = [...kept].map(([sessionId, createdAt]) => ({ sessionId, state: "gone", reason: "kept_volume", createdAt }));
			return json(200, [...live, ...gone].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)));
		}
		if (url.pathname === "/sessions" && method === "POST") {
			const spec = {
				sessionId: body.sessionId,
				image: body.image,
				repo: { url: "", ref: "", branch: "" },
				limits: { ...body.limits, wallClockMin: 1 },
				egress: { allow: body.egressAllow },
				gitAuth: { mode: "none" },
				...(body.userId !== undefined ? { environment: { userId: body.userId, repo: body.repo, ...(body.restoreFrom ? { restoreFrom: body.restoreFrom.key } : {}) } } : {}),
			} as WorkspaceSpec;
			const existed = refs.has(spec.sessionId);
			if (!existed && disk.freeDiskPct < 15) return json(507, { error: `free disk ${disk.freeDiskPct}% is below 15%`, code: "low_disk", freeDiskPct: disk.freeDiskPct, minFreePct: 15 });
			try {
				const ref = await backing.create(spec);
				refs.set(spec.sessionId, ref);
				kept.delete(spec.sessionId);
				return json(existed ? 200 : 201, { sessionId: spec.sessionId, state: "running", createdAt: 1 });
			} catch (error) {
				if (error instanceof WorkspaceCapacityError) return json(429, { error: "at capacity", code: "capacity", limit: max, running: refs.size });
				if (error instanceof WorkspaceNotFoundError) return json(404, { error: "no such snapshot", code: "snapshot_not_found" });
				if (spec.environment?.restoreFrom) return json(422, { error: "the snapshot is corrupt (sha256 mismatch) and was deleted", code: "snapshot_corrupt" });
				throw error;
			}
		}
		// Environment snapshots, as the V1 manager keeps them per user (sandbox-manager/src/snapshots.js).
		if (url.pathname === "/snapshots" && method === "POST") {
			const ref = refs.get(body.sessionId);
			if (!ref) return json(404, { error: "no such session" });
			const known = await backing.listEnvironments({ userId: body.userId, repo: body.repo });
			try {
				const snapshot = await backing.snapshotEnvironment(ref, { userId: body.userId, repo: body.repo, key: body.key });
				return json(known.some((each) => each.key === body.key) ? 200 : 201, { ...snapshot, size: 1 });
			} catch (error) {
				return json(403, { error: String(error), code: "forbidden" });
			}
		}
		if (url.pathname === "/snapshots" && method === "GET") {
			const userId = url.searchParams.get("userId") ?? "";
			return json(200, await backing.listEnvironments({ userId, repo: url.searchParams.get("repo") ?? "" }));
		}
		const snap = /^\/snapshots\/([0-9a-f]+)$/.exec(url.pathname);
		if (snap && method === "DELETE") {
			const deleted = await backing.deleteEnvironment(url.searchParams.get("userId") ?? "", snap[1]!);
			return deleted ? json(200, { deleted: snap[1] }) : json(404, { error: "no such snapshot", code: "snapshot_not_found" });
		}
		const m = /^\/sessions\/([a-z0-9-]+)(?:\/(exec\/stream|exec|file|list|stat|stop|start))?$/.exec(url.pathname);
		if (!m) return json(404, { error: "not found" });
		const [, id = "", sub] = m;
		const ref = refs.get(id);
		const ws = ref ? await backing.get(ref) : null;
		if (!ref || !ws) return json(404, { error: "no such session" });
		if (!sub && method === "GET") return json(200, { sessionId: id, ...(await ws.status()) });
		if (!sub && method === "DELETE") {
			const keep = url.searchParams.get("keepVolume") === "1";
			await backing.destroy(ref, { keepVolume: keep });
			refs.delete(id);
			if (keep) kept.set(id, 1);
			return json(200, { deleted: id });
		}
		if (sub === "stop") return await ws.stop(), json(200, { sessionId: id, state: "stopped" });
		if (sub === "start") return await ws.start(), json(200, { sessionId: id, state: "running" });
		if ((await ws.status()).state === "stopped") return json(409, { error: "session is stopped; start it first", code: "session_stopped" });
		const path = url.searchParams.get("path") ?? "";
		try {
			if (sub === "file" && method === "PUT") {
				const mode = url.searchParams.get("mode");
				await ws.writeFile(path, new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()), mode ? Number.parseInt(mode, 8) : undefined);
				return json(200, { ok: true });
			}
			if (sub === "file" && method === "GET") return new Response(await ws.readFile(path), { status: 200 });
			if (sub === "file" && method === "DELETE") return await ws.remove(path), json(200, { ok: true });
			if (sub === "list") return json(200, await ws.list(path));
			if (sub === "stat") {
				// lstat: the entry itself, found among its parent's entries.
				if (posix.normalize(path) === "/workspace") return json(200, await ws.stat(path));
				const entry = (await ws.list(posix.dirname(path))).find((e) => e.name === posix.basename(path));
				return entry ? json(200, entry) : json(404, { error: "no such file or directory", code: "not_found" });
			}
		} catch (error) {
			const answer = refusal(error);
			if (answer) return answer;
			throw error;
		}
		const { cmd, cwd, timeoutMs, stdin, env } = body as { cmd: string[]; cwd?: string; timeoutMs: number; stdin?: string; env?: Record<string, string> };
		const events = ws.exec(cmd, { cwd, timeoutMs, stdin, env, signal: init.signal ?? undefined });
		if (sub === "exec/stream") {
			const encoder = new TextEncoder();
			return new Response(
				new ReadableStream({
					async start(controller) {
						init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
						try {
							for await (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
							controller.close();
						} catch {}
					},
				}),
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			);
		}
		throw new Error("the provider no longer uses buffered exec");
	};
	return { fetch: handler as typeof fetch, requests, backing, disk };
}
