// The real GitHost over a git provider and smart HTTP: the same Forge facade, a fake provider whose host is `git http-backend`.
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitProvider } from "@pim/coding/git-broker/provider";
import { ProviderRegistry, GITHUB_INSTANCE } from "@pim/coding/git-broker/provider";
import { Forge } from "../src/forge";
import { ProviderGitHost, providerUpstream } from "../src/provider-git";
import { ScriptedPort, ada, startReq, stack } from "./stack";
import { GitHttpHost } from "./git-http-backend";

const AUTH = `Basic ${btoa("x-access-token:app-token")}`;

describe("ProviderGitHost", () => {
	let s: Awaited<ReturnType<typeof stack>>;
	let host: GitHttpHost;
	let forge: Forge;
	let provider: GitProvider;
	const hostGit = (...a: string[]) => execFileSync("git", ["--git-dir", s.bare, ...a], { encoding: "utf8" }).trim();
	let credentialCalls: string[] = [];

	beforeAll(async () => {
		s = await stack();
		await s.grantAll("ada");
		hostGit("config", "http.receivepack", "true");
		host = await new GitHttpHost(s.dir).start();
		provider = {
			instance: GITHUB_INSTANCE,
			parseRepoUrl: (u: string) => ({ owner: "acme", name: "app", fullName: "acme/app", url: u }) as never,
			repoUrl: () => "https://github.com/acme/app",
			gitUrl: () => `${host.url}/app.git`,
			credential: async (_r: unknown, access: string) => (credentialCalls.push(access), { username: "x-access-token", token: "app-token" }),
			defaultBranch: async () => hostGit("symbolic-ref", "--short", "HEAD"),
			listBranches: async () => new Map(hostGit("for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads").split("\n").filter(Boolean).map((l) => l.split(" ") as [string, string])),
			resolveCommit: async (_r: unknown, ref: string) => hostGit("rev-parse", ref),
			compareDiff: async (_r: unknown, base: string, head: string) => ({ baseSha: base, headSha: head, diff: hostGit("diff", `${base}...${head}`) }),
			createPullRequest: async (i: { head: string }) => ({ url: `https://github.com/acme/app/pull/7?head=${i.head}`, number: 7 }),
		} as unknown as GitProvider;
		const registry = new ProviderRegistry([provider]);
		const gitHost = new ProviderGitHost({ registry, compute: s.sandboxes, repoDir: "", scratchDir: s.dir });
		forge = new Forge({ db: s.db, store: s.store, authz: s.authz, scheduler: s.scheduler, credentials: s.credentials, git: gitHost, objects: s.objects, orbs: () => s.orb, compute: s.sandboxes, ampConfigured: true, repoDir: "." });
		(globalThis as any).__registry = registry;
	});
	afterAll(async () => {
		await host.stop();
		await s.close();
	});

	it("merges an Amp thread's own pushed branch by fast-forward, then by rebase, signing in with the deployment's credential", async () => {
		const clone = await s.sandboxes.create("amp-pusher-2");
		await s.sandboxes.exec(clone, ["git", "clone", s.bare, "."]);
		const mk = async (branch: string, file: string) => {
			await s.sandboxes.exec(clone, ["git", "checkout", "-q", "-B", branch, "origin/main"]);
			await s.sandboxes.exec(clone, ["sh", "-c", `echo ${branch} > ${file}`]);
			await s.sh(clone, "add", ".");
			await s.sh(clone, "commit", "-m", branch);
			await s.sh(clone, "push", s.bare, `${branch}:refs/heads/${branch}`);
		};
		const orbs = async (n: string) => {
			const { threadId } = await forge.start(ada, startReq(n, { harness: "amp" }));
			// The thread begins first: what the host holds then is not its to follow, what it pushes after is.
			await s.worker({ git: (forge as any).c.git }).step(threadId);
			return threadId;
		};
		const a = await orbs("pg-1");
		const b = await orbs("pg-2");
		await mk("amp-a-1111", "a.txt");
		await mk("amp-b-2222", "b.txt");
		expect(await forge.recordOrbBranch(a, "amp-a-1111")).toBe(true);
		expect(await forge.recordOrbBranch(b, "amp-b-2222")).toBe(true);
		credentialCalls = [];
		expect(await forge.merge(ada, a)).toMatchObject({ outcome: "merged", method: "fast-forward" });
		expect(hostGit("show", "main:a.txt")).toBe("amp-a-1111");
		// main moved under b: it rebases.
		expect(await forge.merge(ada, b)).toMatchObject({ outcome: "merged", method: "rebase" });
		expect(hostGit("show", "main:b.txt")).toBe("amp-b-2222");
		expect(hostGit("show", "main:a.txt")).toBe("amp-a-1111");
		expect(credentialCalls).toContain("write");
		expect(host.requests.some((r) => r.auth === AUTH)).toBe(true);
		// Its diff and pull request come from the provider's API.
		expect((await forge.diff(ada, b)).unpushedOrb).toBe(false);
		expect(await forge.openPullRequest(ada, b)).toMatchObject({ status: "done", number: 7 });
	});

	it("pushes a sandbox thread's work by bundle, unchanged the second time, and deletes its branch only when asked", async () => {
		const { threadId } = await forge.start(ada, startReq("pg-3", { harness: "claude-code" }));
		await s.worker({ turns: { "claude-code": new ScriptedPort([{ outcome: "completed" }]) } }).step(threadId);
		const t = (await s.store.get(threadId))!;
		// The provider host reads the checkout where the sandbox keeps it: here, its working directory.
		const dir = s.sandboxes.workdir(t.workspaceRef);
		(forge as any).c.git = new ProviderGitHost({ registry: (globalThis as any).__registry, compute: s.sandboxes, repoDir: dir, scratchDir: s.dir });
		await s.commit(threadId, "bundle.txt", "bundled");
		const pushed = await forge.push(ada, threadId);
		expect(pushed).toMatchObject({ status: "done", outcome: "pushed" });
		expect(hostGit("show", `${t.branch}:bundle.txt`)).toBe("bundled");
		expect(await forge.push(ada, threadId)).toMatchObject({ outcome: "unchanged" });
		await forge.deleteRemoteBranch(ada, threadId);
		expect(() => hostGit("rev-parse", "--verify", `refs/heads/${t.branch}`)).toThrow();
		expect(await providerUpstream({ registry: (globalThis as any).__registry })("https://github.com/acme/app", "read")).toEqual({ url: `${host.url}/app.git`, authorization: AUTH });
	});
});
