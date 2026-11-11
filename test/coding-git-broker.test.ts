import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { base64UrlDecode } from "../src/auth/encoding";
import {
	BranchMovedError,
	brokerKey,
	checkBranch,
	GitBrokerError,
	issueBrokerToken,
	parseBundle,
	parseRepoUrl,
	pktLine,
	preparePush,
	pushApprovalRequest,
	pushBranch,
	type RepoRef,
	repoRef,
	verifyBrokerToken,
} from "../src/coding/git-broker/broker";
import { brokerPolicy, GitBrokerNotConfiguredError, type GitHubAppConfig, githubAppConfig, githubAppStatus } from "../src/coding/git-broker/config";
import { appJwt, GitHubApp, importPrivateKey, RepoNotInstalledError, TOKEN_MARGIN_MS } from "../src/coding/git-broker/github-app";
import { GitHubProvider } from "../src/coding/git-broker/github-provider";
import { GITHUB_INSTANCE, type GitProvider, ProviderRegistry, SEEDED_INSTANCES } from "../src/coding/git-broker/provider";
import { brokerTokenKey, type GitBrokerDeps, handleGitBroker } from "../src/coding/git-broker/routes";

// Every request to GitHub goes to a fake one; nothing here reaches the network.

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const APP_TOKEN = "ghs_installationTokenThatMustNeverLeakX1";
const SHA = (digit: string) => digit.repeat(40);
const ZERO = SHA("0");
const POLICY = { branchPrefix: "pim/", repos: null };
const WIDGETS: RepoRef = { owner: "acme", name: "widgets", fullName: "acme/widgets" };
const encoder = new TextEncoder();

let pkcs8Pem = "";
let pkcs1Pem = "";
let publicKey: CryptoKey;
/** The base64 body of the private key, which must never be seen outside Pim. */
let keyBody = "";

const pem = (label: string, der: Uint8Array) => {
	const base64 = btoa(String.fromCharCode(...der));
	return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
};

/** The PKCS #1 key inside a PKCS #8 one, as GitHub hands App keys out. */
function pkcs1Of(pkcs8: Uint8Array): Uint8Array {
	let at = 0;
	const header = () => {
		const tag = pkcs8[at++]!;
		let length = pkcs8[at++]!;
		if (length & 0x80) {
			const count = length & 0x7f;
			length = 0;
			for (let i = 0; i < count; i++) length = length * 256 + pkcs8[at++]!;
		}
		return { tag, length };
	};
	header(); // The outer SEQUENCE.
	for (const _skipped of ["version", "algorithm"]) {
		const { length } = header();
		at += length;
	}
	const key = header();
	expect(key.tag).toBe(0x04);
	return pkcs8.subarray(at, at + key.length);
}

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	pkcs8Pem = pem("PRIVATE KEY", pkcs8);
	pkcs1Pem = pem("RSA PRIVATE KEY", pkcs1Of(pkcs8));
	keyBody = pkcs1Pem.split("\n")[1]!;
	publicKey = pair.publicKey;
});

afterEach(() => {
	vi.restoreAllMocks();
});

type Call = { method: string; url: string; headers: Headers; body: Uint8Array };

/** A fake GitHub, answering `METHOD url` with its handler; anything else fails the test. */
function fakeGitHub(routes: Record<string, (call: Call) => Response | Promise<Response>>) {
	const calls: Call[] = [];
	const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const call = { method: request.method, url: request.url, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) };
		calls.push(call);
		const handler = routes[`${call.method} ${call.url}`];
		if (!handler) throw new Error(`unexpected request ${call.method} ${call.url}`);
		return handler(call);
	};
	return { fetch, calls };
}

const tokenAnswer = (expiresAt: number, token = APP_TOKEN) => () => Response.json({ token, expires_at: new Date(expiresAt).toISOString() }, { status: 201 });

function appWith(fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>, clock = { now: NOW }, config: Partial<GitHubAppConfig> = {}) {
	return new GitHubApp({ appId: "4242", privateKey: pkcs1Pem, installationId: null, webhookSecret: null, ...config }, { fetch, now: () => clock.now });
}

const bodyText = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());
const decodeJson = (segment: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));

describe("GitHub App settings", () => {
	it("is not configured until both the ID and the key are set, and says which is missing by name", () => {
		expect(githubAppStatus({})).toEqual({ configured: false, reason: "GitHub App not configured", problem: null });
		expect(githubAppStatus({ PIM_GITHUB_APP_ID: "4242" })).toEqual({ configured: false, reason: "GitHub App not configured", problem: "Set PIM_GITHUB_APP_PRIVATE_KEY too." });
		const badId = githubAppStatus({ PIM_GITHUB_APP_ID: "my-app", PIM_GITHUB_APP_PRIVATE_KEY: pkcs1Pem });
		expect(badId.configured).toBe(false);
		expect(JSON.stringify(badId)).not.toContain(keyBody);
		const badKey = githubAppStatus({ PIM_GITHUB_APP_ID: "4242", PIM_GITHUB_APP_PRIVATE_KEY: "hunter2-not-a-pem" });
		expect(badKey).toMatchObject({ configured: false, problem: "PIM_GITHUB_APP_PRIVATE_KEY must be one of the App's private keys, in PEM." });
		expect(JSON.stringify(badKey)).not.toContain("hunter2");
		expect(() => githubAppConfig({})).toThrow(GitBrokerNotConfiguredError);
		expect(() => githubAppConfig({})).toThrow("GitHub App not configured");
	});

	it("reports a configured App without any secret", () => {
		const status = githubAppStatus({
			PIM_GITHUB_APP_ID: " 4242 ",
			PIM_GITHUB_APP_PRIVATE_KEY: pkcs1Pem,
			PIM_GITHUB_APP_INSTALLATION_ID: "77",
			PIM_GITHUB_APP_WEBHOOK_SECRET: "whsec-very-secret",
		});
		expect(status).toEqual({ configured: true, appId: "4242", installationId: "77", webhookSecret: true });
		expect(JSON.stringify(status)).not.toMatch(/PRIVATE KEY|whsec-very-secret/);
		// A key pasted on one line, with `\n` for its line breaks, is read as the PEM it is.
		const oneLine = githubAppConfig({ PIM_GITHUB_APP_ID: "4242", PIM_GITHUB_APP_PRIVATE_KEY: pkcs1Pem.replace(/\n/g, "\\n") });
		expect(oneLine.privateKey).toBe(pkcs1Pem.trim());
	});

	it("reads the branch prefix and the repositories, never loosening them on a typo", () => {
		expect(brokerPolicy({})).toEqual({ branchPrefix: "pim/", repos: null });
		expect(brokerPolicy({ PIM_GIT_BRANCH_PREFIX: "none" }).branchPrefix).toBeNull();
		expect(brokerPolicy({ PIM_GIT_BRANCH_PREFIX: "bots/" }).branchPrefix).toBe("bots/");
		expect(brokerPolicy({ PIM_GIT_BRANCH_PREFIX: "../x" }).branchPrefix).toBe("pim/");
		expect(brokerPolicy({ PIM_GIT_BRANCH_PREFIX: "" }).branchPrefix).toBe("pim/");
		expect(brokerPolicy({ PIM_GIT_REPOS: "Acme/*, me/Notes" }).repos).toEqual(["acme/*", "me/notes"]);
		expect(brokerPolicy({ PIM_GIT_REPOS: "acme/*, https://evil" }).repos).toEqual([]);
	});
});

describe("the App's JWT", () => {
	for (const [label, key] of [
		["PKCS #1, as GitHub gives it", () => pkcs1Pem],
		["PKCS #8", () => pkcs8Pem],
	] as const) {
		it(`is RS256 with the App as issuer, from a ${label} key`, async () => {
			const jwt = await appJwt(await importPrivateKey(key()), "4242", NOW);
			const [header, claims, signature] = jwt.split(".") as [string, string, string];
			expect(decodeJson(header)).toEqual({ alg: "RS256", typ: "JWT" });
			const seconds = NOW / 1000;
			expect(decodeJson(claims)).toEqual({ iss: "4242", iat: seconds - 60, exp: seconds + 540 });
			// GitHub refuses a JWT that lasts longer than 10 minutes.
			expect(decodeJson(claims).exp - decodeJson(claims).iat).toBeLessThanOrEqual(600);
			expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, base64UrlDecode(signature), encoder.encode(`${header}.${claims}`))).toBe(true);
		});
	}

	it("refuses a key that isn't one, without quoting it", async () => {
		const notAKey = "-----BEGIN RSA PRIVATE KEY-----\nc2VjcmV0LWJ1dC1ub3QtYS1rZXk=\n-----END RSA PRIVATE KEY-----";
		const error = await importPrivateKey(notAKey).catch((caught: Error) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).not.toContain("c2VjcmV0");
	});
});

describe("installation tokens", () => {
	it("asks for one repository with contents read to clone and contents write to push, and nothing more", async () => {
		const github = fakeGitHub({
			"GET https://api.github.com/repos/acme/widgets/installation": () => Response.json({ id: 99 }),
			"POST https://api.github.com/app/installations/99/access_tokens": tokenAnswer(NOW + 60 * 60_000),
		});
		const app = appWith(github.fetch);
		expect((await app.installationToken(WIDGETS, "read")).token).toBe(APP_TOKEN);
		await app.installationToken(WIDGETS, "write");
		const minted = github.calls.filter((call) => call.method === "POST");
		expect(minted.map((call) => JSON.parse(new TextDecoder().decode(call.body)))).toEqual([
			{ repositories: ["widgets"], permissions: { contents: "read" } },
			{ repositories: ["widgets"], permissions: { contents: "write" } },
		]);
		for (const call of github.calls) {
			expect(call.headers.get("authorization")).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
			expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
		}
	});

	it("uses the configured installation without looking it up", async () => {
		const github = fakeGitHub({ "POST https://api.github.com/app/installations/77/access_tokens": tokenAnswer(NOW + 60 * 60_000) });
		await appWith(github.fetch, { now: NOW }, { installationId: "77" }).installationToken(WIDGETS, "read");
		expect(github.calls.map((call) => call.url)).toEqual(["https://api.github.com/app/installations/77/access_tokens"]);
	});

	it("keeps a token only until 5 minutes before it expires", async () => {
		const clock = { now: NOW };
		let minted = 0;
		const github = fakeGitHub({
			"POST https://api.github.com/app/installations/77/access_tokens": () => tokenAnswer(clock.now + 60 * 60_000, `ghs_${++minted}`)(),
		});
		const app = appWith(github.fetch, clock, { installationId: "77" });
		expect((await app.installationToken(WIDGETS, "read")).token).toBe("ghs_1");
		clock.now = NOW + 60 * 60_000 - TOKEN_MARGIN_MS - 1;
		expect((await app.installationToken(WIDGETS, "read")).token).toBe("ghs_1");
		clock.now = NOW + 60 * 60_000 - TOKEN_MARGIN_MS;
		expect((await app.installationToken(WIDGETS, "read")).token).toBe("ghs_2");
		// Another repository, or write access, is never served from read's token.
		expect((await app.installationToken({ owner: "acme", name: "gears", fullName: "acme/gears" }, "read")).token).toBe("ghs_3");
		expect((await app.installationToken(WIDGETS, "write")).token).toBe("ghs_4");
	});

	it("doesn't keep a token that is already within the margin of its expiry", async () => {
		const github = fakeGitHub({ "POST https://api.github.com/app/installations/77/access_tokens": tokenAnswer(NOW + TOKEN_MARGIN_MS - 1) });
		const app = appWith(github.fetch, { now: NOW }, { installationId: "77" });
		await app.installationToken(WIDGETS, "read");
		await app.installationToken(WIDGETS, "read");
		expect(github.calls).toHaveLength(2);
	});

	it("says when the App isn't installed on a repository", async () => {
		const github = fakeGitHub({ "GET https://api.github.com/repos/acme/widgets/installation": () => Response.json({ message: "Not Found" }, { status: 404 }) });
		await expect(appWith(github.fetch).installationToken(WIDGETS, "read")).rejects.toBeInstanceOf(RepoNotInstalledError);
	});
});

describe("broker tokens", () => {
	it("renews only a live, bounded grant for the same repository and thread", async () => {
		const key = await brokerKey("test-renewal-key");
		let now = NOW;
		const until = NOW + 2 * 60 * 60_000;
		for (const renewUntil of [NOW, NOW + 12 * 60 * 60_000 + 1, Number.NaN]) {
			await expect(issueBrokerToken(key, { sessionId: "T-renew", repo: WIDGETS, now, renewUntil })).rejects.toThrow("Invalid renewal deadline");
		}
		const logged = vi.spyOn(console, "log");
		const original = await issueBrokerToken(key, { sessionId: "T-renew", repo: WIDGETS, now, renewUntil: until });
		const deps: GitBrokerDeps = { key, app: null, policy: POLICY, now: () => now };
		const ask = (path: string, token: string) => handleGitBroker(new Request("https://pim.test/api" + path, {
			method: "POST", headers: { Authorization: "Bearer " + token },
		}), path, deps);
		now += 30 * 60_000;
		const path = "/coding/git/acme/widgets.git/credential";
		const response = await ask(path, original);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		const { token } = await response.json() as { token: string };
		expect(await verifyBrokerToken(key, token, now)).toEqual({
			sessionId: "T-renew", repo: "acme/widgets", instance: "github",
			expiresAt: now + 60 * 60_000, renewUntil: until,
		});
		expect((await ask("/coding/git/acme/other.git/credential", token)).status).toBe(403);
		expect((await ask("/coding/git/other/acme/widgets.git/credential", token)).status).toBe(403);
		expect((await ask("/coding/git/acme/widgets.git/git-receive-pack", token)).status).toBe(404);
		now = NOW + 60 * 60_000;
		expect((await ask(path, original)).status).toBe(401);
		now = until - 1;
		const nearDeadline = await issueBrokerToken(key, { sessionId: "T-renew", repo: WIDGETS, now, renewUntil: until });
		const last = await ask(path, nearDeadline);
		const renewed = (await last.json() as { token: string }).token;
		expect((await verifyBrokerToken(key, renewed, now))?.expiresAt).toBe(until);
		now = until;
		expect((await ask(path, renewed)).status).toBe(401);
		expect((await ask(path, nearDeadline)).status).toBe(401);
		const plain = await issueBrokerToken(key, { sessionId: "T-plain", repo: WIDGETS, now });
		expect((await ask(path, plain)).status).toBe(403);
		expect(JSON.stringify(logged.mock.calls)).not.toContain("pimgit_");
	});

	it("open one repository for one session until they expire", async () => {
		const key = await brokerKey("directory-secret");
		const token = await issueBrokerToken(key, { sessionId: "T-123", repo: { owner: "Acme", name: "Widgets", fullName: "Acme/Widgets" }, ttlMs: 60_000, now: NOW });
		expect(token).toMatch(/^pimgit_[\w-]+\.[\w-]+$/);
		expect(await verifyBrokerToken(key, token, NOW)).toEqual({ sessionId: "T-123", repo: "acme/widgets", expiresAt: NOW + 60_000, instance: "github" });
		expect(await verifyBrokerToken(key, token, NOW + 59_999)).not.toBeNull();
		expect(await verifyBrokerToken(key, token, NOW + 60_000)).toBeNull();
	});

	it("refuse any change, another key, or a lifetime past 12 hours", async () => {
		const key = await brokerKey("directory-secret");
		const token = await issueBrokerToken(key, { sessionId: "T-123", repo: WIDGETS, now: NOW });
		const [payload, mac] = token.slice("pimgit_".length).split(".") as [string, string];
		const claims = decodeJson(payload);
		const reissued = (changes: object) =>
			`pimgit_${btoa(JSON.stringify({ ...claims, ...changes })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.${mac}`;
		expect(await verifyBrokerToken(key, reissued({ repo: "acme/secrets" }), NOW)).toBeNull();
		expect(await verifyBrokerToken(key, reissued({ exp: NOW + 10 ** 12 }), NOW)).toBeNull();
		expect(await verifyBrokerToken(key, reissued({ sid: "T-other" }), NOW)).toBeNull();
		const flipped = mac.startsWith("A") ? `B${mac.slice(1)}` : `A${mac.slice(1)}`;
		expect(await verifyBrokerToken(key, `pimgit_${payload}.${flipped}`, NOW)).toBeNull();
		expect(await verifyBrokerToken(await brokerKey("another-secret"), token, NOW)).toBeNull();
		expect(await verifyBrokerToken(key, token.replace("pimgit_", "pimx_"), NOW)).toBeNull();
		expect(await verifyBrokerToken(key, `${token}.extra`, NOW)).toBeNull();
		expect(await verifyBrokerToken(key, "pimgit_%%%.%%%", NOW)).toBeNull();
		await expect(issueBrokerToken(key, { sessionId: "T-123", repo: WIDGETS, ttlMs: 12 * 60 * 60_000 + 1 })).rejects.toThrow(GitBrokerError);
		await expect(issueBrokerToken(key, { sessionId: "../../etc", repo: WIDGETS })).rejects.toThrow(GitBrokerError);
	});
});

describe("repository URLs", () => {
	it("accept github.com repositories over HTTPS", () => {
		expect(parseRepoUrl("https://github.com/acme/widgets")).toEqual(WIDGETS);
		expect(parseRepoUrl("https://github.com/acme/widgets.git")).toEqual(WIDGETS);
		expect(parseRepoUrl("https://github.com/acme/widgets/")).toEqual(WIDGETS);
		expect(parseRepoUrl("https://github.com/a-b/.github").fullName).toBe("a-b/.github");
	});

	it.each([
		"http://github.com/acme/widgets",
		"git@github.com:acme/widgets.git",
		"ssh://git@github.com/acme/widgets",
		"git://github.com/acme/widgets",
		"file:///etc/passwd",
		"https://localhost/acme/widgets",
		"https://127.0.0.1/acme/widgets",
		"https://2130706433/acme/widgets",
		"https://[::1]/acme/widgets",
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.1/acme/widgets",
		"https://github.com.evil.example/acme/widgets",
		"https://evil.example/github.com/acme/widgets",
		"https://api.github.com/acme/widgets",
		"https://gist.github.com/acme/widgets",
		"https://github.com./acme/widgets",
		"https://user:pass@github.com/acme/widgets",
		"https://ghp_token@github.com/acme/widgets",
		"https://github.com@evil.example/acme/widgets",
		"https://github.com:8443/acme/widgets",
		"https://github.com/acme/widgets?x=1",
		"https://github.com/acme/widgets#main",
		"https://github.com/acme/widgets/tree/main",
		"https://github.com/acme",
		"https://github.com/acme/%2e%2e",
		"https://github.com/acme/..",
		"https://github.com\\@evil.example/acme/widgets",
		"https://github.com/-acme/widgets",
		" https://github.com/acme/widgets",
	])("refuse %s", (input) => {
		expect(() => parseRepoUrl(input)).toThrow(GitBrokerError);
	});

	it("follow the deployment's list of repositories", () => {
		const policy = { repos: ["acme/*", "me/notes"] };
		expect(parseRepoUrl("https://github.com/ACME/anything", policy).fullName).toBe("ACME/anything");
		expect(repoRef("me", "Notes.git", policy).fullName).toBe("me/Notes");
		expect(() => repoRef("me", "diary", policy)).toThrow("doesn't let coding threads use me/diary");
		expect(() => repoRef("acmeco", "x", policy)).toThrow(GitBrokerError);
		expect(() => repoRef("acme", "x", { repos: [] })).toThrow(GitBrokerError);
	});
});

describe("branches", () => {
	it("are pushed only under the prefix, and never to main, master or the default branch", () => {
		expect(checkBranch("pim/fix-login", POLICY)).toBe("pim/fix-login");
		expect(() => checkBranch("fix-login", POLICY)).toThrow("start with pim/");
		expect(() => checkBranch("pim/", POLICY)).toThrow(GitBrokerError);
		expect(() => checkBranch("pimx/a", POLICY)).toThrow(GitBrokerError);
		const anyBranch = { branchPrefix: null };
		expect(checkBranch("feature/x", anyBranch)).toBe("feature/x");
		for (const branch of ["main", "master", "Main", "MASTER"]) expect(() => checkBranch(branch, anyBranch)).toThrow("never pushes");
		expect(() => checkBranch("develop", anyBranch, "develop")).toThrow("never pushes");
		expect(() => checkBranch("pim/trunk", POLICY, "pim/trunk")).toThrow("never pushes");
	});

	it.each(["pim/a..b", "pim/a b", "pim/a~1", "pim/a^", "pim/a:b", "pim/a?", "pim/a*", "pim/a[", "pim/a\\b", "pim//a", "pim/a/", "pim/.a", "pim/a.lock", "pim/a.", "pim/a@{1}", "refs/heads/pim/a", "-pim/a", "HEAD", "pim/a\u0000"])(
		"refuse names git doesn't allow: %j",
		(branch) => {
			expect(() => checkBranch(branch, { branchPrefix: null })).toThrow("isn't a branch name git allows");
		},
	);
});

/** A bundle as `git bundle create` makes it, naming `refs`, with a pack of `packBytes` bytes. */
function bundle(refs: Record<string, string>, { prerequisites = [] as string[], packBytes = 32, version = 2 } = {}): Uint8Array {
	const header = [`# v${version} git bundle`, ...(version === 3 ? ["@object-format=sha1"] : []), ...prerequisites.map((sha) => `-${sha} base commit`), ...Object.entries(refs).map(([ref, sha]) => `${sha} ${ref}`)].join("\n");
	const pack = new Uint8Array(packBytes);
	pack.set(encoder.encode("PACK"), 0);
	pack.set([0, 0, 0, 2], 4);
	for (let i = 12; i < packBytes; i++) pack[i] = i % 251;
	const head = encoder.encode(`${header}\n\n`);
	const out = new Uint8Array(head.length + pack.length);
	out.set(head, 0);
	out.set(pack, head.length);
	return out;
}

describe("bundles", () => {
	it("are read for their refs, prerequisites and pack", () => {
		const parsed = parseBundle(bundle({ "refs/heads/pim/x": SHA("b") }, { prerequisites: [SHA("a")], version: 3 }));
		expect([...parsed.refs]).toEqual([["refs/heads/pim/x", SHA("b")]]);
		expect(parsed.prerequisites).toEqual([SHA("a")]);
		expect(new TextDecoder().decode(parsed.pack.subarray(0, 4))).toBe("PACK");
		expect(parsed.pack.length).toBe(32);
	});

	it("are refused when they aren't ones Pim can push", () => {
		expect(() => parseBundle(encoder.encode("not a bundle"))).toThrow(GitBrokerError);
		expect(() => parseBundle(encoder.encode(`# v2 git bundle\n${SHA("b")} refs/heads/pim/x\n\nNOPE`))).toThrow("holds no pack");
		const sha256 = encoder.encode(`# v3 git bundle\n@object-format=sha256\n${SHA("b")} refs/heads/pim/x\n\n`);
		expect(() => parseBundle(sha256)).toThrow(GitBrokerError);
	});
});

const joined = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const advertisement = (refs: Record<string, string>, caps = "report-status delete-refs ofs-delta quiet side-band-64k agent=github/test") => {
	const entries = Object.entries(refs);
	const lines = entries.length === 0 ? [pktLine(`${ZERO} capabilities^{}\0${caps}\n`)] : entries.map(([ref, sha], index) => pktLine(`${sha} ${ref}${index === 0 ? `\0${caps}` : ""}\n`));
	const parts = [pktLine("# service=git-receive-pack\n"), encoder.encode("0000"), ...lines, encoder.encode("0000")];
	return new Response(joined(...parts), { headers: { "content-type": "application/x-git-receive-pack-advertisement" } });
};

const report = (...lines: string[]) =>
	new Response(joined(...lines.map((line) => pktLine(`${line}\n`)), encoder.encode("0000")), {
		headers: { "content-type": "application/x-git-receive-pack-result" },
	});

/** Each ref update a receive-pack request asks for, and the pack after them. */
function receivePackRequest(body: Uint8Array): { commands: string[]; pack: Uint8Array } {
	const commands: string[] = [];
	let at = 0;
	for (;;) {
		const length = Number.parseInt(new TextDecoder().decode(body.subarray(at, at + 4)), 16);
		if (length === 0) return { commands, pack: body.subarray(at + 4) };
		commands.push(new TextDecoder().decode(body.subarray(at + 4, at + length)));
		at += length;
	}
}

const API = "https://api.github.com/repos/acme/widgets";
const GIT = "https://github.com/acme/widgets.git";

/** GitHub as a push sees it: the installation, its token, the repository, its branches, and receive-pack. */
function pushingGitHub(branches: Record<string, string>, extra: Record<string, (call: Call) => Response | Promise<Response>> = {}) {
	return fakeGitHub({
		"POST https://api.github.com/app/installations/77/access_tokens": tokenAnswer(NOW + 60 * 60_000),
		[`GET ${API}`]: () => Response.json({ full_name: "acme/widgets", default_branch: "trunk" }),
		[`GET ${GIT}/info/refs?service=git-receive-pack`]: () => advertisement(branches),
		[`POST ${GIT}/git-receive-pack`]: (call) => {
			const { commands } = receivePackRequest(call.body);
			return report("unpack ok", ...commands.map((command) => `ok ${command.split(/[ \0\n]/)[2]}`));
		},
		...extra,
	});
}

const pushDeps = (github: ReturnType<typeof fakeGitHub>, overrides: Partial<Parameters<typeof pushBranch>[0]> = {}) => ({
	app: appWith(github.fetch, { now: NOW }, { installationId: "77" }),
	policy: POLICY,
	fetch: github.fetch,
	...overrides,
});

const pushRequest = (branch = "pim/fix", head = SHA("b"), extra: object = {}) => ({
	sessionId: "T-123",
	repo: "https://github.com/acme/widgets",
	branch,
	bundle: bundle({ [`refs/heads/${branch}`]: head }),
	...extra,
});

describe("pushing", () => {
	it("fails at once, with nothing sent, while the GitHub App isn't configured", async () => {
		const github = pushingGitHub({});
		const error = await pushBranch({ app: null, policy: POLICY, fetch: github.fetch }, pushRequest()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GitBrokerNotConfiguredError);
		expect((error as Error).message).toBe("GitHub App not configured");
		expect(github.calls).toHaveLength(0);
	});

	it("creates a new branch only if it still doesn't exist, sending the bundle's pack as it is", async () => {
		const github = pushingGitHub({ "refs/heads/trunk": SHA("a") });
		const request = pushRequest();
		const result = await pushBranch(pushDeps(github), request);
		expect(result).toEqual({ repo: "acme/widgets", branch: "pim/fix", before: null, after: SHA("b"), outcome: "created" });
		const pushes = github.calls.filter((call) => call.url === `${GIT}/git-receive-pack`);
		expect(pushes).toHaveLength(1);
		const { commands, pack } = receivePackRequest(pushes[0]!.body);
		expect(commands).toEqual([`${ZERO} ${SHA("b")} refs/heads/pim/fix\0report-status quiet agent=pim-git-broker\n`]);
		expect(pack).toEqual(parseBundle(request.bundle).pack);
		// Pushing needs write access; the token for it is for this repository alone.
		const minted = github.calls.find((call) => call.url.endsWith("/access_tokens"))!;
		expect(JSON.parse(new TextDecoder().decode(minted.body))).toEqual({ repositories: ["widgets"], permissions: { contents: "write" } });
		expect(pushes[0]!.headers.get("authorization")).toBe(`Basic ${btoa(`x-access-token:${APP_TOKEN}`)}`);
	});

	it("moves an existing branch only forward, through a staging ref it deletes afterwards", async () => {
		let patched: unknown = null;
		const github = pushingGitHub(
			{ "refs/heads/trunk": SHA("a"), "refs/heads/pim/fix": SHA("c") },
			{
				[`PATCH ${API}/git/refs/heads/pim/fix`]: (call) => {
					patched = JSON.parse(new TextDecoder().decode(call.body));
					return Response.json({ ref: "refs/heads/pim/fix" });
				},
			},
		);
		const result = await pushBranch(pushDeps(github), pushRequest());
		expect(result).toMatchObject({ before: SHA("c"), after: SHA("b"), outcome: "updated" });
		expect(patched).toEqual({ sha: SHA("b"), force: false });
		const commands = github.calls.filter((call) => call.url === `${GIT}/git-receive-pack`).map((call) => receivePackRequest(call.body).commands[0]!);
		expect(commands).toHaveLength(2);
		const staging = /^0{40} b{40} (refs\/pim-staging\/[0-9a-f-]{36})\0/.exec(commands[0]!)?.[1];
		expect(staging).toBeDefined();
		expect(commands[1]).toBe(`${SHA("b")} ${ZERO} ${staging}\0report-status quiet agent=pim-git-broker\n`);
		// No push ever names the branch itself with receive-pack, which would move it whatever its history.
		expect(commands.some((command) => command.includes("refs/heads/pim/fix"))).toBe(false);
	});

	it("refuses a push that isn't a fast-forward, and still deletes the staging ref", async () => {
		const github = pushingGitHub(
			{ "refs/heads/pim/fix": SHA("c") },
			{ [`PATCH ${API}/git/refs/heads/pim/fix`]: () => Response.json({ message: "Update is not a fast forward" }, { status: 422 }) },
		);
		const error = await pushBranch(pushDeps(github), pushRequest()).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(GitBrokerError);
		expect((error as GitBrokerError).status).toBe(409);
		const pushes = github.calls.filter((call) => call.url === `${GIT}/git-receive-pack`).map((call) => receivePackRequest(call.body).commands[0]!);
		expect(pushes).toHaveLength(2);
		expect(pushes[1]).toMatch(new RegExp(`^${SHA("b")} ${ZERO} refs/pim-staging/`));
	});

	it("does nothing when the branch is already there", async () => {
		const github = pushingGitHub({ "refs/heads/pim/fix": SHA("b") });
		expect((await pushBranch(pushDeps(github), pushRequest())).outcome).toBe("unchanged");
		expect(github.calls.some((call) => call.url === `${GIT}/git-receive-pack`)).toBe(false);
	});

	it("never pushes to the default branch, main or master, or outside the prefix", async () => {
		const github = pushingGitHub({ "refs/heads/trunk": SHA("a") });
		const anyBranch = { branchPrefix: null, repos: null };
		await expect(pushBranch(pushDeps(github, { policy: anyBranch }), pushRequest("trunk"))).rejects.toThrow("never pushes to trunk");
		await expect(pushBranch(pushDeps(github, { policy: anyBranch }), pushRequest("main"))).rejects.toThrow("never pushes to main");
		await expect(pushBranch(pushDeps(github), pushRequest("feature"))).rejects.toThrow("start with pim/");
		expect(github.calls.some((call) => call.url === `${GIT}/git-receive-pack`)).toBe(false);
	});

	it("pushes to the default branch only as a merge, which moves it forward without force and never to another branch", async () => {
		const github = pushingGitHub({ "refs/heads/trunk": SHA("a") }, { [`PATCH ${API}/git/refs/heads/trunk`]: () => Response.json({}) });
		await expect(pushBranch(pushDeps(github), pushRequest("pim/fix", SHA("b"), { toDefault: true }))).rejects.toThrow("isn't acme/widgets's default branch, trunk");
		const result = await pushBranch(pushDeps(github), pushRequest("trunk", SHA("b"), { toDefault: true }));
		expect(result).toMatchObject({ branch: "trunk", before: SHA("a"), after: SHA("b"), outcome: "updated" });
		const patches = github.calls.filter((call) => call.method === "PATCH");
		expect(patches.map((call) => [call.url, JSON.parse(new TextDecoder().decode(call.body))])).toEqual([[`${API}/git/refs/heads/trunk`, { sha: SHA("b"), force: false }]]);
		expect(github.calls.filter((call) => call.url === `${GIT}/git-receive-pack`).every((call) => !receivePackRequest(call.body).commands[0]!.includes("refs/heads/trunk"))).toBe(true);
		// A branch that moved on GitHub is a BranchMovedError, not a rewrite.
		const moved = pushingGitHub({ "refs/heads/trunk": SHA("a") }, { [`PATCH ${API}/git/refs/heads/trunk`]: () => new Response("{}", { status: 422 }) });
		await expect(pushBranch(pushDeps(moved), pushRequest("trunk", SHA("b"), { toDefault: true }))).rejects.toBeInstanceOf(BranchMovedError);
	});

	it("refuses a bundle past the size cap, or one that doesn't name the branch, before asking anyone", async () => {
		const github = pushingGitHub({});
		const big = pushRequest("pim/fix", SHA("b"), { bundle: bundle({ "refs/heads/pim/fix": SHA("b") }, { packBytes: 4096 }) });
		const error = await pushBranch(pushDeps(github, { maxBundleBytes: 4096 }), big).catch((caught: unknown) => caught);
		expect((error as GitBrokerError).status).toBe(413);
		const other = pushRequest("pim/fix", SHA("b"), { bundle: bundle({ "refs/heads/pim/other": SHA("b") }) });
		await expect(pushBranch(pushDeps(github), other)).rejects.toThrow("doesn't name refs/heads/pim/fix");
		expect(github.calls).toHaveLength(0);
	});

	it("describes a push for the person's approval without the bundle", () => {
		const github = pushingGitHub({});
		const approval = pushApprovalRequest(preparePush(pushDeps(github), pushRequest()));
		expect(approval).toEqual({
			action: "coding_push_for_approval",
			sessionId: "T-123",
			repo: "acme/widgets",
			branch: "pim/fix",
			head: SHA("b"),
			bytes: pushRequest().bundle.length,
			summary: `Push pim/fix (${SHA("b").slice(0, 12)}, 1 KB) to github.com/acme/widgets`,
		});
	});
});

const UPLOAD_ADVERTISEMENT = "application/x-git-upload-pack-advertisement";
const UPLOAD_RESULT = "application/x-git-upload-pack-result";

async function brokerFor(github: ReturnType<typeof fakeGitHub>, overrides: Partial<GitBrokerDeps> = {}) {
	const key = await brokerKey("directory-secret");
	const deps: GitBrokerDeps = { key, app: null, policy: POLICY, fetch: github.fetch, now: () => NOW, ...overrides };
	const token = await issueBrokerToken(key, { sessionId: "T-123", repo: WIDGETS, now: NOW });
	const ask = (path: string, init: RequestInit = {}, auth: string | null = `Basic ${btoa(`x:${token}`)}`) => {
		const request = new Request(`https://pim.test/api${path}`, { ...init, headers: { ...(auth ? { Authorization: auth } : {}), ...(init.headers as Record<string, string>) } });
		return handleGitBroker(request, new URL(request.url).pathname.slice("/api".length), deps);
	};
	return { ask, token, key };
}

const REFS = "/coding/git/acme/widgets.git/info/refs?service=git-upload-pack";

describe("the clone and fetch proxy under rate limits", () => {
	const pause = () => {
		const waits: number[] = [];
		return { waits, sleep: async (ms: number) => void waits.push(ms), random: () => 0 };
	};
	const advertisement = () => new Response("refs", { headers: { "content-type": UPLOAD_ADVERTISEMENT } });
	const refsUrl = `GET ${GIT}/info/refs?service=git-upload-pack`;

	it("asks again after a 429 and passes on the answer that follows, waiting as long as Retry-After said", async () => {
		let asked = 0;
		const github = fakeGitHub({ [refsUrl]: () => (++asked < 3 ? new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }) : advertisement()) });
		const { waits, ...timing } = pause();
		const { ask } = await brokerFor(github, timing);
		const response = await ask(REFS);
		expect(response.status).toBe(200);
		expect(await bodyText(response)).toBe("refs");
		expect(github.calls).toHaveLength(3);
		expect(waits).toEqual([7000, 7000]);
	});

	it("backs off exponentially without a Retry-After, and retries 502s and rate limit 403s but not other 403s", async () => {
		const answers = [new Response("", { status: 502 }), new Response("You have exceeded a secondary rate limit", { status: 403 }), advertisement()];
		const github = fakeGitHub({ [refsUrl]: () => answers.shift()! });
		const { waits, ...timing } = pause();
		const { ask } = await brokerFor(github, timing);
		expect((await ask(REFS)).status).toBe(200);
		expect(waits).toEqual([1000, 2000]);
		const forbidden = fakeGitHub({ [refsUrl]: () => new Response("Repository access blocked", { status: 403 }) });
		expect((await (await brokerFor(forbidden, timing)).ask(REFS)).status).toBe(404);
		expect(forbidden.calls).toHaveLength(1);
	});

	it("caps a long Retry-After, and gives 429 with Retry-After once the attempts are used", async () => {
		const github = fakeGitHub({ [refsUrl]: () => new Response("", { status: 429, headers: { "Retry-After": "3600" } }) });
		const { waits, ...timing } = pause();
		const { ask } = await brokerFor(github, timing);
		const response = await ask(REFS);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("20");
		expect(github.calls).toHaveLength(4);
		expect(waits).toEqual([20_000, 20_000, 20_000]);
	});

	it("retries an upload-pack request with the same body, and a persistent 503 stays a 502", async () => {
		let asked = 0;
		const url = `POST ${GIT}/git-upload-pack`;
		const github = fakeGitHub({ [url]: () => (++asked < 2 ? new Response("", { status: 503 }) : new Response("pack", { headers: { "content-type": UPLOAD_RESULT } })) });
		const { ask } = await brokerFor(github, pause());
		const response = await ask("/coding/git/acme/widgets.git/git-upload-pack", { method: "POST", body: "0032want abc\n", headers: { "Content-Type": "application/x-git-upload-pack-request" } });
		expect(response.status).toBe(200);
		expect(github.calls.map((call) => new TextDecoder().decode(call.body))).toEqual(["0032want abc\n", "0032want abc\n"]);
		const down = fakeGitHub({ [refsUrl]: () => new Response("", { status: 503 }) });
		expect((await (await brokerFor(down, pause())).ask(REFS)).status).toBe(502);
		expect(down.calls).toHaveLength(4);
	});

	it("never serves, so never retries, receive-pack", async () => {
		const github = fakeGitHub({});
		const { ask } = await brokerFor(github, pause());
		const response = await ask("/coding/git/acme/widgets.git/info/refs?service=git-receive-pack");
		expect(response.status).toBe(403);
		expect((await ask("/coding/git/acme/widgets.git/git-receive-pack", { method: "POST", body: "x" })).status).toBeGreaterThanOrEqual(400);
		expect(github.calls).toHaveLength(0);
	});
});

describe("the clone and fetch proxy", () => {
	it("asks for the broker token, the way git understands", async () => {
		const github = fakeGitHub({});
		const { ask } = await brokerFor(github);
		const response = await ask(REFS, {}, null);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Basic realm="Pim git broker"');
		expect((await ask(REFS, {}, "Bearer pimgit_forged.token")).status).toBe(401);
		expect(github.calls).toHaveLength(0);
	});

	it("clones a public repository anonymously while the App isn't configured", async () => {
		const github = fakeGitHub({ [`GET ${GIT}/info/refs?service=git-upload-pack`]: () => new Response("refs", { headers: { "content-type": UPLOAD_ADVERTISEMENT } }) });
		const { ask } = await brokerFor(github);
		const response = await ask(REFS, { headers: { "Git-Protocol": "version=2" } });
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(UPLOAD_ADVERTISEMENT);
		expect(await bodyText(response)).toBe("refs");
		expect(github.calls[0]!.headers.get("authorization")).toBeNull();
		expect(github.calls[0]!.headers.get("git-protocol")).toBe("version=2");
		expect(github.calls[0]!.method).toBe("GET");
	});

	it("fetches with a read-only token for that repository when the App is installed on it, and the workspace never sees it", async () => {
		const github = fakeGitHub({
			"POST https://api.github.com/app/installations/77/access_tokens": tokenAnswer(NOW + 60 * 60_000),
			[`POST ${GIT}/git-upload-pack`]: (call) => new Response(`packfile for ${new TextDecoder().decode(call.body)}`, { headers: { "content-type": UPLOAD_RESULT } }),
		});
		const { ask } = await brokerFor(github, { app: appWith((input, init) => github.fetch(input, init), { now: NOW }, { installationId: "77" }) });
		const response = await ask("/coding/git/acme/widgets.git/git-upload-pack", {
			method: "POST",
			body: "0032want 0123",
			headers: { "Content-Type": "application/x-git-upload-pack-request" },
		});
		expect(response.status).toBe(200);
		const body = await bodyText(response);
		expect(body).toBe("packfile for 0032want 0123");
		expect(body).not.toContain(APP_TOKEN);
		expect([...response.headers].join()).not.toContain(APP_TOKEN);
		const minted = github.calls.find((call) => call.url.endsWith("/access_tokens"))!;
		expect(JSON.parse(new TextDecoder().decode(minted.body))).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
		expect(github.calls.at(-1)!.headers.get("authorization")).toBe(`Basic ${btoa(`x-access-token:${APP_TOKEN}`)}`);
	});

	it("serves only the repository the token is for, and never receive-pack", async () => {
		const github = fakeGitHub({});
		const { ask } = await brokerFor(github);
		expect((await ask("/coding/git/acme/gears.git/info/refs?service=git-upload-pack")).status).toBe(403);
		expect((await ask("/coding/git/acme/widgets.git/info/refs?service=git-receive-pack")).status).toBe(403);
		expect((await ask("/coding/git/acme/widgets.git/git-receive-pack", { method: "POST", body: "x" })).status).toBe(404);
		expect((await ask("/coding/git/acme/widgets.git/HEAD")).status).toBe(404);
		expect((await ask("/coding/git/127.0.0.1/widgets.git/info/refs?service=git-upload-pack")).status).toBe(400);
		expect(github.calls).toHaveLength(0);
	});

	it("follows no redirect, and says a repository it can't read isn't there", async () => {
		const github = fakeGitHub({
			[`GET ${GIT}/info/refs?service=git-upload-pack`]: () => new Response(null, { status: 301, headers: { location: "http://169.254.169.254/" } }),
		});
		const { ask } = await brokerFor(github);
		const response = await ask(REFS);
		expect(response.status).toBe(404);
		expect(github.calls).toHaveLength(1);
	});

	it("caps what it takes from git and what it passes on from GitHub", async () => {
		const github = fakeGitHub({
			[`POST ${GIT}/git-upload-pack`]: () => new Response(new Uint8Array(4096), { headers: { "content-type": UPLOAD_RESULT } }),
		});
		const { ask } = await brokerFor(github, { maxRequestBytes: 100, maxResponseBytes: 1000 });
		const post = (body: string) =>
			ask("/coding/git/acme/widgets.git/git-upload-pack", { method: "POST", body, headers: { "Content-Type": "application/x-git-upload-pack-request" } });
		expect((await post("x".repeat(101))).status).toBe(413);
		expect(github.calls).toHaveLength(0);
		const response = await post("x".repeat(100));
		expect(response.status).toBe(200);
		await expect(response.arrayBuffer()).rejects.toThrow();
	});

	it("is served by the Worker before any account's sign-in", async () => {
		const unauthorized = await exports.default.fetch(`https://pim.test/api${REFS}`);
		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("www-authenticate")).toBe('Basic realm="Pim git broker"');
		const token = await issueBrokerToken(await brokerTokenKey(env), { sessionId: "T-123", repo: WIDGETS });
		const github = fakeGitHub({ [`GET ${GIT}/info/refs?service=git-upload-pack`]: () => new Response("refs", { headers: { "content-type": UPLOAD_ADVERTISEMENT } }) });
		vi.spyOn(globalThis, "fetch").mockImplementation(github.fetch);
		const response = await exports.default.fetch(`https://pim.test/api${REFS}`, { headers: { Authorization: `Bearer ${token}` } });
		expect(response.status).toBe(200);
		expect(await bodyText(response)).toBe("refs");
		// The tests' deployment has no GitHub App, so the clone is anonymous.
		expect(github.calls[0]!.headers.get("authorization")).toBeNull();
	});
});

describe("secrets", () => {
	it("never appear in errors, answers or logs", async () => {
		const seen: string[] = [];
		for (const method of ["log", "error", "warn", "info", "debug"] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
				seen.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
			});
		}
		const record = async (work: Promise<unknown>) => {
			try {
				const result = await work;
				if (result instanceof Response) seen.push(await bodyText(result), [...result.headers].join());
			} catch (error) {
				seen.push(String(error), (error as Error).message ?? "");
			}
		};
		const jwts: string[] = [];
		const failing = (status: number) => (call: Call) => {
			const auth = call.headers.get("authorization");
			if (auth?.startsWith("Bearer ey")) jwts.push(auth.slice(7));
			return Response.json({ message: `failed with ${auth}` }, { status });
		};
		// GitHub refuses the App's token request.
		const refused = fakeGitHub({ "POST https://api.github.com/app/installations/77/access_tokens": failing(500) });
		await record(pushBranch(pushDeps(refused), pushRequest()));
		// GitHub refuses the push, and the cleanup after it.
		const rejecting = pushingGitHub(
			{ "refs/heads/pim/fix": SHA("c") },
			{
				[`PATCH ${API}/git/refs/heads/pim/fix`]: failing(500),
				[`POST ${GIT}/git-receive-pack`]: (call) =>
					receivePackRequest(call.body).commands[0]!.startsWith(ZERO) ? report("unpack ok", `ok ${receivePackRequest(call.body).commands[0]!.split(/[ \0]/)[2]}`) : report("unpack ok", "ng refs/pim-staging/x failed"),
			},
		);
		await record(pushBranch(pushDeps(rejecting), pushRequest()));
		const unpackFails = pushingGitHub({}, { [`POST ${GIT}/git-receive-pack`]: () => report("unpack index-pack failed") });
		await record(pushBranch(pushDeps(unpackFails), pushRequest()));
		// The proxy, when GitHub fails, and when the App's token can't be had.
		const upstream = fakeGitHub({
			"POST https://api.github.com/app/installations/77/access_tokens": tokenAnswer(NOW + 60 * 60_000),
			[`GET ${GIT}/info/refs?service=git-upload-pack`]: failing(500),
		});
		const app = appWith(upstream.fetch, { now: NOW }, { installationId: "77" });
		const { ask } = await brokerFor(upstream, { app });
		await record(ask(REFS));
		const noToken = fakeGitHub({ "POST https://api.github.com/app/installations/77/access_tokens": failing(500) });
		const { ask: askWithout } = await brokerFor(noToken, { app: appWith(noToken.fetch, { now: NOW }, { installationId: "77" }) });
		await record(askWithout(REFS));
		await record(importPrivateKey(pkcs1Pem.replace("MII", "!!!")));

		expect(seen.length).toBeGreaterThan(5);
		expect(jwts.length).toBeGreaterThan(0);
		const everything = seen.join("\n");
		expect(everything).not.toContain(APP_TOKEN);
		expect(everything).not.toContain(btoa(`x-access-token:${APP_TOKEN}`));
		expect(everything).not.toContain(keyBody);
		for (const jwt of jwts) expect(everything).not.toContain(jwt);
	});
});

describe("git provider instances", () => {
	/** A stand-in for a second host, which only knows its own URLs. */
	const gitea: GitProvider = {
		instance: { id: "gitea", kind: "gitea", baseUrl: "https://gitea.example.test", label: "Gitea" },
		parseRepoUrl: (input) => {
			const [owner, name] = new URL(input).pathname.slice(1).split("/") as [string, string];
			return { owner, name, fullName: `${owner}/${name}` };
		},
		repoUrl: (repo) => `https://gitea.example.test/${repo.fullName}`,
		gitUrl: (repo) => `https://gitea.example.test/${repo.fullName}.git`,
		credential: async () => null,
		defaultBranch: async () => "main",
		createPullRequest: async () => ({ url: "https://gitea.example.test/o/n/pulls/1", number: 1 }),
	};

	it("seeds the one GitHub instance", () => {
		expect(SEEDED_INSTANCES).toEqual([{ id: "github", kind: "github", baseUrl: "https://github.com", label: "GitHub" }]);
		expect(new ProviderRegistry([new GitHubProvider(null)]).instances()).toEqual([GITHUB_INSTANCE]);
	});

	it("resolves a URL to the instance whose host it is on, and an absent instance to GitHub", () => {
		const registry = new ProviderRegistry([new GitHubProvider(null), gitea]);
		expect(registry.resolveUrl("https://github.com/acme/widgets.git")).toMatchObject({ provider: { instance: { id: "github" } }, repo: WIDGETS });
		expect(registry.resolveUrl("https://gitea.example.test/acme/widgets").provider.instance.id).toBe("gitea");
		expect(registry.get(undefined).instance.id).toBe("github");
		expect(registry.get(null).instance.id).toBe("github");
		expect(registry.get("gitea")).toBe(gitea);
		expect(() => registry.get("nope")).toThrow(GitBrokerError);
	});

	it("holds a URL on an unknown host to GitHub's rules, which refuse it", () => {
		const registry = new ProviderRegistry([new GitHubProvider(null)]);
		expect(() => registry.resolveUrl("https://gitlab.com/acme/widgets")).toThrow("A repository must be https://github.com/<owner>/<name>");
		expect(() => registry.resolveUrl("https://github.com/acme/widgets", { repos: ["me/notes"] })).toThrow(/doesn't let coding threads use/);
	});

	it("refuses a duplicate id, or a registry without GitHub", () => {
		expect(() => new ProviderRegistry([new GitHubProvider(null), new GitHubProvider(null)])).toThrow();
		expect(() => new ProviderRegistry([gitea])).toThrow();
	});

	it("wraps the GitHub App: credentials, URLs and the default branch", async () => {
		const tokens: string[] = [];
		const app = {
			installationToken: async (repo: RepoRef, access: string) => {
				tokens.push(`${repo.fullName}:${access}`);
				if (repo.name === "private") throw new RepoNotInstalledError(repo);
				return { token: "t0ken", expiresAt: NOW + 3_600_000 };
			},
		} as unknown as GitHubApp;
		const requests: string[] = [];
		const fetcher = async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return Response.json({ default_branch: "trunk" });
		};
		const provider = new GitHubProvider(app, { fetch: fetcher, policy: POLICY });
		expect(provider.repoUrl(WIDGETS)).toBe("https://github.com/acme/widgets");
		expect(provider.gitUrl(WIDGETS)).toBe("https://github.com/acme/widgets.git");
		expect(await provider.credential(WIDGETS, "read")).toEqual({ username: "x-access-token", token: "t0ken" });
		expect(await provider.credential({ owner: "acme", name: "private", fullName: "acme/private" }, "read")).toBeNull();
		await expect(provider.credential({ owner: "acme", name: "private", fullName: "acme/private" }, "write")).rejects.toBeInstanceOf(RepoNotInstalledError);
		expect(await provider.defaultBranch(WIDGETS)).toBe("trunk");
		expect(requests).toEqual(["https://api.github.com/repos/acme/widgets"]);
		expect(tokens).toContain("acme/widgets:write");
	});

	it("reads anonymously without the App, and refuses to write", async () => {
		const provider = new GitHubProvider(null);
		expect(await provider.credential(WIDGETS, "read")).toBeNull();
		await expect(provider.credential(WIDGETS, "write")).rejects.toBeInstanceOf(GitBrokerNotConfiguredError);
	});

	it("opens a pull request with a write token", async () => {
		const app = { installationToken: async () => ({ token: "t0ken", expiresAt: NOW + 3_600_000 }) } as unknown as GitHubApp;
		let seen: { url: string; init?: RequestInit } | null = null;
		const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
			seen = { url: String(input), init };
			return Response.json({ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }, { status: 201 });
		};
		const pr = await new GitHubProvider(app, { fetch: fetcher }).createPullRequest({ repo: WIDGETS, head: "pim/x", base: "main", title: "T", body: "B" });
		expect(pr).toEqual({ url: "https://github.com/acme/widgets/pull/7", number: 7 });
		expect(seen!.url).toBe("https://api.github.com/repos/acme/widgets/pulls");
		expect(JSON.parse(String(seen!.init!.body))).toEqual({ head: "pim/x", base: "main", title: "T", body: "B" });
	});
});
