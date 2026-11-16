// `/api/coding/git/:owner/:name.git/*`: git smart HTTP for the sandboxes, in front of the git host (GitHub App or Gitea).
// A sandbox holds only a `pimgit_` token. Every request is checked against PostgreSQL (the thread's nonce and state, the owner not suspended), a push may only update the thread's own `pim/*` branch (never the default branch, never a delete), and a pushed branch is recorded on the thread.
import { type Row } from "../db";
import { type ForgeStore } from "../store";
import { ForgeError } from "../errors";
import { type GitHost } from "../ports";
import { type Credentials } from "../tokens";
import { type Handler, errorResponse, json, match } from "./common";

/** `repoUrl` is the repository as the thread names it (its provider instance is found from it). Where the host's smart HTTP endpoint is, and how to sign in to it for this repository. The broker never gives this to a sandbox. */
export type GitUpstream = (repoUrl: string, access: "read" | "write") => Promise<{ url: string; authorization: string | null }>;

export type GitBrokerDeps = { credentials: Credentials; store: ForgeStore; git: GitHost; upstream: GitUpstream; fetch?: typeof fetch; maxPushBytes?: number };

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
const FORWARD_RES = ["content-type", "cache-control", "content-encoding"];

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
			const service = url.searchParams.get("service");
			let target: string;
			let op: "read" | "write";
			let who: { threadId: string };
			if (rest === "info/refs" && req.method === "GET" && (service === "git-upload-pack" || service === "git-receive-pack")) {
				op = service === "git-receive-pack" ? "write" : "read";
				who = await d.credentials.verifyGit(token, { repo, op: op === "write" ? "advertise-push" : "fetch" });
				target = `info/refs?service=${service}`;
			} else if (rest === "git-upload-pack" && req.method === "POST") {
				op = "read";
				who = await d.credentials.verifyGit(token, { repo, op: "fetch" });
				target = rest;
			} else if (rest === "git-receive-pack" && req.method === "POST") {
				op = "write";
				return await receive(d, doFetch, req, repo, token);
			} else return json(404, { error: "No such git route", code: "not_found" });
			return await proxy(d, doFetch, req, (await d.store.get(who.threadId))!.repo, op, target, req.method === "POST" ? new Uint8Array(await req.arrayBuffer()) : undefined);
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
	const res = await doFetch(`${up.url.replace(/\/$/, "")}/${target}`, { method: req.method, headers, body: body as BodyInit | undefined, redirect: "manual" });
	const out = new Headers();
	for (const h of FORWARD_RES) if (res.headers.get(h)) out.set(h, res.headers.get(h)!);
	return new Response(res.body, { status: res.status, headers: out });
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
	const thread = (await d.store.get(first.threadId))!;
	const who = await d.credentials.verifyGit(token, { repo, op: "push", branch, defaultBranch: await d.git.defaultBranch(thread.repo) });
	if (thread.branch && thread.branch !== branch) throw new ForgeError("push_refused", `This thread pushes only its own branch, ${thread.branch}`);
	const res = await proxy(d, doFetch, req, thread.repo, "write", "git-receive-pack", body);
	if (res.status !== 200) return res;
	const answer = new Uint8Array(await res.arrayBuffer());
	if (new TextDecoder().decode(answer).includes(`ok ${cmd.ref}`)) {
		await d.store.locked(who.threadId, async (q) => {
			await d.store.patch(q, who.threadId, { last_pushed_sha: cmd.next });
			await d.store.appendEvent(q, who.threadId, { kind: "git.push", data: { branch, sha: cmd.next, via: "sandbox" } });
		});
	}
	return new Response(answer, { status: 200, headers: { "content-type": res.headers.get("content-type") ?? "application/x-git-receive-pack-result" } });
}

export type { Row };
