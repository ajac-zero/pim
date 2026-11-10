import { base64UrlDecode, base64UrlEncode } from "../../auth/encoding";
import { HttpError } from "../../http";
import { type BrokerPolicy, GitBrokerNotConfiguredError } from "./config";
import { apiHeaders, type Fetch, GITHUB_API, type GitHubApp } from "./github-app";
import { GITHUB_INSTANCE, type GitProvider, type ProviderInstance, type ProviderRegistry, basicAuth } from "./provider";

/**
 * The git broker: how a coding thread's workspace works with a GitHub
 * repository without ever holding a GitHub credential.
 *
 * The workspace's `origin` is the broker (./routes.ts), at
 * `https://<your Pim>/api/coding/git/<owner>/<name>.git`, and it signs in
 * with a broker token: an HMAC-signed, expiring token bound to one coding
 * session and one repository (`issueBrokerToken`). The broker clones and
 * fetches for it through GitHub's smart HTTP protocol, with a read-only
 * installation token for that one repository, or anonymously when the
 * GitHub App isn't installed on it (public repositories). It never pushes:
 * GitHub's receive-pack is not proxied.
 *
 * Pushing is Pim's to do (`pushBranch`), when the person approves it or an agent's coding tool runs. The
 * workspace hands Pim a git bundle (`git bundle create <file>
 * origin/<branch>..<branch>`, or the whole branch for a new one): one file,
 * made with git's own tools, that names the branch's new commit and holds
 * the objects it needs as a pack. Pim reads the bundle's header, checks the
 * branch against the rules, and sends the pack unchanged to GitHub's
 * receive-pack with an installation token that may write to that one
 * repository, so the token never leaves Pim. A push never rewrites a branch:
 * a new branch is created only if it still doesn't exist, and an existing
 * one is moved only forward, which GitHub checks: the pack goes to a staging
 * ref, GitHub's API moves the branch with `force: false`, and the staging
 * ref is deleted. Pim pushes to the repository's default branch, `main` or
 * `master` in most, only for a merge (`toDefault`, for a merge by `coding_merge`),
 * which moves the branch only forward. Any other push is to a branch inside the policy's prefix
 * (`pim/`).
 */

export type RepoRef = { readonly owner: string; readonly name: string; readonly fullName: string };

/** A request the broker refuses, with the HTTP status it answers with; the message holds no secret. */
export class GitBrokerError extends HttpError {
	override readonly name = "GitBrokerError";
}

/** A push GitHub refused because the branch has commits the push doesn't: it moved while the push was made. */
export class BranchMovedError extends GitBrokerError {}

const encoder = new TextEncoder();
const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

// Repositories

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Whether the policy lets coding threads use `repo`. */
export function repoAllowed(repo: RepoRef, repos: BrokerPolicy["repos"]): boolean {
	if (repos === null) return true;
	const [owner, name] = [repo.owner.toLowerCase(), repo.name.toLowerCase()];
	return repos.some((pattern) => pattern === `${owner}/${name}` || pattern === `${owner}/*`);
}

/** A repository on github.com by its owner and name (`.git` optional), if both are names GitHub allows and the policy lets it be used. */
export function repoRef(owner: string, name: string, policy: Pick<BrokerPolicy, "repos"> = { repos: null }): RepoRef {
	const bare = name.endsWith(".git") ? name.slice(0, -4) : name;
	if (!OWNER.test(owner) || !NAME.test(bare) || bare === "." || bare === "..") throw new GitBrokerError(400, "That isn't a GitHub repository's owner and name");
	const repo = { owner, name: bare, fullName: `${owner}/${bare}` };
	if (!repoAllowed(repo, policy.repos)) throw new GitBrokerError(403, `This Pim doesn't let coding threads use ${repo.fullName}`);
	return repo;
}

/**
 * A repository's URL, which must be `https://github.com/<owner>/<name>`,
 * with `.git` and a trailing slash optional, and nothing else: no other
 * host or address, no port, no credentials, no query, no escapes.
 */
export function parseRepoUrl(input: string, policy: Pick<BrokerPolicy, "repos"> = { repos: null }): RepoRef {
	const refuse = () => new GitBrokerError(400, "A repository must be https://github.com/<owner>/<name>");
	if (typeof input !== "string" || input.length > 300 || !/^[A-Za-z0-9:/._-]+$/.test(input)) throw refuse();
	const url = URL.parse(input);
	if (!url || url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
		throw refuse();
	}
	const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
	if (parts.length !== 2) throw refuse();
	return repoRef(parts[0]!, parts[1]!, policy);
}

// Branches

/** Branches Pim never pushes to, whatever the repository's default branch is. */
export const PROTECTED_BRANCHES = ["main", "master"] as const;

/**
 * `branch`, if Pim may push to it: a name git allows (as `git
 * check-ref-format` checks it), under the policy's prefix, and not `main`,
 * `master` or the repository's default branch (when known).
 */
export function checkBranch(branch: string, policy: Pick<BrokerPolicy, "branchPrefix">, defaultBranch: string | null = null): string {
	checkBranchName(branch);
	const lower = branch.toLowerCase();
	if ((PROTECTED_BRANCHES as readonly string[]).includes(lower) || (defaultBranch !== null && lower === defaultBranch.toLowerCase())) {
		throw new GitBrokerError(403, `Pim never pushes to ${branch} except to merge a coding thread into it (coding_merge): push to a branch of its own and open a pull request`);
	}
	const prefix = policy.branchPrefix;
	if (prefix !== null && (!branch.startsWith(prefix) || branch.length === prefix.length)) {
		throw new GitBrokerError(403, `Pim pushes only branches whose names start with ${prefix}`);
	}
	return branch;
}

/** `branch`, if it is a name git allows, as `git check-ref-format` checks it. */
export function checkBranchName(branch: string): string {
	const invalid =
		typeof branch !== "string" ||
		branch.length === 0 ||
		branch.length > 200 ||
		/[\u0000-\u0020\u007f~^:?*[\\]/.test(branch) ||
		/\.\.|@\{|\/\/|^\/|\/$|\.$|^-|^refs\/|^HEAD$|^@$/.test(branch) ||
		branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
	if (invalid) throw new GitBrokerError(400, "That isn't a branch name git allows");
	return branch;
}

// Broker tokens

const TOKEN_PREFIX = "pimgit_";
export const BROKER_TOKEN_TTL_MS = 60 * 60_000;
export const MAX_BROKER_TOKEN_TTL_MS = 12 * 60 * 60_000;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** What a broker token lets its holder do: fetch `repo` (`owner/name`, lowercase) for `sessionId` until `expiresAt`. */
export type BrokerClaims = { readonly sessionId: string; readonly repo: string; readonly expiresAt: number; readonly instance: string };

/** The key broker tokens are signed with, derived from `secret` for this use alone. */
export async function brokerKey(secret: string | Uint8Array): Promise<CryptoKey> {
	const raw = typeof secret === "string" ? encoder.encode(secret) : secret;
	const base = await crypto.subtle.importKey("raw", raw as BufferSource, "HKDF", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("pim git broker token v1") }, base, 256);
	return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A token for the workspace of coding session `sessionId` to fetch `repo` with, for `ttlMs` (an hour unless given, 12 hours at most). */
export async function issueBrokerToken(
	key: CryptoKey,
	grant: { sessionId: string; repo: RepoRef; /** A git provider instance's id; GitHub unless given. */ instance?: string; ttlMs?: number; now?: number },
): Promise<string> {
	const ttl = grant.ttlMs ?? BROKER_TOKEN_TTL_MS;
	if (!SESSION_ID.test(grant.sessionId)) throw new GitBrokerError(400, "That isn't a coding session's ID");
	if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_BROKER_TOKEN_TTL_MS) throw new GitBrokerError(400, "A broker token lasts from a moment to 12 hours");
	const claims = { v: 1, sid: grant.sessionId, repo: grant.repo.fullName.toLowerCase(), exp: (grant.now ?? Date.now()) + ttl, ...(grant.instance && grant.instance !== GITHUB_INSTANCE.id ? { inst: grant.instance } : {}) };
	const signed = `${TOKEN_PREFIX}${base64UrlEncode(encoder.encode(JSON.stringify(claims)))}`;
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signed)));
	return `${signed}.${base64UrlEncode(mac)}`;
}

/** The claims of a broker token signed with `key` that hasn't expired, or null. */
export async function verifyBrokerToken(key: CryptoKey, token: string, now = Date.now()): Promise<BrokerClaims | null> {
	if (typeof token !== "string" || token.length > 1024 || !token.startsWith(TOKEN_PREFIX)) return null;
	const [payload, mac, ...rest] = token.slice(TOKEN_PREFIX.length).split(".");
	if (!payload || !mac || rest.length > 0) return null;
	try {
		if (!(await crypto.subtle.verify("HMAC", key, base64UrlDecode(mac), encoder.encode(`${TOKEN_PREFIX}${payload}`)))) return null;
		const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(payload))) as Record<string, unknown>;
		const { v, sid, repo, exp, inst } = claims;
		if (v !== 1 || typeof sid !== "string" || typeof repo !== "string" || typeof exp !== "number" || (inst !== undefined && typeof inst !== "string")) return null;
		return exp > now ? { sessionId: sid, repo, expiresAt: exp, instance: inst ?? GITHUB_INSTANCE.id } : null;
	} catch {
		return null;
	}
}

// Git's wire formats

const ZERO = "0".repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const FLUSH = encoder.encode("0000");

/** One pkt-line: its length, in 4 hex digits that count themselves, then `payload`. */
export function pktLine(payload: string | Uint8Array): Uint8Array {
	const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
	return concat(encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes);
}

/** The pkt-lines in `bytes`, as text, with null for each flush (or delimiter). */
export function readPktLines(bytes: Uint8Array): (string | null)[] {
	const lines: (string | null)[] = [];
	let at = 0;
	while (at < bytes.length) {
		const length = Number.parseInt(latin1(bytes.subarray(at, at + 4)), 16);
		if (!/^[0-9a-f]{4}$/i.test(latin1(bytes.subarray(at, at + 4))) || (length > 0 && length < 4) || at + Math.max(length, 4) > bytes.length) {
			throw new GitBrokerError(502, "GitHub's answer wasn't in git's format");
		}
		if (length <= 2) {
			lines.push(null);
			at += 4;
			continue;
		}
		lines.push(new TextDecoder().decode(bytes.subarray(at + 4, at + length)));
		at += length;
	}
	return lines;
}

/** What a smart HTTP server advertises: its refs and capabilities. */
export function parseAdvertisement(bytes: Uint8Array): { refs: Map<string, string>; capabilities: Set<string> } {
	const lines = readPktLines(bytes);
	if (lines[0]?.startsWith("# service=")) lines.splice(0, lines[1] === null ? 2 : 1);
	const refs = new Map<string, string>();
	let capabilities = new Set<string>();
	for (const [index, line] of lines.entries()) {
		if (line === null) break;
		const [head, caps] = line.replace(/\n$/, "").split("\0");
		if (index === 0 && caps !== undefined) capabilities = new Set(caps.split(" ").filter(Boolean));
		const [sha, ref] = head!.split(" ");
		if (!sha || !SHA.test(sha) || !ref) throw new GitBrokerError(502, "GitHub's list of refs wasn't in git's format");
		if (ref !== "capabilities^{}") refs.set(ref, sha);
	}
	return { refs, capabilities };
}

/** A git bundle: the refs it names, the commits it needs the receiver to have, and its pack. */
export type Bundle = { readonly refs: ReadonlyMap<string, string>; readonly prerequisites: readonly string[]; readonly pack: Uint8Array };

/**
 * Reads a git bundle (v2, or v3 with SHA-1 objects), as `git bundle
 * create` makes it: a header of text, a blank line, then a pack.
 */
export function parseBundle(bytes: Uint8Array): Bundle {
	const refuse = (why: string) => new GitBrokerError(400, `That isn't a git bundle Pim can push: ${why}`);
	let end = -1;
	for (let at = 0; at < Math.min(bytes.length, 1 << 20) - 1; at++) {
		if (bytes[at] === 0x0a && bytes[at + 1] === 0x0a) {
			end = at;
			break;
		}
	}
	if (end < 0) throw refuse("its header doesn't end");
	const [signature, ...lines] = new TextDecoder().decode(bytes.subarray(0, end)).split("\n");
	if (signature !== "# v2 git bundle" && signature !== "# v3 git bundle") throw refuse("it doesn't start with a bundle's signature");
	const refs = new Map<string, string>();
	const prerequisites: string[] = [];
	for (const line of lines) {
		if (line.startsWith("@")) {
			if (signature !== "# v3 git bundle" || line !== "@object-format=sha1") throw refuse(`it has ${line.slice(0, 40)}`);
		} else if (line.startsWith("-")) {
			const sha = line.slice(1, 41);
			if (!SHA.test(sha)) throw refuse("a prerequisite isn't a commit ID");
			prerequisites.push(sha);
		} else {
			const match = /^([0-9a-f]{40}) (\S+)$/.exec(line);
			if (!match) throw refuse("a ref line isn't one");
			refs.set(match[2]!, match[1]!);
		}
	}
	const pack = bytes.subarray(end + 2);
	const version = pack.length >= 12 ? new DataView(pack.buffer, pack.byteOffset).getUint32(4) : 0;
	if (pack.length < 32 || latin1(pack.subarray(0, 4)) !== "PACK" || (version !== 2 && version !== 3)) throw refuse("it holds no pack");
	return { refs, prerequisites, pack };
}

// Pushing

/** The largest bundle Pim pushes: 64 MiB. */
export const MAX_PUSH_BYTES = 64 * 1024 * 1024;

/** A push, as the workspace hands it to Pim: its session, the repository's URL, the branch, and a bundle that names `refs/heads/<branch>`. */
export type PushRequest = {
	readonly sessionId: string;
	readonly repo: string;
	readonly branch: string;
	readonly bundle: Uint8Array;
	/** A merge: `branch` must be the repository's default branch, which is then moved forward and never rewritten. */
	readonly toDefault?: boolean;
};

/** A push Pim checked all it can before asking the person and reaching GitHub. */
export type PreparedPush = {
	readonly sessionId: string;
	readonly repo: RepoRef;
	/** The git provider instance the repository is on. */
	readonly instance: ProviderInstance;
	readonly branch: string;
	/** The commit the branch is to point at. */
	readonly head: string;
	readonly bytes: number;
	readonly pack: Uint8Array;
	readonly toDefault: boolean;
};

/**
 * What the approval-gated `coding_push_for_approval` action files for the person to decide
 * (a later change wires it, through `fileApproval` in
 * ../../extensions/approvals.ts): JSON, with no bundle and no secret.
 */
export type PushApprovalRequest = {
	readonly action: "coding_push_for_approval";
	readonly sessionId: string;
	readonly repo: string;
	readonly branch: string;
	readonly head: string;
	readonly bytes: number;
	/** The one line the person reads to decide. */
	readonly summary: string;
};

export type PushOutcome = "created" | "updated" | "unchanged";

export type PushResult = { readonly repo: string; readonly branch: string; readonly before: string | null; readonly after: string; readonly outcome: PushOutcome };

export type PushDeps = {
	/** The deployment's GitHub App; null when it isn't configured. */
	readonly app: GitHubApp | null;
	readonly policy: BrokerPolicy;
	/** The deployment's git providers: without them, every repository is on GitHub. */
	readonly providers?: ProviderRegistry;
	readonly fetch?: Fetch;
	readonly maxBundleBytes?: number;
};

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** Checks a push without reaching GitHub: the App, the session, the repository, the branch (but for the default one, which GitHub knows), the size and the bundle. */
export function preparePush(deps: PushDeps, request: PushRequest): PreparedPush {
	const resolved = deps.providers?.resolveUrl(request.repo, deps.policy);
	const instance = resolved?.provider.instance ?? GITHUB_INSTANCE;
	if (instance.kind === "github" && !deps.app) throw new GitBrokerNotConfiguredError();
	if (!SESSION_ID.test(request.sessionId)) throw new GitBrokerError(400, "That isn't a coding session's ID");
	const repo = resolved?.repo ?? parseRepoUrl(request.repo, deps.policy);
	const branch = request.toDefault ? checkBranchName(request.branch) : checkBranch(request.branch, deps.policy);
	const max = deps.maxBundleBytes ?? MAX_PUSH_BYTES;
	if (request.bundle.length > max) throw new GitBrokerError(413, `The push is ${size(request.bundle.length)}; Pim pushes at most ${size(max)} at once`);
	const bundle = parseBundle(request.bundle);
	const head = bundle.refs.get(`refs/heads/${branch}`);
	if (!head) throw new GitBrokerError(400, `The bundle doesn't name refs/heads/${branch}`);
	return { sessionId: request.sessionId, repo, instance, branch, head, bytes: request.bundle.length, pack: bundle.pack, toDefault: request.toDefault === true };
}

/** The approval request for a prepared push. */
export function pushApprovalRequest(push: PreparedPush): PushApprovalRequest {
	const { sessionId, repo, branch, head, bytes } = push;
	const summary = `Push ${branch} (${head.slice(0, 12)}, ${size(bytes)}) to ${new URL(push.instance.baseUrl).host}/${repo.fullName}`;
	return { action: "coding_push_for_approval", sessionId, repo: repo.fullName, branch, head, bytes, summary };
}

/** How Pim signs in to github.com's git with an installation token. */
export const gitAuth = (token: string) => `Basic ${btoa(`x-access-token:${token}`)}`;
const clean = (reason: string) => reason.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);

/**
 * Pushes a branch from a coding session's bundle, with the provider's
 * credential for that one repository: an installation token on GitHub, the
 * connected account's OAuth token on Gitea. Call it only after the person
 * approved `pushApprovalRequest(preparePush(...))`. It never rewrites the
 * branch: see the top of this file.
 */
export async function pushBranch(deps: PushDeps, request: PushRequest): Promise<PushResult> {
	const push = preparePush(deps, request);
	if (push.instance.kind === "gitea") return pushToGitProvider(deps, push);
	const { repo, branch, head, pack } = push;
	const call = callWith(deps, "GitHub");
	const { token } = await deps.app!.installationToken(repo, "write");
	const api = `${GITHUB_API}/repos/${repo.owner}/${repo.name}`;
	const git = `https://github.com/${repo.owner}/${repo.name}.git`;
	const gitHeaders = { Authorization: gitAuth(token), "User-Agent": "git/pim-git-broker" };

	const about = await call(api, { headers: apiHeaders(`Bearer ${token}`) });
	if (!about.ok) throw new GitBrokerError(502, `GitHub answered HTTP ${about.status} when asked about ${repo.fullName}`);
	const { default_branch: defaultBranch } = (await about.json()) as { default_branch?: unknown };
	if (push.toDefault) {
		if (branch !== defaultBranch) throw new GitBrokerError(409, `${branch} isn't ${repo.fullName}'s default branch${typeof defaultBranch === "string" ? `, ${defaultBranch}` : ""}`);
	} else checkBranch(branch, deps.policy, typeof defaultBranch === "string" ? defaultBranch : null);

	const { refs, caps } = await advertise(call, git, gitHeaders, repo, "GitHub");
	const receivePack = (commands: [string, string, string][], body: Uint8Array | null) => sendReceivePack(call, git, gitHeaders, caps, "GitHub", commands, body);

	const ref = `refs/heads/${branch}`;
	const before = refs.get(ref) ?? null;
	const log = (outcome: string) => console.log(JSON.stringify({ event: "pim.git_broker.push", session: push.sessionId, repo: repo.fullName, branch, outcome }));
	if (before === head) {
		log("unchanged");
		return { repo: repo.fullName, branch, before, after: head, outcome: "unchanged" };
	}
	if (before === null) {
		// A new branch: receive-pack creates it only if it still doesn't exist.
		await receivePack([[ZERO, head, ref]], pack);
		log("created");
		return { repo: repo.fullName, branch, before, after: head, outcome: "created" };
	}
	// An existing branch moves only forward: the objects go to a staging ref, and GitHub's API moves the branch without force.
	const staging = `refs/pim-staging/${crypto.randomUUID()}`;
	await receivePack([[ZERO, head, staging]], pack);
	try {
		const moved = await call(`${api}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, {
			method: "PATCH",
			headers: { ...apiHeaders(`Bearer ${token}`), "Content-Type": "application/json" },
			body: JSON.stringify({ sha: head, force: false }),
		});
		if (moved.status === 422) {
			throw new BranchMovedError(409, `${branch} on GitHub has commits this push doesn't: fetch it, rebase onto it, and push again`);
		}
		if (!moved.ok) throw new GitBrokerError(502, `GitHub answered HTTP ${moved.status} when moving ${branch}`);
	} finally {
		await deleteStaging(receivePack, repo, head, staging);
	}
	log("updated");
	return { repo: repo.fullName, branch, before, after: head, outcome: "updated" };
}

/** `fetch` for a provider's answers: no redirects, a time limit, and a refusal of its own when the host can't be reached. */
function callWith(deps: PushDeps, name: string) {
	const send = deps.fetch ?? ((input, init) => fetch(input, init));
	return async (url: string, init: RequestInit) => {
		try {
			return await send(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(120_000) });
		} catch {
			throw new GitBrokerError(502, `${name} couldn't be reached`);
		}
	};
}

type Call = ReturnType<typeof callWith>;

/** What the host's receive-pack says of the repository's branches, and the capabilities Pim asks for. */
async function advertise(call: Call, git: string, gitHeaders: Record<string, string>, repo: RepoRef, name: string) {
	const advertised = await call(`${git}/info/refs?service=git-receive-pack`, { headers: gitHeaders });
	if (!advertised.ok || advertised.headers.get("content-type") !== "application/x-git-receive-pack-advertisement") {
		throw new GitBrokerError(502, `${name} answered HTTP ${advertised.status} when asked for ${repo.fullName}'s branches`);
	}
	const { refs, capabilities } = parseAdvertisement(new Uint8Array(await advertised.arrayBuffer()));
	for (const needed of ["report-status", "delete-refs", "ofs-delta"]) {
		if (!capabilities.has(needed)) throw new GitBrokerError(502, `${name}'s receive-pack lacks ${needed}`);
	}
	return { refs, caps: ["report-status", ...(capabilities.has("quiet") ? ["quiet"] : []), "agent=pim-git-broker"].join(" ") };
}

/** Sends ref updates (old, new, ref) and a pack to receive-pack, and checks that each was made. */
async function sendReceivePack(call: Call, git: string, gitHeaders: Record<string, string>, caps: string, name: string, commands: [string, string, string][], body: Uint8Array | null) {
	const lines = commands.map(([old, next, ref], index) => pktLine(`${old} ${next} ${ref}${index === 0 ? `\0${caps}` : ""}\n`));
	const response = await call(`${git}/git-receive-pack`, {
		method: "POST",
		headers: { ...gitHeaders, "Content-Type": "application/x-git-receive-pack-request", Accept: "application/x-git-receive-pack-result" },
		body: concat(...lines, FLUSH, body ?? new Uint8Array(0)),
	});
	if (!response.ok) throw new GitBrokerError(502, `${name} answered HTTP ${response.status} to the push`);
	const report = readPktLines(new Uint8Array(await response.arrayBuffer())).filter((line): line is string => line !== null).map((line) => line.replace(/\n$/, ""));
	if (report[0] !== "unpack ok") throw new GitBrokerError(502, `${name} couldn't unpack the push: ${clean(report[0] ?? "no report")}`);
	for (const [, , ref] of commands) {
		const line = report.find((entry) => entry === `ok ${ref}` || entry.startsWith(`ng ${ref} `));
		if (line !== `ok ${ref}`) throw new GitBrokerError(409, `${name} refused to update ${ref}: ${clean(line?.slice(`ng ${ref} `.length) ?? "no report")}`);
	}
}

async function deleteStaging(receivePack: (commands: [string, string, string][], body: Uint8Array | null) => Promise<void>, repo: RepoRef, head: string, staging: string) {
	await receivePack([[head, ZERO, staging]], null).catch((error: unknown) => {
		console.error(JSON.stringify({ event: "pim.git_broker.staging_left", repo: repo.fullName, ref: staging, error: error instanceof Error ? error.message : String(error) }));
	});
}

/** A pack with no objects, which receive-pack takes when the commit it is to point a ref at is already there. */
async function emptyPack(): Promise<Uint8Array> {
	const header = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
	return concat(header, new Uint8Array(await crypto.subtle.digest("SHA-1", header as BufferSource)));
}

/**
 * The push for a provider with no API to move a branch forward only
 * (Gitea): receive-pack alone, with its credential. A new branch is created
 * only if it still doesn't exist. An existing one is moved in three steps:
 * the pack goes to a staging branch, which makes the objects reachable; the
 * provider says whether the branch's commit is an ancestor of the new one,
 * so that it only moves forward; and the branch is updated from the commit
 * seen to the new one, which receive-pack refuses if the branch moved since.
 */
async function pushToGitProvider(deps: PushDeps, push: PreparedPush): Promise<PushResult> {
	const { repo, branch, head, pack } = push;
	const provider: GitProvider = deps.providers!.get(push.instance.id);
	const name = provider.instance.label;
	const call = callWith(deps, name);
	const credential = await provider.credential(repo, "write");
	if (!credential) throw new GitBrokerNotConfiguredError();
	const git = provider.gitUrl(repo);
	const gitHeaders = { Authorization: basicAuth(credential), "User-Agent": "git/pim-git-broker" };

	const defaultBranch = await provider.defaultBranch(repo);
	if (push.toDefault) {
		if (branch !== defaultBranch) throw new GitBrokerError(409, `${branch} isn't ${repo.fullName}'s default branch, ${defaultBranch}`);
	} else checkBranch(branch, deps.policy, defaultBranch);

	const { refs, caps } = await advertise(call, git, gitHeaders, repo, name);
	const receivePack = (commands: [string, string, string][], body: Uint8Array | null) => sendReceivePack(call, git, gitHeaders, caps, name, commands, body);
	const ref = `refs/heads/${branch}`;
	const before = refs.get(ref) ?? null;
	const log = (outcome: string) => console.log(JSON.stringify({ event: "pim.git_broker.push", session: push.sessionId, repo: repo.fullName, branch, instance: push.instance.id, outcome }));
	if (before === head) {
		log("unchanged");
		return { repo: repo.fullName, branch, before, after: head, outcome: "unchanged" };
	}
	if (before === null) {
		await receivePack([[ZERO, head, ref]], pack);
		log("created");
		return { repo: repo.fullName, branch, before, after: head, outcome: "created" };
	}
	if (!provider.isAncestor) throw new GitBrokerError(502, `${name} can't tell whether a push only moves ${branch} forward`);
	const moved = () => new BranchMovedError(409, `${branch} on ${name} has commits this push doesn't: fetch it, rebase onto it, and push again`);
	const staging = `refs/heads/pim-staging/${crypto.randomUUID()}`;
	await receivePack([[ZERO, head, staging]], pack);
	try {
		if (!(await provider.isAncestor(repo, before, head))) throw moved();
		try {
			await receivePack([[before, head, ref]], await emptyPack());
		} catch (error) {
			// Refused: if the branch is no longer where it was, it moved meanwhile.
			if (error instanceof GitBrokerError && error.status === 409 && (await advertise(call, git, gitHeaders, repo, name)).refs.get(ref) !== before) throw moved();
			throw error;
		}
	} finally {
		await deleteStaging(receivePack, repo, head, staging);
	}
	log("updated");
	return { repo: repo.fullName, branch, before, after: head, outcome: "updated" };
}

/** The name of the repository's default branch, from GitHub, for a merge. */
export async function repoDefaultBranch(deps: PushDeps, repoUrl: string): Promise<string> {
	if (!deps.app) throw new GitBrokerNotConfiguredError();
	const repo = parseRepoUrl(repoUrl, deps.policy);
	const { token } = await deps.app.installationToken(repo, "write");
	const send = deps.fetch ?? ((input, init) => fetch(input, init));
	let about: Response;
	try {
		about = await send(`${GITHUB_API}/repos/${repo.owner}/${repo.name}`, { headers: apiHeaders(`Bearer ${token}`), redirect: "manual", signal: AbortSignal.timeout(120_000) });
	} catch {
		throw new GitBrokerError(502, "GitHub couldn't be reached");
	}
	if (!about.ok) throw new GitBrokerError(502, `GitHub answered HTTP ${about.status} when asked about ${repo.fullName}`);
	const { default_branch: name } = (await about.json()) as { default_branch?: unknown };
	if (typeof name !== "string") throw new GitBrokerError(502, `GitHub didn't say ${repo.fullName}'s default branch`);
	return checkBranchName(name);
}
