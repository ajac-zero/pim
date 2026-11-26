// Short-lived, job-scoped credentials a sandbox may hold: pimgit_ (git broker) and pimgw_ (model gateway).
// The HMAC proves who minted a token; whether it still works is read from PostgreSQL on every use, so archiving, aborting or suspending cuts it off at once.
// Nothing here is a PostgreSQL or runtime credential: a sandbox only ever sees one of these.
import { createHmac, timingSafeEqual } from "node:crypto";
import { type Db, type Row, scopedDb } from "./db";
import { ForbiddenError, ForgeError } from "./errors";
import { assertPushBranch, repoName } from "./authz";
import { ownBranch } from "./store";

export const MAX_TOKEN_TTL_MS = 12 * 3_600_000;
export const DEFAULT_TOKEN_TTL_MS = 3_600_000;

type Claims = { v: 1; t: string; thread: string; owner: string; nonce: string; exp: number; repo?: string; scope?: "read" | "push"; families?: string[] };

const b64 = (b: Buffer | string) => Buffer.from(b).toString("base64url");
const sign = (key: string, body: string) => createHmac("sha256", key).update(body).digest();

function mint(prefix: "pimgit_" | "pimgw_", key: string, claims: Claims): string {
	const body = b64(JSON.stringify(claims));
	return `${prefix}${body}.${b64(sign(key, `${prefix}${body}`))}`;
}

function open(prefix: string, key: string, token: string, now: number): Claims {
	const bad = () => new ForbiddenError("credential", "invalid");
	if (typeof token !== "string" || !token.startsWith(prefix)) throw bad();
	const [body, mac] = token.slice(prefix.length).split(".");
	if (!body || !mac) throw bad();
	const want = sign(key, `${prefix}${body}`);
	const got = Buffer.from(mac, "base64url");
	if (got.length !== want.length || !timingSafeEqual(got, want)) throw bad();
	const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Claims;
	if (claims.exp <= now) throw new ForbiddenError("credential", "this credential has expired");
	return claims;
}

export class Credentials {
	constructor(
		private readonly db: Db,
		private readonly key: string,
		private readonly clock: () => number = Date.now,
		/** Reads a token's thread under its owner's row-level security scope: for a process, the Gate's, that is subject to it. */
		private readonly scoped = false,
	) {}

	gitToken(thread: { threadId: string; ownerId: string; gatewayNonce: string }, o: { repo: string; scope: "read" | "push"; ttlMs?: number }): string {
		const name = repoName(o.repo);
		if (!name) throw new ForgeError("invalid", `Not a repository: ${o.repo}`);
		const ttl = Math.min(o.ttlMs ?? DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
		return mint("pimgit_", this.key, { v: 1, t: "git", thread: thread.threadId, owner: thread.ownerId, nonce: thread.gatewayNonce, exp: this.clock() + ttl, repo: name, scope: o.scope });
	}

	gatewayToken(thread: { threadId: string; ownerId: string; gatewayNonce: string }, o: { families: string[]; ttlMs?: number }): string {
		const ttl = Math.min(o.ttlMs ?? DEFAULT_TOKEN_TTL_MS, MAX_TOKEN_TTL_MS);
		return mint("pimgw_", this.key, { v: 1, t: "gw", thread: thread.threadId, owner: thread.ownerId, nonce: thread.gatewayNonce, exp: this.clock() + ttl, families: o.families });
	}

	/** The thread must still be live, with the same nonce, and its owner not suspended. */
	private async live(c: Claims): Promise<Row> {
		const row = (
			await (this.scoped ? scopedDb(this.db, c.owner) : this.db).query<Row>(
				`select t.*, o.suspended_at from pim_forge.forge_threads t left join pim_forge.forge_owners o on o.owner_id = t.owner_id where t.thread_id = $1`,
				[c.thread],
			)
		).rows[0];
		if (!row || row.owner_id !== c.owner || row.gateway_nonce !== c.nonce) throw new ForbiddenError("credential", "this credential was revoked");
		if (row.state === "archived" || row.archived_at || row.cancel_state === "requested" || row.cancel_state === "cancelled" || row.cancel_state === "uncertain") throw new ForbiddenError("credential", "this thread no longer holds credentials");
		if (row.suspended_at) throw new ForbiddenError("credential", "this account is suspended");
		return row;
	}

	/** Clone/fetch need a read or push token for the repository; a pull request needs a push token; a push also needs exactly the thread's own branch, which is never the default. */
	async verifyGit(token: string, access: { repo: string; op: "fetch" | "push" | "advertise-push" | "pull-request"; branch?: string; defaultBranch?: string }): Promise<{ threadId: string; ownerId: string }> {
		const c = open("pimgit_", this.key, token, this.clock());
		if (c.repo !== repoName(access.repo)) throw new ForbiddenError("credential", "this credential is for another repository");
		const row = await this.live(c);
		if ((access.op === "advertise-push" || access.op === "pull-request") && c.scope !== "push") throw new ForgeError("push_refused", "This credential can only fetch");
		if (access.op === "push") {
			if (c.scope !== "push") throw new ForgeError("push_refused", "This credential can only fetch");
			assertPushBranch(access.branch ?? "", access.defaultBranch ?? "main", ownBranch({ harness: row.harness as string, task: row.task as string, threadId: row.thread_id as string, branch: row.branch as string | null }));
		}
		return { threadId: c.thread, ownerId: c.owner };
	}

	/** The workspace's credential helper trades its grant for a fresh one of the same repository and scope, while the thread is live. */
	async refreshGit(token: string): Promise<string> {
		const c = open("pimgit_", this.key, token, this.clock());
		const row = await this.live(c);
		return this.gitToken({ threadId: c.thread, ownerId: c.owner, gatewayNonce: row.gateway_nonce }, { repo: c.repo!, scope: c.scope! });
	}

	async verifyGateway(token: string, family: string): Promise<{ threadId: string; ownerId: string }> {
		const c = open("pimgw_", this.key, token, this.clock());
		if (!c.families?.includes(family)) throw new ForbiddenError("credential", "this credential doesn't cover that model family");
		await this.live(c);
		return { threadId: c.thread, ownerId: c.owner };
	}
}
