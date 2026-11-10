import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BranchMovedError, brokerKey, issueBrokerToken, pktLine, preparePush, pushApprovalRequest, pushBranch, type RepoRef } from "../src/coding/git-broker/broker";
import { giteaBaseUrl, giteaConfig } from "../src/coding/git-broker/config";
import { GiteaConnection, GiteaNotConnectedError, giteaKeyFrom, REFRESH_MARGIN_MS } from "../src/coding/git-broker/gitea-connection";
import { giteaInstance, GiteaProvider } from "../src/coding/git-broker/gitea-provider";
import { GitHubProvider } from "../src/coding/git-broker/github-provider";
import { ProviderRegistry } from "../src/coding/git-broker/provider";
import { type GitBrokerDeps, handleGitBroker, deploymentProviders, directoryGiteaBackend } from "../src/coding/git-broker/routes";
import { api } from "./helpers";

// Gitea is always a fake one here: nothing reaches the network. The instance is the one Pim is deployed with.

const BASE = "https://gitea.example.test";
const ID = "gitea";
const CLIENT = { baseUrl: BASE, clientId: "client-id-123", clientSecret: "CLIENT-SECRET-xyz" };
const REDIRECT = "https://pim.ajac-zero.com/api/coding/gitea/callback";
const SHA = (digit: string) => digit.repeat(40);
const ZERO = SHA("0");
const WIDGETS: RepoRef = { owner: "acme", name: "widgets", fullName: "acme/widgets" };
const POLICY = { branchPrefix: "pim/", repos: null };
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const HOUR = 60 * 60_000;

type Call = { method: string; url: string; headers: Headers; body: Uint8Array };

/** Gitea's OAuth endpoints, which rotate the refresh token as Gitea does, and answer the API calls a repository needs. */
function fakeGitea() {
	const calls: Call[] = [];
	const state = {
		now: Date.UTC(2026, 10, 10, 12, 0, 0),
		/** The refresh token Gitea honors; any other is refused, and each use of it replaces it. */
		refresh: null as string | null,
		issued: 0,
		/** Set to make the token endpoint fail instead. */
		tokenStatus: null as number | null,
		/** Branches of acme/widgets and what each has as ancestors. */
		branches: { trunk: SHA("1") } as Record<string, string>,
		ancestors: {} as Record<string, string[]>,
		defaultBranch: "trunk",
		/** Pushes' ref updates as received, and the lengths of their packs. */
		updates: [] as { command: string; packBytes: number }[],
		/** A branch that another push moves while the update is in flight. */
		movesBeforeUpdate: null as { ref: string; to: string } | null,
		/** The open pull requests of acme/widgets, and the status Gitea gives a new one when it isn't made (409: one is open from the branch already). */
		pulls: [] as { number: number; html_url: string; head: { ref: string }; base: { ref: string } }[],
		pullStatus: null as number | null,
	};
	const issue = (code: string) => {
		state.issued += 1;
		state.refresh = `refresh-${state.issued}`;
		return Response.json({ access_token: `access-${state.issued}`, refresh_token: state.refresh, token_type: "bearer", expires_in: 3600, code });
	};
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const call: Call = { method: request.method, url: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) };
		calls.push(call);
		const url = new URL(call.url);
		if (call.method === "POST" && url.pathname === "/login/oauth/access_token") {
			if (state.tokenStatus) return new Response("{}", { status: state.tokenStatus });
			const form = new URLSearchParams(decoder.decode(call.body));
			if (form.get("client_id") !== CLIENT.clientId || form.get("client_secret") !== CLIENT.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });
			if (form.get("grant_type") === "authorization_code") return form.get("code") === "good-code" && form.get("redirect_uri") === REDIRECT ? issue("x") : Response.json({ error: "invalid_grant" }, { status: 400 });
			if (form.get("grant_type") === "refresh_token") return form.get("refresh_token") === state.refresh ? issue("x") : Response.json({ error: "invalid_grant" }, { status: 400 });
		}
		if (url.pathname === "/api/v1/user") return Response.json({ login: "anibal" });
		if (url.pathname === "/api/v1/repos/acme/widgets") return Response.json({ default_branch: state.defaultBranch });
		const compare = /^\/api\/v1\/repos\/acme\/widgets\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(url.pathname);
		if (compare) return Response.json({ total_commits: (state.ancestors[compare[1]!] ?? []).includes(compare[2]!) ? 0 : 2 });
		if (call.method === "GET" && url.pathname === "/acme/widgets.git/info/refs" && url.searchParams.get("service") === "git-receive-pack") {
			const caps = "report-status delete-refs ofs-delta quiet agent=gitea/test";
			const refs = Object.entries(state.branches).map(([name, sha], index) => pktLine(`${sha} refs/heads/${name}${index === 0 ? `\0${caps}` : ""}\n`));
			return new Response(joined(pktLine("# service=git-receive-pack\n"), encoder.encode("0000"), ...refs, encoder.encode("0000")), {
				headers: { "content-type": "application/x-git-receive-pack-advertisement" },
			});
		}
		if (call.method === "POST" && url.pathname === "/acme/widgets.git/git-receive-pack") {
			const commands: string[] = [];
			let at = 0;
			for (;;) {
				const length = Number.parseInt(decoder.decode(call.body.subarray(at, at + 4)), 16);
				if (length === 0) break;
				commands.push(decoder.decode(call.body.subarray(at + 4, at + length)).replace(/\0.*$/s, "").replace(/\n$/, ""));
				at += length;
			}
			const packBytes = call.body.length - at - 4;
			const report = ["unpack ok"];
			for (const command of commands) {
				const [old, next, ref] = command.split(" ") as [string, string, string];
				state.updates.push({ command, packBytes });
				const name = ref.replace("refs/heads/", "");
				if (state.movesBeforeUpdate?.ref === ref && old !== ZERO && next !== ZERO) {
					state.branches[name] = state.movesBeforeUpdate.to;
					state.movesBeforeUpdate = null;
				}
				const current = state.branches[name] ?? ZERO;
				if (current !== old) report.push(`ng ${ref} failed to update ref`);
				else {
					if (next === ZERO) delete state.branches[name];
					else state.branches[name] = next;
					report.push(`ok ${ref}`);
				}
			}
			return new Response(joined(...report.map((line) => pktLine(`${line}\n`)), encoder.encode("0000")), { headers: { "content-type": "application/x-git-receive-pack-result" } });
		}
		if (url.pathname === "/api/v1/repos/acme/widgets/pulls") {
			if (call.method === "GET") return Response.json(state.pulls);
			const { head, base } = JSON.parse(decoder.decode(call.body)) as { head: string; base: string };
			if (state.pullStatus) return Response.json({ message: "pull request already exists" }, { status: state.pullStatus });
			const made = { number: state.pulls.length + 1, html_url: `${BASE}/acme/widgets/pulls/${state.pulls.length + 1}`, head: { ref: head }, base: { ref: base } };
			state.pulls.push(made);
			return Response.json(made, { status: 201 });
		}
		throw new Error(`unexpected request ${call.method} ${call.url}`);
	};
	return { calls, state, fetch };
}

function joined(...parts: Uint8Array[]) {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

/** A bundle as `git bundle create` makes it, naming `refs`, with a pack of 32 bytes. */
function bundle(refs: Record<string, string>): Uint8Array {
	const head = encoder.encode(`# v2 git bundle\n${Object.entries(refs).map(([ref, sha]) => `${sha} ${ref}`).join("\n")}\n\n`);
	const pack = new Uint8Array(32);
	pack.set(encoder.encode("PACK"), 0);
	pack.set([0, 0, 0, 2], 4);
	return joined(head, pack);
}

const backend = directoryGiteaBackend(env);
const key = async () => giteaKeyFrom(await env.Directory.getByName("directory").cookieKey());

function connectionTo(gitea: ReturnType<typeof fakeGitea>, overrides: Partial<ConstructorParameters<typeof GiteaConnection>[0]> = {}) {
	return new GiteaConnection({ instanceId: ID, config: CLIENT, backend, key, fetch: gitea.fetch, now: () => gitea.state.now, sleep: async () => {}, ...overrides });
}

/** A connection that has signed in once, at the fake's clock. */
async function connected(gitea: ReturnType<typeof fakeGitea>) {
	const connection = connectionTo(gitea);
	await connection.complete("ada", await begin(connection, "ada"), "good-code", REDIRECT);
	return connection;
}

/** Starts a sign-in for `owner` and returns its state, as Gitea sends it back. */
async function begin(connection: GiteaConnection, owner: string) {
	return new URL(await connection.authorizeUrl(owner, REDIRECT)).searchParams.get("state")!;
}

beforeEach(async () => {
	await backend.disconnect(ID);
});

describe("Gitea settings", () => {
	it("is not configured until both the client ID and secret are set, and the base URL are set", () => {
		expect(giteaConfig({})).toBeNull();
		expect(giteaConfig({ PIM_GITEA_CLIENT_ID: "id" })).toBeNull();
		expect(giteaConfig({ PIM_GITEA_CLIENT_ID: "id", PIM_GITEA_CLIENT_SECRET: "s" })).toBeNull();
		expect(giteaConfig({ PIM_GITEA_CLIENT_ID: "id", PIM_GITEA_CLIENT_SECRET: "s", PIM_GITEA_BASE_URL: "https://git.example.test" })).toEqual({ baseUrl: "https://git.example.test", clientId: "id", clientSecret: "s" });
		expect(giteaBaseUrl({})).toBeNull();
		expect(giteaBaseUrl({ PIM_GITEA_BASE_URL: "https://git.example.test/path" })).toBe("https://git.example.test");
		expect(giteaBaseUrl({ PIM_GITEA_BASE_URL: "http://git.example.test" })).toBeNull();
	});

	it("reports not configured as a state, never a crash", async () => {
		const gitea = fakeGitea();
		const connection = connectionTo(gitea, { config: null });
		expect(await connection.status()).toEqual({ configured: false, connected: false, login: null, needsReconnect: false });
		const error = await new GiteaProvider(giteaInstance(ID, BASE), connection).credential(WIDGETS, "read").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GiteaNotConnectedError);
		expect((error as GiteaNotConnectedError).state).toBe("not_configured");
		await expect(connection.authorizeUrl("ada", REDIRECT)).rejects.toThrow("Gitea not configured");
		expect(gitea.calls).toHaveLength(0);
	});
});

describe("Gitea repository URLs", () => {
	const provider = new GiteaProvider(giteaInstance(ID, BASE), connectionTo(fakeGitea()));

	it("are read as <base>/<owner>/<name>, with .git and a trailing slash optional", () => {
		for (const input of [`${BASE}/acme/widgets`, `${BASE}/acme/widgets.git`, `${BASE}/acme/widgets/`]) expect(provider.parseRepoUrl(input)).toEqual(WIDGETS);
		expect(provider.repoUrl(WIDGETS)).toBe(`${BASE}/acme/widgets`);
		expect(provider.gitUrl(WIDGETS)).toBe(`${BASE}/acme/widgets.git`);
		expect(provider.parseRepoUrl(`${BASE}/my_org/a.b-c`).fullName).toBe("my_org/a.b-c");
	});

	it.each([
		"https://github.com/acme/widgets",
		"http://gitea.example.test/acme/widgets",
		"https://gitea.example.test:8443/acme/widgets",
		"https://user:pw@gitea.example.test/acme/widgets",
		"https://gitea.example.test/acme/widgets?x=1",
		"https://gitea.example.test/acme/widgets#frag",
		"https://gitea.example.test/acme",
		"https://gitea.example.test/acme/widgets/issues",
		"https://gitea.example.test/acme/%2e%2e",
		"https://gitea.example.test/acme/..",
		"https://gitea.example.test.evil.test/acme/widgets",
	])("refuse %s", (input) => {
		expect(() => provider.parseRepoUrl(input)).toThrow("A repository must be https://gitea.example.test/<owner>/<name>");
	});

	it("hold to the policy's repositories", () => {
		expect(() => provider.parseRepoUrl(`${BASE}/acme/widgets`, { repos: ["me/notes"] })).toThrow("doesn't let coding threads use acme/widgets");
		expect(provider.parseRepoUrl(`${BASE}/acme/widgets`, { repos: ["acme/*"] })).toEqual(WIDGETS);
	});

	it("are resolved by the registry for the instance's host, beside GitHub's", () => {
		const registry = new ProviderRegistry([new GitHubProvider(null), provider]);
		expect(registry.resolveUrl(`${BASE}/acme/widgets.git`).provider).toBe(provider);
		expect(registry.resolveUrl("https://github.com/acme/widgets").provider.instance.id).toBe("github");
	});
});

describe("signing in to Gitea", () => {
	it("sends the person to Gitea's authorize page with a state of this Pim's own", async () => {
		const url = new URL(await connectionTo(fakeGitea()).authorizeUrl("ada", REDIRECT));
		expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/login/oauth/authorize`);
		expect(Object.fromEntries([...url.searchParams].filter(([name]) => name !== "state"))).toEqual({ response_type: "code", client_id: CLIENT.clientId, redirect_uri: REDIRECT });
		expect(url.searchParams.get("state")).toMatch(/^[\w-]{40,}$/);
		expect(url.toString()).not.toContain(CLIENT.clientSecret);
	});

	it("trades the code for tokens, stores them sealed, and learns who signed in", async () => {
		const gitea = fakeGitea();
		const connection = connectionTo(gitea);
		const login = await connection.complete("ada", await begin(connection, "ada"), "good-code", REDIRECT);
		expect(login).toBe("anibal");
		const exchange = gitea.calls.find((call) => call.url.endsWith("/login/oauth/access_token"))!;
		expect(Object.fromEntries(new URLSearchParams(decoder.decode(exchange.body)))).toEqual({
			grant_type: "authorization_code",
			code: "good-code",
			redirect_uri: REDIRECT,
			client_id: CLIENT.clientId,
			client_secret: CLIENT.clientSecret,
		});
		expect(gitea.calls.find((call) => call.url.endsWith("/api/v1/user"))!.headers.get("authorization")).toBe("Bearer access-1");
		const stored = await backend.read(ID);
		const raw = String.fromCharCode(...stored.sealed!);
		expect(raw).not.toContain("access-1");
		expect(raw).not.toContain("refresh-1");
		expect(stored.login).toBe("anibal");
	});

	it("refuses a wrong, unknown, expired, replayed or someone else's state, before asking Gitea for anything", async () => {
		const gitea = fakeGitea();
		const connection = connectionTo(gitea);
		await expect(connection.complete("ada", "made-up", "good-code", REDIRECT)).rejects.toThrow("expired or isn't yours");
		await expect(connection.complete("ada", "", "good-code", REDIRECT)).rejects.toThrow("expired or isn't yours");

		const state = await begin(connection, "ada");
		await expect(connection.complete("grace", state, "good-code", REDIRECT)).rejects.toThrow("expired or isn't yours");
		// Another person's attempt uses the state up, so it can't then be used by its owner either.
		await expect(connection.complete("ada", state, "good-code", REDIRECT)).rejects.toThrow("expired or isn't yours");

		const short = connectionTo(gitea, { backend: { ...backend, createState: (hash, owner) => backend.createState(hash, owner, 1) } });
		const lapsing = await begin(short, "ada");
		await new Promise((resolve) => setTimeout(resolve, 20));
		await expect(connection.complete("ada", lapsing, "good-code", REDIRECT)).rejects.toThrow("expired or isn't yours");

		const used = await begin(connection, "ada");
		await connection.complete("ada", used, "good-code", REDIRECT);
		await expect(connection.complete("ada", used, "good-code", REDIRECT)).rejects.toThrow("expired or isn't yours");
		// Only the one good sign-in reached Gitea.
		expect(gitea.calls.filter((call) => call.url.endsWith("/login/oauth/access_token"))).toHaveLength(1);
	});

	it("fails clearly when Gitea refuses the code, leaving the connection as it was", async () => {
		const gitea = fakeGitea();
		const connection = connectionTo(gitea);
		await expect(connection.complete("ada", await begin(connection, "ada"), "bad-code", REDIRECT)).rejects.toThrow("Gitea answered HTTP 400");
		expect((await connection.status()).connected).toBe(false);
	});
});

describe("the connection", () => {
	it("says what it is without any secret", async () => {
		const gitea = fakeGitea();
		const connection = await connected(gitea);
		const status = await connection.status();
		expect(status).toEqual({ configured: true, connected: true, login: "anibal", needsReconnect: false });
		const shown = JSON.stringify(status);
		for (const secret of ["access-1", "refresh-1", CLIENT.clientSecret]) expect(shown).not.toContain(secret);
		await connection.disconnect();
		expect(await connection.status()).toEqual({ configured: true, connected: false, login: null, needsReconnect: false });
	});

	it("fails with 'Gitea not connected' while nobody has signed in, and GitHub is unaffected", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), connectionTo(gitea), { fetch: gitea.fetch });
		const error = await provider.credential(WIDGETS, "write").catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GiteaNotConnectedError);
		expect((error as Error).message).toMatch(/^Gitea not connected/);
		await expect(provider.defaultBranch(WIDGETS)).rejects.toThrow("Gitea not connected");
		expect(await new GitHubProvider(null).credential(WIDGETS, "read")).toBeNull();
	});

	it("gives the OAuth access token as the git password, without refreshing it while it has time", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea), { fetch: gitea.fetch });
		const before = gitea.calls.length;
		gitea.state.now += HOUR - REFRESH_MARGIN_MS - 1000;
		expect(await provider.credential(WIDGETS, "read")).toEqual({ username: "oauth2", token: "access-1" });
		expect(await provider.credential(WIDGETS, "write")).toEqual({ username: "oauth2", token: "access-1" });
		expect(gitea.calls).toHaveLength(before);
	});

	it("refreshes within five minutes of expiry, and keeps the rotated pair so the next refresh works", async () => {
		const gitea = fakeGitea();
		const connection = await connected(gitea);
		gitea.state.now += HOUR - REFRESH_MARGIN_MS + 1000;
		expect(await connection.accessToken()).toBe("access-2");
		const refresh = gitea.calls.filter((call) => decoder.decode(call.body).includes("grant_type=refresh_token"));
		expect(refresh).toHaveLength(1);
		expect(new URLSearchParams(decoder.decode(refresh[0]!.body)).get("refresh_token")).toBe("refresh-1");
		expect(await connection.accessToken()).toBe("access-2");
		// The next refresh spends refresh-2, which Gitea honors only because the rotated pair was stored.
		gitea.state.now += HOUR;
		expect(await connection.accessToken()).toBe("access-3");
		expect((await connection.status()).login).toBe("anibal");
	});

	it("refreshes once for concurrent callers, which all get the new token", async () => {
		const gitea = fakeGitea();
		const connection = await connected(gitea);
		gitea.state.now += HOUR;
		const tokens = await Promise.all(Array.from({ length: 6 }, () => connection.accessToken()));
		expect(tokens).toEqual(Array(6).fill("access-2"));
		expect(gitea.calls.filter((call) => decoder.decode(call.body).includes("grant_type=refresh_token"))).toHaveLength(1);
	});

	it("waits for another isolate's refresh instead of spending the refresh token again", async () => {
		const gitea = fakeGitea();
		const connection = await connected(gitea);
		gitea.state.now += HOUR;
		const stale = await backend.read(ID);
		expect(await backend.claimRefresh(ID, stale.version, 30_000)).toBe(true);
		let slept = 0;
		// While this caller waits, the other isolate stores the rotated pair, which is what a refresh does.
		const waiting = connectionTo(gitea, {
			sleep: async () => {
				slept += 1;
				const fresh = connectionTo(gitea, { instanceId: ID, backend: { ...backend, claimRefresh: async () => true } });
				await fresh.accessToken();
			},
		});
		expect(await waiting.accessToken()).toBe("access-2");
		expect(slept).toBe(1);
		expect(gitea.calls.filter((call) => decoder.decode(call.body).includes("grant_type=refresh_token"))).toHaveLength(1);
	});

	it("marks the connection needs_reconnect when Gitea refuses the refresh, and says so", async () => {
		const gitea = fakeGitea();
		const connection = await connected(gitea);
		gitea.state.now += HOUR;
		// Gitea no longer honors the refresh token.
		gitea.state.refresh = "revoked";
		const error = await connection.accessToken().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GiteaNotConnectedError);
		expect((error as GiteaNotConnectedError).state).toBe("needs_reconnect");
		expect(await connection.status()).toEqual({ configured: true, connected: false, login: "anibal", needsReconnect: true });
		const again = gitea.calls.length;
		await expect(connection.accessToken()).rejects.toThrow("needs to be signed in again");
		expect(gitea.calls).toHaveLength(again);
		// Signing in again heals it.
		await connection.complete("ada", await begin(connection, "ada"), "good-code", REDIRECT);
		expect(await connection.status()).toMatchObject({ connected: true, needsReconnect: false });
	});

	it("keeps the connection when Gitea is merely down, and refreshes once it is back", async () => {
		const gitea = fakeGitea();
		const connection = await connected(gitea);
		gitea.state.now += HOUR;
		gitea.state.tokenStatus = 503;
		await expect(connection.accessToken()).rejects.toThrow("HTTP 503");
		expect(await connection.status()).toMatchObject({ connected: true, needsReconnect: false });
		gitea.state.tokenStatus = null;
		expect(await connection.accessToken()).toBe("access-2");
	});

	it("treats tokens sealed for another instance as none", async () => {
		const gitea = fakeGitea();
		await connected(gitea);
		const stored = await backend.read(ID);
		await backend.write("other-instance", stored.sealed!, "anibal", 0);
		const other = connectionTo(gitea, { instanceId: "other-instance" });
		await expect(other.accessToken()).rejects.toThrow("needs to be signed in again");
	});
});

describe("Gitea's API", () => {
	it("names the default branch, with the account's token", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea), { fetch: gitea.fetch });
		expect(await provider.defaultBranch(WIDGETS)).toBe("trunk");
		const call = gitea.calls.at(-1)!;
		expect(call.url).toBe(`${BASE}/api/v1/repos/acme/widgets`);
		expect(call.headers.get("authorization")).toBe("Bearer access-1");
	});
});

describe("the clone and fetch proxy for Gitea", () => {
	async function broker(gitea: ReturnType<typeof fakeGitea>, provider: GiteaProvider, overrides: Partial<GitBrokerDeps> = {}) {
		const brokerSecret = await brokerKey("directory-secret");
		const providers = new ProviderRegistry([new GitHubProvider(null), provider]);
		const deps: GitBrokerDeps = { key: brokerSecret, app: null, policy: POLICY, providers, fetch: gitea.fetch, now: () => gitea.state.now, ...overrides };
		const token = (instance: string) => issueBrokerToken(brokerSecret, { sessionId: "T-1", repo: WIDGETS, instance, now: gitea.state.now });
		const ask = async (path: string, instance: string) => {
			const request = new Request(`https://pim.test/api${path}`, { headers: { Authorization: `Basic ${btoa(`x:${await token(instance)}`)}` } });
			return handleGitBroker(request, new URL(request.url).pathname.slice("/api".length), deps);
		};
		return { ask };
	}
	const PATH = "/coding/git/gitea/acme/widgets.git/info/refs?service=git-upload-pack";

	it("fetches with the account's token, which the workspace never sees", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea));
		const { ask } = await broker(gitea, provider, {
			fetch: async (input, init) => {
				const request = new Request(input, init);
				if (request.url !== `${BASE}/acme/widgets.git/info/refs?service=git-upload-pack`) return gitea.fetch(input, init);
				expect(request.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:access-1")}`);
				return new Response("refs", { headers: { "content-type": "application/x-git-upload-pack-advertisement; charset=utf-8" } });
			},
		});
		const response = await ask(PATH, "gitea");
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("refs");
	});

	it("says Gitea isn't connected rather than cloning anonymously", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), connectionTo(gitea));
		const { ask } = await broker(gitea, provider);
		const response = await ask(PATH, "gitea");
		expect(response.status).toBe(409);
		expect(await response.text()).toContain("Gitea not connected");
		expect(gitea.calls).toHaveLength(0);
	});

	it("keeps a GitHub token to GitHub's paths, and a Gitea token to Gitea's", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea));
		const { ask } = await broker(gitea, provider);
		expect((await ask(PATH, "github")).status).toBe(403);
		expect((await ask("/coding/git/acme/widgets.git/info/refs?service=git-upload-pack", "gitea")).status).toBe(403);
	});
});

describe("pushing to Gitea", () => {
	async function pushing(setup: (gitea: ReturnType<typeof fakeGitea>) => void = () => {}) {
		const gitea = fakeGitea();
		setup(gitea);
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea), { fetch: gitea.fetch });
		const providers = new ProviderRegistry([new GitHubProvider(null), provider]);
		const deps = { app: null, policy: POLICY, providers, fetch: gitea.fetch };
		const request = (branch = "pim/fix", head = SHA("b"), extra: object = {}) => ({ sessionId: "T-1", repo: `${BASE}/acme/widgets`, branch, bundle: bundle({ [`refs/heads/${branch}`]: head }), ...extra });
		return { gitea, deps, request };
	}

	it("creates a new branch with one receive-pack, signed in as the account", async () => {
		const { gitea, deps, request } = await pushing();
		const result = await pushBranch(deps, request());
		expect(result).toEqual({ repo: "acme/widgets", branch: "pim/fix", before: null, after: SHA("b"), outcome: "created" });
		expect(gitea.state.branches["pim/fix"]).toBe(SHA("b"));
		expect(gitea.state.updates).toEqual([{ command: `${ZERO} ${SHA("b")} refs/heads/pim/fix`, packBytes: 32 }]);
		const push = gitea.calls.find((call) => call.url.endsWith("/git-receive-pack"))!;
		expect(push.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:access-1")}`);
	});

	it("needs no GitHub App, and asks the person about a push in Gitea's terms", async () => {
		const { deps, request } = await pushing();
		const prepared = preparePush(deps, request());
		expect(pushApprovalRequest(prepared).summary).toBe(`Push pim/fix (${SHA("b").slice(0, 12)}, 1 KB) to gitea.example.test/acme/widgets`);
	});

	it("moves an existing branch only forward: stage, compare, update from the commit seen, delete the stage", async () => {
		const { gitea, deps, request } = await pushing((g) => {
			g.state.branches["pim/fix"] = SHA("a");
			g.state.ancestors[SHA("b")] = [SHA("a")];
		});
		const result = await pushBranch(deps, request("pim/fix", SHA("b")));
		expect(result).toMatchObject({ before: SHA("a"), after: SHA("b"), outcome: "updated" });
		expect(gitea.state.branches["pim/fix"]).toBe(SHA("b"));
		const [stage, move, drop] = gitea.state.updates;
		expect(stage!.command).toMatch(new RegExp(`^${ZERO} ${SHA("b")} refs/heads/pim-staging/[0-9a-f-]{36}$`));
		expect(stage!.packBytes).toBe(32);
		expect(move).toEqual({ command: `${SHA("a")} ${SHA("b")} refs/heads/pim/fix`, packBytes: 32 });
		expect(drop!.command).toMatch(new RegExp(`^${SHA("b")} ${ZERO} refs/heads/pim-staging/`));
		expect(Object.keys(gitea.state.branches).sort()).toEqual(["pim/fix", "trunk"]);
	});

	it("refuses to rewrite a branch: a commit that doesn't descend from it moves nothing and leaves no staging branch", async () => {
		const { gitea, deps, request } = await pushing((g) => {
			g.state.branches["pim/fix"] = SHA("a");
		});
		await expect(pushBranch(deps, request("pim/fix", SHA("b")))).rejects.toBeInstanceOf(BranchMovedError);
		expect(gitea.state.branches["pim/fix"]).toBe(SHA("a"));
		expect(Object.keys(gitea.state.branches).sort()).toEqual(["pim/fix", "trunk"]);
	});

	it("reports a branch that moved while the push was made as moved, with the branch left alone", async () => {
		const { gitea, deps, request } = await pushing((g) => {
			g.state.branches["pim/fix"] = SHA("a");
			g.state.ancestors[SHA("b")] = [SHA("a")];
			g.state.movesBeforeUpdate = { ref: "refs/heads/pim/fix", to: SHA("c") };
		});
		await expect(pushBranch(deps, request("pim/fix", SHA("b")))).rejects.toBeInstanceOf(BranchMovedError);
		expect(gitea.state.branches["pim/fix"]).toBe(SHA("c"));
		expect(Object.keys(gitea.state.branches).sort()).toEqual(["pim/fix", "trunk"]);
	});

	it("leaves an up-to-date branch alone", async () => {
		const { gitea, deps, request } = await pushing((g) => {
			g.state.branches["pim/fix"] = SHA("b");
		});
		expect((await pushBranch(deps, request("pim/fix", SHA("b")))).outcome).toBe("unchanged");
		expect(gitea.state.updates).toEqual([]);
	});

	it("keeps Pim's branch rules whatever the provider: the prefix, main and master, and the default branch", async () => {
		const { gitea, deps, request } = await pushing((g) => {
			g.state.defaultBranch = "develop";
		});
		await expect(pushBranch(deps, request("feature"))).rejects.toThrow("start with pim/");
		await expect(pushBranch({ ...deps, policy: { branchPrefix: null, repos: null } }, request("main"))).rejects.toThrow("never pushes to main");
		await expect(pushBranch({ ...deps, policy: { branchPrefix: null, repos: null } }, request("develop"))).rejects.toThrow("never pushes to develop");
		expect(gitea.state.updates).toEqual([]);
	});

	it("merges into the default branch only when asked to, and only forward", async () => {
		const { gitea, deps, request } = await pushing((g) => {
			g.state.ancestors[SHA("b")] = [SHA("1")];
		});
		await expect(pushBranch(deps, request("pim/fix", SHA("b"), { toDefault: true }))).rejects.toThrow("isn't acme/widgets's default branch, trunk");
		const result = await pushBranch(deps, request("trunk", SHA("b"), { toDefault: true }));
		expect(result).toMatchObject({ branch: "trunk", before: SHA("1"), after: SHA("b"), outcome: "updated" });
		expect(gitea.state.branches.trunk).toBe(SHA("b"));
	});

	it("fails with 'Gitea not connected' and sends nothing while Gitea isn't connected", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), connectionTo(gitea), { fetch: gitea.fetch });
		const deps = { app: null, policy: POLICY, providers: new ProviderRegistry([new GitHubProvider(null), provider]), fetch: gitea.fetch };
		const error = await pushBranch(deps, { sessionId: "T-1", repo: `${BASE}/acme/widgets`, branch: "pim/fix", bundle: bundle({ "refs/heads/pim/fix": SHA("b") }) }).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GiteaNotConnectedError);
		expect(gitea.calls).toHaveLength(0);
	});

	it("leaves GitHub's push exactly as it was, with the providers present", async () => {
		const gitea = fakeGitea();
		const providers = new ProviderRegistry([new GitHubProvider(null), new GiteaProvider(giteaInstance(ID, BASE), connectionTo(gitea))]);
		const refused = await pushBranch({ app: null, policy: POLICY, providers }, { sessionId: "T-1", repo: "https://github.com/acme/widgets", branch: "pim/fix", bundle: bundle({ "refs/heads/pim/fix": SHA("b") }) }).catch((caught: unknown) => caught);
		expect((refused as Error).message).toBe("GitHub App not configured");
		expect(gitea.calls).toHaveLength(0);
		const prepared = preparePush({ app: {} as never, policy: POLICY, providers }, { sessionId: "T-1", repo: "https://github.com/acme/widgets", branch: "pim/fix", bundle: bundle({ "refs/heads/pim/fix": SHA("b") }) });
		expect(prepared.instance.id).toBe("github");
		expect(pushApprovalRequest(prepared).summary).toMatch(/ to github\.com\/acme\/widgets$/);
	});
});

describe("opening pull requests", () => {
	const input = { repo: WIDGETS, head: "pim/fix", base: "trunk", title: "Fix it", body: "Body" };

	it("creates one on Gitea with the account's token, from head into base", async () => {
		const gitea = fakeGitea();
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea), { fetch: gitea.fetch });
		expect(await provider.createPullRequest(input)).toEqual({ url: `${BASE}/acme/widgets/pulls/1`, number: 1 });
		const call = gitea.calls.find((candidate) => candidate.method === "POST" && candidate.url.endsWith("/pulls"))!;
		expect(call.url).toBe(`${BASE}/api/v1/repos/acme/widgets/pulls`);
		expect(call.headers.get("authorization")).toBe("Bearer access-1");
		expect(JSON.parse(decoder.decode(call.body))).toEqual({ head: "pim/fix", base: "trunk", title: "Fix it", body: "Body" });
	});

	it("answers with the open pull request when Gitea says one exists (409 or 422), and not with one of another branch", async () => {
		for (const status of [409, 422]) {
			const gitea = fakeGitea();
			gitea.state.pullStatus = status;
			gitea.state.pulls.push(
				{ number: 4, html_url: `${BASE}/acme/widgets/pulls/4`, head: { ref: "pim/other" }, base: { ref: "trunk" } },
				{ number: 7, html_url: `${BASE}/acme/widgets/pulls/7`, head: { ref: "pim/fix" }, base: { ref: "trunk" } },
			);
			const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea), { fetch: gitea.fetch });
			expect(await provider.createPullRequest(input)).toEqual({ url: `${BASE}/acme/widgets/pulls/7`, number: 7 });
			expect(gitea.calls.some((call) => call.method === "GET" && call.url.includes("/pulls?state=open"))).toBe(true);
		}
	});

	it("fails when Gitea refuses and there is no open pull request from the branch", async () => {
		const gitea = fakeGitea();
		gitea.state.pullStatus = 422;
		const provider = new GiteaProvider(giteaInstance(ID, BASE), await connected(gitea), { fetch: gitea.fetch });
		await expect(provider.createPullRequest(input)).rejects.toThrow("Gitea answered HTTP 422 when opening a pull request on acme/widgets");
	});

	it("fails with 'Gitea not connected' and sends nothing while it isn't connected", async () => {
		const unconnected = fakeGitea();
		const error = await new GiteaProvider(giteaInstance(ID, BASE), connectionTo(unconnected), { fetch: unconnected.fetch }).createPullRequest(input).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GiteaNotConnectedError);
		expect(unconnected.calls).toHaveLength(0);
	});

	it("creates one on GitHub as before, and finds the open one when GitHub answers 422", async () => {
		const requests: { method: string; url: string; body: unknown }[] = [];
		let created = true;
		const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
			requests.push({ method: init?.method ?? "GET", url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
			if (init?.method === "POST") return created ? Response.json({ html_url: "https://github.com/acme/widgets/pull/3", number: 3 }, { status: 201 }) : new Response("{}", { status: 422 });
			return Response.json([{ html_url: "https://github.com/acme/widgets/pull/2", number: 2 }]);
		};
		const app = { installationToken: async () => ({ token: "ghs_x", expiresAt: Date.now() + HOUR }) } as never;
		const provider = new GitHubProvider(app, { fetch });
		expect(await provider.createPullRequest(input)).toEqual({ url: "https://github.com/acme/widgets/pull/3", number: 3 });
		expect(requests).toEqual([{ method: "POST", url: "https://api.github.com/repos/acme/widgets/pulls", body: { head: "pim/fix", base: "trunk", title: "Fix it", body: "Body" } }]);
		created = false;
		expect(await provider.createPullRequest(input)).toEqual({ url: "https://github.com/acme/widgets/pull/2", number: 2 });
		expect(requests.at(-1)!.url).toBe("https://api.github.com/repos/acme/widgets/pulls?state=open&head=acme%3Apim%2Ffix&base=trunk");
	});
});

describe("the deployment's providers", () => {
	it("register Gitea only once its base URL is set, unconnected until the secrets are", async () => {
		expect(deploymentProviders(env).instances().map((instance) => instance.id)).toEqual(["github"]);
		const registry = deploymentProviders({ ...env, PIM_GITEA_BASE_URL: BASE } as typeof env);
		expect(registry.instances().map((instance) => instance.id)).toEqual(["github", "gitea"]);
		expect(registry.resolveUrl(`${BASE}/acme/widgets`).provider.instance).toMatchObject({ kind: "gitea", baseUrl: BASE });
		await expect(registry.get(ID).credential(WIDGETS, "read")).rejects.toThrow("Gitea not configured");
	});

	it("serve the status over the API, never with secrets", async () => {
		const { status, body } = await api("/coding/gitea/status");
		expect(status).toBe(200);
		expect(body).toEqual({ configured: false, connected: false, login: null, needsReconnect: false });
		const started = await api("/coding/gitea/authorize");
		expect(started.status).toBe(409);
		expect(started.body.error).toContain("Gitea not configured");
	});
});
