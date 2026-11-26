// `/api/coding/git/:owner/:name.git/*`: git smart HTTP for the sandboxes, in front of the git host (GitHub App or Gitea).
// A sandbox holds only a `pimgit_` token. Every request is checked against PostgreSQL (the thread's nonce and state, the owner not suspended), a push may only update exactly the thread's own branch (never the default branch, never another, never a delete), and a pushed branch is recorded on the thread.
import { createHash, randomUUID } from "node:crypto";
import { MAX_FETCH_RESPONSE_BYTES, MAX_UPLOAD_REQUEST_BYTES, askWithRetries } from "@pim/coding/git-broker/routes";
import { type Row } from "../db";
import { type ForgeStore, ownBranch } from "../store";
import { ForgeError } from "../errors";
import { type GitHost } from "../ports";
import { type Credentials } from "../tokens";
import { openThreadPullRequest } from "../forge";
import { type Handler, errorResponse, json, match } from "./common";

/** `repoUrl` is the repository as the thread names it (its provider instance is found from it). Where the host's smart HTTP endpoint is, and how to sign in to it for this repository. The broker never gives this to a sandbox. */
export type GitUpstream = (repoUrl: string, access: "read" | "write") => Promise<{ url: string; authorization: string | null }>;

export type GitBrokerDeps = { credentials: Credentials; store: ForgeStore; /** The store as one owner's requests see it (row-level security); the Gate's. */ scope?: (ownerId: string) => ForgeStore; git: GitHost; upstream: GitUpstream; fetch?: typeof fetch; maxPushBytes?: number; /** The most a fetch's negotiation may weigh, and the most the broker passes on of the host's answer to one; the coding package's limits unless given. */ maxRequestBytes?: number; maxResponseBytes?: number; /** How the broker waits between its tries at a host that is rate limiting or briefly down; tests give their own. */ sleep?: (ms: number) => Promise<void>; random?: () => number };

export const MAX_PUSH_BYTES = 64 * 1024 * 1024;
const ZERO = "0".repeat(40);

/** The token a git client sent: HTTP basic (the credential helper's password) or a bearer. */
export function tokenOf(req: Request): string | null {
	const h = req.headers.get("authorization") ?? "";
	if (h.startsWith("Bearer ")) return h.slice(7).trim();
	if (h.startsWith("Basic ")) {
		const decoded = atob(h.slice(6).trim());
		return decoded.slice(decoded.indexOf(":") + 1);
	}
	return null;
}

/** The ref updates a receive-pack request asks for: pkt-lines of `old new ref` up to the flush, the first carrying capabilities after a NUL. */
export function pushCommands(body: Uint8Array): { old: string; next: string; ref: string }[] {
	const out: { old: string; next: string; ref: string }[] = [];
	let at = 0;
	for (;;) {
		if (at + 4 > body.length) throw new ForgeError("invalid", "Malformed push");
		const len = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
		if (!Number.isFinite(len)) throw new ForgeError("invalid", "Malformed push");
		if (len === 0) return out;
		if (len < 4 || at + len > body.length) throw new ForgeError("invalid", "Malformed push");
		const line = new TextDecoder().decode(body.subarray(at + 4, at + len)).split("\0")[0]!.trim();
		const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/.exec(line);
		if (m) out.push({ old: m[1]!, next: m[2]!, ref: m[3]! });
		at += len;
	}
}

const FORWARD_REQ = ["content-type", "content-encoding", "accept", "accept-encoding", "git-protocol"];
const FORWARD_RES = ["content-type", "cache-control", "content-encoding", "retry-after"];

export function gitBroker(d: GitBrokerDeps): Handler {
	const doFetch = d.fetch ?? fetch;
	return async (req) => {
		const url = new URL(req.url);
		const m = match("/api/coding/git/:owner/:repo/*", url.pathname);
		if (!m || !String(m.repo).endsWith(".git")) return null;
		const repo = `${m.owner}/${String(m.repo).slice(0, -4)}`;
		const rest = m["*"] as string;
		try {
			const token = tokenOf(req);
			if (!token) return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="Pim"' } });
			// The workspace's credential helper trades its grant for a fresh one.
			if (rest === "credential" && req.method === "POST") {
				await d.credentials.verifyGit(token, { repo, op: "fetch" });
				return json(200, { token: await d.credentials.refreshGit(token) });
			}
			// The workspace asks for the pull request of its own thread's branch; nothing here merges.
			if (rest === "pull-request" && req.method === "POST") return await pullRequest(d, req, repo, token);
			const service = url.searchParams.get("service");
			let target: string;
			let op: "read" | "write";
			let who: { threadId: string; ownerId: string };
			if (rest === "info/refs" && req.method === "GET" && (service === "git-upload-pack" || service === "git-receive-pack")) {
				op = service === "git-receive-pack" ? "write" : "read";
				who = await d.credentials.verifyGit(token, { repo, op: op === "write" ? "advertise-push" : "fetch" });
				target = `info/refs?service=${service}`;
			} else if (rest === "git-upload-pack" && req.method === "POST") {
				op = "read";
				who = await d.credentials.verifyGit(token, { repo, op: "fetch" });
				target = rest;
				// What git sends while negotiating a fetch is small; a request past the limit is refused unread.
				if (Number(req.headers.get("content-length") ?? 0) > (d.maxRequestBytes ?? MAX_UPLOAD_REQUEST_BYTES)) return json(413, { error: "The request is too big", code: "push_refused" });
			} else if (rest === "git-receive-pack" && req.method === "POST") {
				op = "write";
				return await receive(d, doFetch, req, repo, token);
			} else return json(404, { error: "No such git route", code: "not_found" });
			const sent = req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined;
			if (sent && sent.length > (d.maxRequestBytes ?? MAX_UPLOAD_REQUEST_BYTES)) return json(413, { error: "The request is too big", code: "push_refused" });
			return await proxy(d, doFetch, req, (await storeOf(d, who.ownerId).get(who.threadId))!.repo, op, target, sent);
		} catch (e) {
			// A refusal from git's side reads best as a plain status: the sandbox's git prints it.
			const r = errorResponse(e);
			return new Response(await r.text(), { status: r.status === 500 ? 502 : r.status, headers: { "content-type": "application/json" } });
		}
	};
}

async function proxy(d: GitBrokerDeps, doFetch: typeof fetch, req: Request, repoUrl: string, op: "read" | "write", target: string, body: Uint8Array | undefined): Promise<Response> {
	const up = await d.upstream(repoUrl, op);
	const headers = new Headers();
	for (const h of FORWARD_REQ) if (req.headers.get(h)) headers.set(h, req.headers.get(h)!);
	if (up.authorization) headers.set("authorization", up.authorization);
	const ask = () => doFetch(`${up.url.replace(/\/$/, "")}/${target}`, { method: req.method, headers, body: body as BodyInit | undefined, redirect: "manual" });
	// A read is safe to repeat (its body is held here): a host that is rate limiting or briefly down is asked again after a pause, as long as it asks or by backoff. A push is not repeated.
	const res = op === "read" ? (await askWithRetries(d, ask)).answer : await ask();
	const out = new Headers();
	for (const h of FORWARD_RES) if (res.headers.get(h)) out.set(h, res.headers.get(h)!);
	if (op !== "read" || !res.body) return new Response(res.body, { status: res.status, headers: out });
	// What the host answers is passed on up to a limit: a repository larger than that is cut off, which git reports.
	const max = d.maxResponseBytes ?? MAX_FETCH_RESPONSE_BYTES;
	let seen = 0;
	const capped = res.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > max) throw new ForgeError("push_refused", `The repository is larger than the ${max} bytes the broker passes on at once`);
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(capped, { status: res.status, headers: out });
}

/** Opens the pull request for the token's own thread: its branch into its base, as `Forge.openPullRequest` does. The body can only name a title and a description. */
async function pullRequest(d: GitBrokerDeps, req: Request, repo: string, token: string): Promise<Response> {
	const who = await d.credentials.verifyGit(token, { repo, op: "pull-request" });
	let sent: { title?: unknown; body?: unknown } = {};
	const raw = await req.text();
	if (raw.length > 100_000) return json(413, { error: "The request is too big", code: "invalid" });
	if (raw.trim()) {
		try {
			sent = JSON.parse(raw);
		} catch {
			throw new ForgeError("invalid", "The body must be JSON");
		}
	}
	if (!sent || typeof sent !== "object" || (sent.title !== undefined && typeof sent.title !== "string") || (sent.body !== undefined && typeof sent.body !== "string")) throw new ForgeError("invalid", "title and body must be text");
	const store = storeOf(d, who.ownerId);
	const thread = (await store.get(who.threadId))!;
	const pr = await openThreadPullRequest({ git: d.git, store }, thread, sent.title?.slice(0, 256), sent.body?.slice(0, 60_000));
	return json(200, { url: pr.url, number: pr.number, title: pr.title, base: pr.base, head: pr.head });
}

async function receive(d: GitBrokerDeps, doFetch: typeof fetch, req: Request, repo: string, token: string): Promise<Response> {
	const max = d.maxPushBytes ?? MAX_PUSH_BYTES;
	if (Number(req.headers.get("content-length") ?? 0) > max) return json(413, { error: "The push is too big", code: "push_refused" });
	const body = new Uint8Array(await req.arrayBuffer());
	if (body.length > max) return json(413, { error: "The push is too big", code: "push_refused" });
	const commands = pushCommands(body);
	// One branch at a time: the thread's own, as a plain create or update.
	if (commands.length !== 1) throw new ForgeError("push_refused", "A push updates exactly one branch");
	const cmd = commands[0]!;
	if (!cmd.ref.startsWith("refs/heads/")) throw new ForgeError("push_refused", "Only branches can be pushed");
	if (cmd.next === ZERO) throw new ForgeError("push_refused", "A branch can't be deleted through a push");
	const branch = cmd.ref.slice("refs/heads/".length);
	const first = await d.credentials.verifyGit(token, { repo, op: "advertise-push" });
	const thread = (await storeOf(d, first.ownerId).get(first.threadId))!;
	const who = await d.credentials.verifyGit(token, { repo, op: "push", branch, defaultBranch: await d.git.defaultBranch(thread.repo) });
	if (!thread.branch || thread.branch !== branch || ownBranch(thread) !== branch) throw new ForgeError("push_refused", thread.branch ? `This thread pushes only its own branch, ${thread.branch}` : "This thread has no branch of its own to push");
	const send = (b: Uint8Array) => proxy(d, doFetch, new Request(req.url, { method: "POST", headers: req.headers }), thread.repo, "write", "git-receive-pack", b);
	let answer: Uint8Array;
	let status = 200;
	let contentType = "application/x-git-receive-pack-result";
	if (cmd.old === ZERO) {
		const res = await send(body);
		status = res.status;
		contentType = res.headers.get("content-type") ?? contentType;
		answer = new Uint8Array(await res.arrayBuffer());
	} else {
		// An update must be a fast-forward. The pack goes up under a staging ref first so the host has the new commit, the host says whether the old tip leads to it,
		// and only then does the branch move (by an empty pack, with the old tip as its guard) and the staging ref go.
		if (!d.git.isAncestor) throw new ForgeError("push_refused", "This git host can't tell whether a push only moves the branch forward, so only its first push is taken");
		const caps = capabilitiesOf(body);
		const staging = `refs/heads/pim-staging/${randomUUID()}`;
		const staged = await send(withCommand(body, ZERO, cmd.next, staging));
		const stagedText = new TextDecoder("latin1").decode(new Uint8Array(await staged.arrayBuffer()));
		if (staged.status !== 200 || !stagedText.includes(`ok ${staging}`)) return report(caps, cmd.ref, "ng", "the host refused the push", 200);
		try {
			if (!(await d.git.isAncestor(thread.repo, cmd.old, cmd.next))) throw new ForgeError("push_refused", `This isn't a fast-forward of ${branch}: fetch it, rebase onto it and push again; a force push is refused`);
			const moved = await send(commandPacket(cmd.old, cmd.next, cmd.ref, "report-status", EMPTY_PACK));
			if (moved.status !== 200 || !new TextDecoder("latin1").decode(new Uint8Array(await moved.arrayBuffer())).includes(`ok ${cmd.ref}`)) return report(caps, cmd.ref, "ng", "the branch moved meanwhile: fetch and try again", 200);
		} finally {
			await send(commandPacket(cmd.next, ZERO, staging, "report-status delete-refs")).then((r) => r.arrayBuffer()).catch(() => {});
		}
		return await recorded(d, who.ownerId, who.threadId, branch, cmd.next, report(caps, cmd.ref, "ok", ""));
	}
	if (status !== 200) return new Response(answer, { status, headers: { "content-type": contentType } });
	if (new TextDecoder().decode(answer).includes(`ok ${cmd.ref}`)) await record(d, who.ownerId, who.threadId, branch, cmd.next);
	return new Response(answer, { status: 200, headers: { "content-type": contentType } });
}

async function record(d: GitBrokerDeps, ownerId: string, threadId: string, branch: string, sha: string) {
	const store = storeOf(d, ownerId);
	await store.locked(threadId, async (q) => {
		await store.patch(q, threadId, { last_pushed_sha: sha });
		await store.appendEvent(q, threadId, { kind: "git.push", data: { branch, sha, via: "sandbox" } });
	});
}

async function recorded(d: GitBrokerDeps, ownerId: string, threadId: string, branch: string, sha: string, res: Response): Promise<Response> {
	await record(d, ownerId, threadId, branch, sha);
	return res;
}

const enc = new TextEncoder();
const pkt = (text: string | Uint8Array) => {
	const body = typeof text === "string" ? enc.encode(text) : text;
	return new Uint8Array([...enc.encode((body.length + 4).toString(16).padStart(4, "0")), ...body]);
};
const FLUSH = enc.encode("0000");
/** An empty pack: the header with no objects, and its checksum. */
const EMPTY_PACK = (() => {
	const header = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
	return new Uint8Array([...header, ...createHash("sha1").update(header).digest()]);
})();

/** One command, its capabilities, the flush, and a pack when there is one. */
function commandPacket(old: string, next: string, ref: string, caps: string, pack?: Uint8Array): Uint8Array {
	return new Uint8Array([...pkt(`${old} ${next} ${ref}\0 ${caps}\n`), ...FLUSH, ...(pack ?? [])]);
}

/** The capabilities the client sent on its first command line. */
const storeOf = (d: GitBrokerDeps, ownerId: string) => d.scope?.(ownerId) ?? d.store;

function capabilitiesOf(body: Uint8Array): string[] {
	const len = Number.parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16);
	const line = new TextDecoder().decode(body.subarray(4, len));
	return (line.split("\0")[1] ?? "").trim().split(" ").filter(Boolean);
}

/** The request with its one command rewritten to another ref, the capabilities and the pack kept. */
function withCommand(body: Uint8Array, old: string, next: string, ref: string): Uint8Array {
	const len = Number.parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16);
	const caps = new TextDecoder().decode(body.subarray(4, len)).split("\0")[1] ?? "";
	return new Uint8Array([...pkt(`${old} ${next} ${ref}\0${caps}`), ...body.subarray(len)]);
}

/** What the client's git is answered, in the framing it asked for: `unpack ok`, and `ok` or `ng` for its branch. */
function report(caps: string[], ref: string, result: "ok" | "ng", why: string, status = 200): Response {
	const lines = new Uint8Array([...pkt("unpack ok\n"), ...pkt(result === "ok" ? `ok ${ref}\n` : `ng ${ref} ${why}\n`), ...FLUSH]);
	const body = caps.some((c) => c.startsWith("side-band")) ? new Uint8Array([...pkt(new Uint8Array([1, ...lines])), ...FLUSH]) : lines;
	return new Response(body, { status, headers: { "content-type": "application/x-git-receive-pack-result" } });
}

export type { Row };
