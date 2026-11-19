// The git broker, end to end: the real git client in a "sandbox" directory talks to the broker, which talks to `git http-backend` standing in for the git host.
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitBroker, pushCommands } from "../src/http/git-broker";
import { ScriptedPort, startReq, ada, stack } from "./stack";
import { GitHttpHost } from "./git-http-backend";
import { serve } from "./serve";

describe("git broker over smart HTTP", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let host: GitHttpHost;
	let broker: Awaited<ReturnType<typeof serve>>;
	let n = 0;
	const UPSTREAM_AUTH = "Basic dXBzdHJlYW06c2VjcmV0";

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		execFileSync("git", ["--git-dir", s.bare, "config", "http.receivepack", "true"]);
		host = await new GitHttpHost(s.dir).start();
		broker = await serve(gitBroker({ credentials: s.credentials, store: s.store, git: s.git, upstream: async () => ({ url: `${host.url}/app.git`, authorization: UPSTREAM_AUTH }) }));
	});
	afterAll(async () => {
		await broker.stop();
		await host.stop();
		await s.close();
	});

	const thread = async () => {
		const { threadId } = await s.forge.start(ada, startReq(`broker-${++n}`, { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(threadId);
		return (await s.store.get(threadId))!;
	};
	/** The git client runs as a child process, asynchronously: the broker is served from this very process. */
	const git = (cwd: string, token: string | null, ...args: string[]) => {
		const header = token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
		return new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
			execFile("git", [...header, "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: cwd, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => done({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })),
		);
	};
	const url = () => `${broker.url}/api/coding/git/acme/app.git`;
	const hostRef = (ref: string) => execFileSync("git", ["--git-dir", s.bare, "rev-parse", ref], { encoding: "utf8" }).trim();
	const sandbox = () => mkdtempSync(join(tmpdir(), "sbx-"));

	it("clones with a token, pushes the thread's own pim/* branch, records it, and hides the host's credential", async () => {
		const t = await thread();
		const dir = sandbox();
		const push = s.credentials.gitToken(t, { repo: "acme/app", scope: "push" });
		const clone = await git(dir, push, "clone", url(), "w");
		expect(clone.status, clone.stderr).toBe(0);
		const w = join(dir, "w");
		await git(w, null, "checkout", "-b", t.branch!);
		execFileSync("sh", ["-c", "echo hi > a.txt"], { cwd: w });
		await git(w, null, "add", ".");
		await git(w, null, "commit", "-m", "work");
		const sha = (await git(w, null, "rev-parse", "HEAD")).stdout.trim();
		const pushed = await git(w, push, "push", "origin", `HEAD:refs/heads/${t.branch}`);
		expect(pushed.status, pushed.stderr).toBe(0);
		expect(hostRef(`refs/heads/${t.branch}`)).toBe(sha);
		expect((await s.store.get(t.threadId))!.lastPushedSha).toBe(sha);
		expect((await s.forge.eventsAfter(ada, t.threadId)).some((e) => e.kind === "git.push")).toBe(true);
		// The host only ever saw the broker's own credential, never the sandbox's token.
		expect(host.requests.length).toBeGreaterThan(0);
		expect(host.requests.every((r) => r.auth === UPSTREAM_AUTH)).toBe(true);
	});

	it("refuses a push to main, to another branch, to a branch that isn't the thread's own, a delete, and a push on a read token", async () => {
		const t = await thread();
		const dir = sandbox();
		const push = s.credentials.gitToken(t, { repo: "acme/app", scope: "push" });
		const read = s.credentials.gitToken(t, { repo: "acme/app", scope: "read" });
		expect((await git(dir, read, "clone", url(), "w")).status).toBe(0);
		const w = join(dir, "w");
		execFileSync("sh", ["-c", "echo x > b.txt"], { cwd: w });
		await git(w, null, "add", ".");
		await git(w, null, "commit", "-m", "c");
		const mainBefore = hostRef("main");
		for (const ref of ["refs/heads/main", "refs/heads/feature/x", "refs/heads/pim/someone-elses-1234", "refs/tags/v1"]) {
			const r = await git(w, push, "push", "origin", `HEAD:${ref}`);
			expect(r.status, ref).not.toBe(0);
			expect(r.stderr, ref).toMatch(/403|refused|denied/i);
		}
		// A read grant can't even start a push; a delete is refused whoever asks.
		expect((await git(w, read, "push", "origin", `HEAD:refs/heads/${t.branch}`)).status).not.toBe(0);
		expect((await git(w, push, "push", "origin", `HEAD:refs/heads/${t.branch}`)).status).toBe(0);
		expect((await git(w, push, "push", "origin", `:refs/heads/${t.branch}`)).status).not.toBe(0);
		expect(hostRef("main")).toBe(mainBefore);
		expect(hostRef(`refs/heads/${t.branch}`)).toBeTruthy();
	});

	it("takes a fast-forward of the thread's branch but refuses a force push, leaving the branch and no staging refs behind", async () => {
		const t = await thread();
		const dir = sandbox();
		const push = s.credentials.gitToken(t, { repo: "acme/app", scope: "push" });
		expect((await git(dir, push, "clone", url(), "w")).status).toBe(0);
		const w = join(dir, "w");
		await git(w, null, "checkout", "-b", t.branch!);
		const commit = async (file: string) => {
			execFileSync("sh", ["-c", `echo ${file} > ${file}`], { cwd: w });
			await git(w, null, "add", ".");
			await git(w, null, "commit", "-m", file);
			return (await git(w, null, "rev-parse", "HEAD")).stdout.trim();
		};
		await commit("one.txt");
		expect((await git(w, push, "push", "origin", `HEAD:refs/heads/${t.branch}`)).status).toBe(0);
		const two = await commit("two.txt");
		const ff = await git(w, push, "push", "origin", `HEAD:refs/heads/${t.branch}`);
		expect(ff.status, ff.stderr).toBe(0);
		expect(hostRef(`refs/heads/${t.branch}`)).toBe(two);
		expect((await s.store.get(t.threadId))!.lastPushedSha).toBe(two);
		// Rewrite history and force it: refused, and the branch stays where it was.
		await git(w, null, "reset", "--hard", "HEAD~2");
		await commit("other.txt");
		const forced = await git(w, push, "push", "--force", "origin", `HEAD:refs/heads/${t.branch}`);
		expect(forced.status).not.toBe(0);
		expect(forced.stderr).toMatch(/fast-forward|403|rejected/i);
		expect(hostRef(`refs/heads/${t.branch}`)).toBe(two);
		expect((await s.store.get(t.threadId))!.lastPushedSha).toBe(two);
		expect(execFileSync("git", ["--git-dir", s.bare, "for-each-ref", "refs/heads/pim-staging"], { encoding: "utf8" }).trim()).toBe("");
	});

	it("checks the thread's state on every request: abort, archive and suspension cut a token off at once", async () => {
		const dir = sandbox();
		const ok = async (tok: string) => (await git(dir, tok, "ls-remote", url())).status === 0;
		const a = await thread();
		const ta = s.credentials.gitToken(a, { repo: "acme/app", scope: "read" });
		expect(await ok(ta)).toBe(true);
		await s.forge.abort(ada, a.threadId);
		expect(await ok(ta)).toBe(false);

		const b = await thread();
		const tb = s.credentials.gitToken(b, { repo: "acme/app", scope: "read" });
		expect(await ok(tb)).toBe(true);
		await s.authz.setSuspended("ada", true);
		expect(await ok(tb)).toBe(false);
		await s.authz.setSuspended("ada", false);
		expect(await ok(tb)).toBe(true);
		await s.forge.archive(ada, b.threadId);
		expect(await ok(tb)).toBe(false);

		const c = await thread();
		expect(await ok("pimgit_forged.token")).toBe(false);
		expect(await ok(s.credentials.gitToken(c, { repo: "acme/other", scope: "read" }))).toBe(false);
	});

	it("trades a grant for a fresh one on the credential endpoint, only while the thread lives", async () => {
		const t = await thread();
		const old = s.credentials.gitToken(t, { repo: "acme/app", scope: "push", ttlMs: 60_000 });
		const res = await fetch(`${url()}/credential`, { method: "POST", headers: { authorization: `Bearer ${old}` } });
		expect(res.status).toBe(200);
		const { token } = (await res.json()) as { token: string };
		expect(token).toMatch(/^pimgit_/);
		expect(token).not.toBe(old);
		expect((await git(sandbox(), token, "ls-remote", url())).status).toBe(0);
		await s.forge.archive(ada, t.threadId);
		expect((await fetch(`${url()}/credential`, { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
		expect((await fetch(`${url()}/info/refs?service=git-upload-pack`)).status).toBe(401);
	});

	it("asks the host again when it is rate limiting or briefly down, after the pause it asked for, and passes on what it still says after the last try", async () => {
		const t = await thread();
		const read = s.credentials.gitToken(t, { repo: "acme/app", scope: "read" });
		const answers: Response[] = [];
		const waits: number[] = [];
		let asks = 0;
		let outage = false;
		const flaky = await serve(
			gitBroker({
				credentials: s.credentials,
				store: s.store,
				git: s.git,
				upstream: async () => ({ url: `${host.url}/app.git`, authorization: UPSTREAM_AUTH }),
				sleep: async (ms) => void waits.push(ms),
				random: () => 0,
				fetch: async (input, init) => {
					if (String(input).includes("info/refs")) asks++;
					if (answers.length) return answers.shift()!;
					return outage ? new Response("down", { status: 503 }) : fetch(input, init);
				},
			}),
		);
		try {
			const ls = (token: string) => git(sandbox(), token, "ls-remote", `${flaky.url}/api/coding/git/acme/app.git`);
			// Rate limited with a Retry-After, then briefly unavailable, then well.
			answers.push(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }), new Response("bad gateway", { status: 502 }));
			const ok = await ls(read);
			expect(ok.status, ok.stderr).toBe(0);
			expect(ok.stdout).toContain("refs/heads/main");
			expect(asks).toBe(3);
			expect(waits).toEqual([2000, 2000]);
			// A host that stays down is asked a bounded number of times, and its answer is what the sandbox's git sees.
			asks = 0;
			outage = true;
			const down = await ls(read);
			expect(down.status).not.toBe(0);
			expect(down.stderr).toMatch(/503/);
			expect(asks).toBe(4);
		} finally {
			await flaky.stop();
		}
	});

	it("refuses a fetch's negotiation past the limit unread, and cuts off an answer that is too large", async () => {
		const t = await thread();
		const read = s.credentials.gitToken(t, { repo: "acme/app", scope: "read" });
		const small = await serve(gitBroker({ credentials: s.credentials, store: s.store, git: s.git, upstream: async () => ({ url: `${host.url}/app.git`, authorization: UPSTREAM_AUTH }), maxRequestBytes: 64, maxResponseBytes: 50 }));
		try {
			const big = await fetch(`${small.url}/api/coding/git/acme/app.git/git-upload-pack`, { method: "POST", headers: { authorization: `Bearer ${read}`, "content-type": "application/x-git-upload-pack-request" }, body: "x".repeat(65) });
			expect(big.status).toBe(413);
			// The answer is cut off part-way, which the sandbox's git reports as a failed fetch.
			await expect((async () => (await fetch(`${small.url}/api/coding/git/acme/app.git/info/refs?service=git-upload-pack`, { headers: { authorization: `Bearer ${read}` } })).arrayBuffer())()).rejects.toThrow();
		} finally {
			await small.stop();
		}
	});

	it("reads a push's commands from its pkt-lines", () => {
		const line = (text: string) => new TextEncoder().encode((text.length + 4).toString(16).padStart(4, "0") + text);
		const a = "a".repeat(40);
		const b = "b".repeat(40);
		const body = new Uint8Array([...line(`${a} ${b} refs/heads/pim/x\0report-status`), ...new TextEncoder().encode("0000"), 1, 2, 3]);
		expect(pushCommands(body)).toEqual([{ old: a, next: b, ref: "refs/heads/pim/x" }]);
		expect(() => pushCommands(new TextEncoder().encode("zzzz"))).toThrow();
	});
});
