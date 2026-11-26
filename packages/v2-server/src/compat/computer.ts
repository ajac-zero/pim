/**
 * What the web app and a person's machine need of the Gate for a personal computer, with the HTTP shapes v1's Worker had (`web/src/lib/pim-api.ts`):
 *
 *   GET / POST / DELETE /api/computer      its status, pairing one (the `pimc_` token is shown only in the answer) and forgetting it
 *   GET /api/computer/displays             the per-thread desktops on it, and POST .../displays/control to take one over
 *   GET / DELETE /api/browser?session=     whether its browser exists, and closing a chat's window
 *   GET /api/terminal?session=             the commands a chat's agents ran in the shell, with their output as it comes
 *   GET / HEAD / PUT /api/files(/content)  the person's files on it, and DELETE /api/files
 *   GET /install.sh, GET /pim-computer.ts  what installs and updates `pim-computer` on a machine, public like the Worker's, and the triggers runtime's modules it loads beside it
 *
 * The files are the computer's: nothing here keeps a copy. Every call goes to the paired `pim-computer` through the Relay (in this process, or over the bus to the one
 * that holds its socket); with none connected they answer 503 `capability_unavailable`, and nothing else in Pim is affected. A guest has no computer.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRange } from "@pim/v2-app/objects";
import { type Computer, ComputerError } from "@pim/v2-app/relay";
import { BadRequestError, ConflictError, NotFoundError } from "@pim/v2-app/errors";
import { ok, type Reply, type Route, route } from "@pim/v2-app/http";
import { filesPath, FILES_ROOT } from "../computer-tools.ts";
import { installScript } from "../computer-install-script.ts";
import { displaydBundle } from "../../../../displayd/bundle.js";

const MAX_UPLOAD_BYTES = 25_000_000;
const CHUNK_BYTES = 700_000;
/** What one read of a file asks of the computer: an answer this size, in base64, passes a bus left at NATS's default 1 MB limit. */
const READ_PART_BYTES = 524_288;
const TYPES: Record<string, string> = { html: "text/html", css: "text/css", js: "text/javascript", json: "application/json", md: "text/markdown", txt: "text/plain", csv: "text/csv", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf", mp4: "video/mp4", mp3: "audio/mpeg" };
const typeOf = (name: string) => TYPES[name.slice(name.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";
const noStore = { "cache-control": "no-store, private" };

/** A path of the person's files, as the request names it. */
function checked(path: string | null): string {
	const resolved = filesPath(path);
	if (resolved === null) throw new BadRequestError(`${String(path)} is not one of your files: use an absolute path under ${FILES_ROOT}`);
	return resolved;
}

/** A failure the computer reports (a missing file, a changed one) as the status the app expects of a files API. */
function answer(error: unknown): never {
	if (error instanceof ComputerError && error.remote) {
		const code = error.remote.code;
		if (code === "conflict") throw new ConflictError(error.message, "conflict");
		if (code === "ENOENT") throw new NotFoundError(error.message);
		if (code === "EISDIR" || code === "ENOTDIR" || code === "EINVAL" || code === "EPERM") throw new BadRequestError(error.message);
	}
	throw error;
}

const etag = (sha256: string) => `"${sha256}"`;
const etags = (header: string | string[] | undefined) => (typeof header === "string" ? header.split(",").map((t) => t.trim().replace(/^W\//, "").replace(/^"|"$/g, "")).filter(Boolean) : []);

/**
 * A short DevTools conversation with the computer's browser (its chat's, or the shared one where the computer has no per-chat displays): `use` gets `send`, which answers
 * the command's result, and the connection is closed after. Reading is never starting: `browser_status` says first whether the browser is running.
 */
async function withBrowser<T>(computer: Computer, thread: string | null, use: (send: (method: string, params?: object, sessionId?: string) => Promise<any>) => Promise<T>): Promise<T | null> {
	let perAgent = false;
	const open = async (t: string | undefined) => {
		const status = await computer.call<{ available: boolean; running: boolean; agents?: boolean }>("browser_status", t ? { thread: t } : {});
		perAgent ||= status.agents === true;
		if (!status.running) return null;
		let nextId = 0;
		const waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
		const link = await computer.openBrowser((raw) => {
			if (raw === null) return;
			const m = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string } };
			if (m.id !== undefined) waiting.get(m.id)?.(m), waiting.delete(m.id);
		}, t);
		const send = (method: string, params: object = {}, sessionId?: string) =>
			new Promise<any>((resolve, reject) => {
				const id = ++nextId;
				const timer = setTimeout(() => (waiting.delete(id), reject(new Error(`The browser did not answer ${method}`))), 15_000);
				waiting.set(id, (m) => (clearTimeout(timer), m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
				link.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
			});
		try {
			return { value: await use(send) };
		} finally {
			link.close();
		}
	};
	try {
		const own = await open(thread ?? undefined);
		// Where the agents browse in a browser of their own, a chat that hasn't browsed has nothing to show.
		if (own || !thread || perAgent) return own?.value ?? null;
		// A chat that hasn't leased a browser of its own shows the shared one when the computer has no displays at all (displayd is not there), as the agent's tools do.
		const shown = await computer.call<{ displays: unknown[]; queue: unknown[] }>("displays_list", {}).catch(() => null);
		const none = !shown || (shown.displays.length === 0 && shown.queue.length === 0);
		return none ? ((await open(undefined))?.value ?? null) : null;
	} catch (error) {
		// A computer without displayd has one browser, which the chats share.
		if (thread && /no display allocated|displayd is not reachable/.test((error as Error).message)) return (await open(undefined))?.value ?? null;
		throw error;
	}
}

/** The page the browser shows, and a picture of it. */
const pageOf = async (send: (method: string, params?: object, sessionId?: string) => Promise<any>) => {
	const { targetInfos } = (await send("Target.getTargets")) as { targetInfos: { type: string; targetId: string; url: string; title: string }[] };
	return targetInfos.find((t) => t.type === "page") ?? null;
};

/** The triggers runtime's modules, which `pim-computer` fetches from its Pim as it starts (`TRIGGERS_MODULES` in computer/pim-computer.ts), because an installed computer has only that one file. */
const TRIGGERS_MODULES = ["triggers-host.ts", "triggers-runtime.ts", "triggers-adapters/index.ts", "triggers-adapters/managed.ts", "triggers-adapters/poll.ts", "triggers-adapters/process.ts", "triggers-adapters/stream.ts"];

export function computerRoutes(options: { source?: string } = {}): Route[] {
	const source = options.source ?? process.env.PIM_COMPUTER_SOURCE ?? fileURLToPath(new URL("../../../../computer/pim-computer.ts", import.meta.url));
	/** The signed-in person's computer, for a route that calls it: the owner is checked alive and allowed. */
	const withComputer = async (ctx: Parameters<Route["run"]>[0], capability: string) => {
		const p = await ctx.principal();
		await ctx.app.identity.authz.enforce(p, "computer:use");
		return { p, computer: await ctx.app.relay.acquire(p.ownerId, capability) };
	};
	const status = async (ctx: Parameters<Route["run"]>[0]) => {
		const p = await ctx.principal();
		const s = await ctx.app.relay.status(p);
		const pairedAt = s.computer ? await ctx.app.db.owner(p.ownerId, async (tx) => ((await tx.query("SELECT created_at FROM pim_app.computers WHERE id = $1", [s.computer!.id])).rows[0]?.created_at as Date | undefined)?.getTime() ?? null) : null;
		const info = s.computer?.info ?? null;
		return {
			state: s.state,
			managed: false,
			pairedAt,
			error: null,
			computer: info ? { agent: info.agent, hostname: info.hostname, platform: info.platform, arch: info.arch, user: info.user, root: info.root, browser: info.browser, screen: info.screen, desktop: info.desktop, connectedAt: info.connectedAt } : null,
		};
	};
	const entries = async (computer: Computer, folder: string) => {
		const listed = await computer.call<{ name: string; size: number; mtime: number; isFile: boolean; isDirectory: boolean }[]>("readdir", { path: folder, limit: 2000 }).catch(answer);
		return listed
			.filter((e) => e.isFile || e.isDirectory)
			.map((e) => ({ name: e.name, path: `${folder}/${e.name}`, type: e.isDirectory ? "directory" : "file", size: e.isDirectory ? 0 : e.size, updatedAt: new Date(e.mtime).toISOString() }))
			.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
	};

	return [
		route("GET", "/api/computer", async (ctx) => ok(await status(ctx), 200, noStore)),
		route("POST", "/api/computer", async (ctx) => {
			const p = await ctx.principal();
			const body = await ctx.json();
			// Where a host is paired the request is answered in `../hostops/routes.ts`; with none there is no computer to keep for them.
			if (body.managed === true) throw new NotFoundError("This Pim has no computer host to keep a computer for you. Connect one of your own.");
			const paired = await ctx.app.relay.pair(p, typeof body.name === "string" && body.name ? body.name.slice(0, 80) : "My computer", 2);
			return ok({ ...(await status(ctx)), token: paired.token }, 201, noStore);
		}),
		route("DELETE", "/api/computer", async (ctx) => {
			await ctx.app.relay.unpair(await ctx.principal());
			return ok(await status(ctx), 200, noStore);
		}),
		route("GET", "/api/computer/displays", async (ctx) => {
			const p = await ctx.principal();
			// The displays show the chats' titles, and taking one over pauses its agent: the person's browser only, like the desktop itself.
			await ctx.app.identity.authz.enforce(p, "computer:screen");
			await ctx.app.identity.authz.enforce(p, "computer:use");
			const computer = await ctx.app.relay.acquire(p.ownerId, "displays").catch(() => null);
			const shown = await computer?.call<{ displays: unknown[]; queue: unknown[] }>("displays_list", {}).catch(() => null);
			const label = (d: any) => ({ ...d, threadId: d.threadId, title: null });
			return ok({ displays: (shown?.displays ?? []).map(label), queue: (shown?.queue ?? []).map(label) }, 200, noStore);
		}),
		route("POST", "/api/computer/displays/control", async (ctx) => {
			await ctx.app.identity.authz.enforce(await ctx.principal(), "computer:screen");
			const { computer } = await withComputer(ctx, "displays");
			const b = await ctx.json();
			if (typeof b.thread !== "string" || !b.thread) throw new BadRequestError("thread must name the thread whose display to take over");
			if (b.mode !== "user" && b.mode !== "agent") throw new BadRequestError("mode must be 'user' or 'agent'");
			return ok(await computer.call("display_control", { thread: b.thread, mode: b.mode }), 200, noStore);
		}),
		route("GET", "/api/browser", async (ctx) => {
			const p = await ctx.principal();
			await ctx.app.identity.authz.enforce(p, "computer:use");
			const computer = await ctx.app.relay.acquire(p.ownerId, "browser").catch(() => null);
			const shown = computer ? await withBrowser(computer, ctx.url.searchParams.get("session"), pageOf).catch(() => null) : null;
			return ok({ available: computer?.info?.browser != null, page: shown ? { url: shown.url, title: shown.title } : null }, 200, noStore);
		}),
		route("GET", "/api/browser/screenshot", async (ctx) => {
			const { computer } = await withComputer(ctx, "browser");
			const png = await withBrowser(computer, ctx.url.searchParams.get("session"), async (send) => {
				const page = await pageOf(send);
				if (!page) return null;
				const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
				return Buffer.from((await send("Page.captureScreenshot", { format: "png" }, sessionId)).data as string, "base64");
			});
			if (!png) throw new NotFoundError("The browser is closed");
			return { status: 200, headers: { "content-type": "image/png", "cache-control": "no-store, private", "x-content-type-options": "nosniff" }, raw: png };
		}),
		// The commands a chat's agents ran in the shell, with what they printed as they run; `version` the reader has seen gets no copy again.
		route("GET", "/api/terminal", async (ctx) => {
			const p = await ctx.principal();
			await ctx.app.identity.authz.enforce(p, "computer:use");
			const session = ctx.url.searchParams.get("session");
			if (!session) throw new BadRequestError("session must name the chat whose commands to read");
			const seen = Number(ctx.url.searchParams.get("version"));
			const computer = await ctx.app.relay.acquire(p.ownerId, "shell").catch(() => null);
			// An older computer doesn't keep its commands: it has nothing to show.
			const read = computer ? await computer.call<{ version: number; commands?: unknown[] }>("terminal_read", { thread: session, ...(Number.isInteger(seen) && seen > 0 ? { version: seen } : {}) }).catch(() => null) : null;
			return ok({ available: read !== null, version: read?.version ?? 0, ...(read?.commands || !read ? { commands: read?.commands ?? [] } : {}) }, 200, noStore);
		}),
		route("DELETE", "/api/browser", async (ctx) => {
			const { computer } = await withComputer(ctx, "browser");
			const session = ctx.url.searchParams.get("session");
			await computer.call("browser_stop", session ? { thread: session } : {}, 30_000).catch(() => undefined);
			return ok({ closed: true }, 200, noStore);
		}),

		route("GET", "/api/files", async (ctx) => {
			const { computer } = await withComputer(ctx, "files");
			const folder = checked(ctx.url.searchParams.get("path") ?? FILES_ROOT);
			return ok({ path: folder, entries: await entries(computer, folder) }, 200, noStore);
		}),
		// A file of any size is streamed from the computer as it is read, in the parts the relay carries, and a `Range` gives 206 (or 416) so a player seeks.
		route("GET", "/api/files/content", async (ctx): Promise<Reply> => {
			const { computer } = await withComputer(ctx, "files");
			const path = checked(ctx.url.searchParams.get("path"));
			const stat = await computer.call<{ size: number; isDirectory: boolean; sha256: string | null }>("stat", { path }).catch(answer);
			if (stat.isDirectory) throw new BadRequestError(`${path} is a folder`);
			const range = ctx.req.headers.range ? parseRange(ctx.req.headers.range, stat.size) : "whole";
			if (stat.sha256 && range === "whole" && etags(ctx.req.headers["if-none-match"]).some((t) => t === "*" || t === stat.sha256)) return { status: 304, headers: { etag: etag(stat.sha256), "x-file-sha256": stat.sha256 }, raw: "" };
			const name = posix.basename(path);
			const headers: Record<string, string> = { "content-type": typeOf(name), "accept-ranges": "bytes", ...noStore, "content-security-policy": "default-src 'none'; sandbox", "x-content-type-options": "nosniff", "cross-origin-resource-policy": "same-origin", "referrer-policy": "no-referrer" };
			if (stat.sha256) Object.assign(headers, { etag: etag(stat.sha256), "x-file-sha256": stat.sha256 });
			if (ctx.url.searchParams.has("download")) headers["content-disposition"] = `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\;%]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;
			if (range === null) return { status: 416, headers: { ...headers, "content-range": `bytes */${stat.size}` }, raw: "" };
			const { start, end } = range === "whole" ? { start: 0, end: stat.size - 1 } : range;
			const length = stat.size === 0 ? 0 : end - start + 1;
			let offset = start;
			const stream = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (offset > end || length === 0) return controller.close();
					const { data } = await computer.call<{ data: string }>("read", { path, offset, length: Math.min(READ_PART_BYTES, end - offset + 1) });
					const bytes = Buffer.from(data, "base64");
					if (bytes.length === 0) return controller.close();
					offset += bytes.length;
					controller.enqueue(new Uint8Array(bytes));
				},
			});
			return { status: range === "whole" ? 200 : 206, headers: { ...headers, "content-length": String(length), ...(range === "whole" ? {} : { "content-range": `bytes ${start}-${end}/${stat.size}` }) }, stream };
		}),
		route("HEAD", "/api/files/content", async (ctx) => {
			const { computer } = await withComputer(ctx, "files");
			const stat = await computer.call<{ size: number; mtime: number; sha256: string | null }>("stat", { path: checked(ctx.url.searchParams.get("path")) }).catch(answer);
			return { status: 200, headers: { "x-file-size": String(stat.size), "x-file-mtime": String(stat.mtime), ...(stat.sha256 ? { etag: etag(stat.sha256), "x-file-sha256": stat.sha256 } : {}), ...noStore }, raw: "" };
		}),
		route("PUT", "/api/files/content", async (ctx) => {
			const { computer } = await withComputer(ctx, "files");
			const path = checked(ctx.url.searchParams.get("path"));
			if (path === FILES_ROOT) throw new BadRequestError(`${FILES_ROOT} is a folder`);
			const body = await ctx.bytes(MAX_UPLOAD_BYTES);
			// `If-Match` writes only over a file with that hash; `If-None-Match: *` only where there is none. Neither: over whatever is there.
			const match = etags(ctx.req.headers["if-match"]);
			const none = etags(ctx.req.headers["if-none-match"]);
			if (match.length > 1 || (match.length === 1 && !/^[0-9a-f]{64}$/.test(match[0]!))) throw new BadRequestError("If-Match must be one file hash, as the ETag a read gave");
			if (none.length > 0 && !(none.length === 1 && none[0] === "*")) throw new BadRequestError("If-None-Match must be * on a write");
			if (match.length > 0 && none.length > 0) throw new BadRequestError("Send If-Match or If-None-Match, not both");
			const condition = match[0] ?? (none.length > 0 ? "absent" : undefined);
			const hold = condition === undefined ? {} : { expectedHash: condition };
			await computer.call("mkdir", { path: posix.dirname(path), recursive: true }).catch(answer);
			if (body.byteLength <= CHUNK_BYTES) await computer.call("write", { path, data: Buffer.from(body).toString("base64"), ...hold }).catch(answer);
			else {
				// In parts, to a file beside it that takes its place once whole.
				const temporary = `${posix.dirname(path)}/.${posix.basename(path)}.pim-${createHash("sha256").update(`${Date.now()}${Math.random()}`).digest("hex").slice(0, 12)}`;
				try {
					for (let start = 0; start < body.byteLength; start += CHUNK_BYTES) await computer.call("write", { path: temporary, data: Buffer.from(body.subarray(start, start + CHUNK_BYTES)).toString("base64"), append: start > 0 });
					await computer.call("write", { path, from: temporary, ...hold });
				} catch (error) {
					await computer.call("rm", { path: temporary, force: true }).catch(() => undefined);
					return answer(error);
				}
			}
			const stat = await computer.call<{ size: number; mtime: number; sha256: string | null }>("stat", { path });
			const reply: Reply = { status: 200, body: { name: posix.basename(path), path, type: "file", size: stat.size, updatedAt: new Date(stat.mtime).toISOString(), sha256: stat.sha256, mtime: stat.mtime }, headers: { ...noStore, ...(stat.sha256 ? { etag: etag(stat.sha256) } : {}) } };
			return reply;
		}),
		route("DELETE", "/api/files", async (ctx) => {
			const { computer } = await withComputer(ctx, "files");
			const path = checked(ctx.url.searchParams.get("path"));
			if (path === FILES_ROOT) throw new BadRequestError(`${FILES_ROOT} itself can't be deleted`);
			await computer.call("rm", { path, recursive: true }).catch(answer);
			return ok({ deleted: true }, 200, noStore);
		}),

		// Public, as the Worker's were: a machine that has no session fetches them before it has paired, and again to update itself.
		route("GET", "/install.sh", async ({ origin }) => ({ status: 200, headers: { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache" }, raw: installScript(origin) })),
		route("GET", "/pim-computer.ts", async () => ({ status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" }, raw: await readFile(source).catch(() => { throw new NotFoundError("This deployment does not carry pim-computer.ts (set PIM_COMPUTER_SOURCE)"); }) })),
		// displayd, which pim-computer gets from the same Pim to give each thread its own display (displayd/bundle.js): the same bytes for the same files, so a computer can tell by its checksum that it has the newest.
		route("GET", "/displayd.tar.gz", async () => ({ status: 200, headers: { "content-type": "application/gzip", "cache-control": "no-cache" }, raw: displaydBundle() })),
		...TRIGGERS_MODULES.map((file) => route("GET", `/${file}`, async () => ({ status: 200, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-cache" }, raw: await readFile(join(dirname(source), file)).catch(() => { throw new NotFoundError(`This deployment does not carry ${file}`); }) }))),
	];
}
