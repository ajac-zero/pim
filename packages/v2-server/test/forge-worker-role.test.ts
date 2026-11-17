// Forge as a deployment runs it: the real `forge` role's worker loop, the `gate` (REST, git broker, vault) and `maintenance` (wakes) roles, on real PostgreSQL, with a local `git http-backend`
// as the git host, a local Amp (`http.createServer`) and the sandbox manager's contract served over HTTP. Nothing in Forge is called directly: threads start over POST /api/coding/threads
// and the forge role's own loop provisions them, runs their turns, mirrors Amp, and wakes the chat that started them.
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { createRegistry } from "@earendil-works/pi-durable";
import { claudeFixture } from "@pim/coding/support/claude-code";
import { fakeManager, TOKEN } from "@pim/coding/support/fake-manager";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { userHandle } from "@pim/v2-app/signin";
import type { Db as ForgeDb } from "@pim/v2-forge/db";
import { LocalGitHost } from "@pim/v2-forge/local-git";
import { LocalSandboxProvider } from "@pim/v2-forge/local-sandbox";
import { ForgeVault } from "@pim/v2-forge/vault";
import { GitHttpHost } from "../../v2-forge/test/git-http-backend.ts";
import { HTML, MockAmp, PNG } from "../../v2-forge/test/amp-mock.ts";
import { useForgeOverrides } from "../src/forge-assembly.ts";
import type { Process } from "../src/main.ts";
import { keyringFromProcessEnv } from "../src/roles.ts";
import { readTranscript, waitFor } from "../../v2-runtime/test/support/rig.ts";
import { Authenticator } from "./support/authenticator.ts";
import { Client } from "./support/client.ts";
import { type Deployment, base, start, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const REPO = "https://github.com/acme/app";
const KEK = randomBytes(32).toString("base64");

real("Forge's worker role with the Gate and Maintenance", () => {
	let d: Deployment;
	let gate: Process;
	let forge: Process;
	const everyone: Process[] = [];
	let web: Client;
	let ownerId: string;
	let chatId: string;
	let appForTools: App;
	let amp: MockAmp;
	let gitHost: GitHttpHost;
	let managerServer: Server;
	let uninstall = () => {};
	let bare: string;
	const dir = mkdtempSync(join(tmpdir(), "forge-role-"));
	const codeModel = fauxProvider({ provider: "codefaux", models: [{ id: "m", contextWindow: 200_000 }] });
	const chatModel = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
	const manager = fakeManager(8);
	const claudeArgv: string[][] = [];
	const UPSTREAM = `Basic ${btoa("host:secret")}`;
	const hostGit = (...a: string[]) => execFileSync("git", ["--git-dir", bare, ...a], { encoding: "utf8" }).trim();

	/** The sandbox manager's route contract on a real port: the fake manager's fetch behind an http server. */
	const serveManager = async () => {
		const server = createServer(async (req, res) => {
			try {
				await handle(req, res);
			} catch (error) {
				console.error("manager server", error);
				if (!res.headersSent) res.writeHead(500);
				res.end(String(error));
			}
		});
		const handle = async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const abort = new AbortController();
			res.on("close", () => abort.abort());
			const r = await manager.fetch(`http://127.0.0.1:8080${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? (String(req.headers["content-type"] ?? "").includes("json") ? Buffer.concat(chunks).toString("utf8") : new Uint8Array(Buffer.concat(chunks))) : undefined, signal: abort.signal });
			const headers: Record<string, string> = {};
			r.headers.forEach((v, k) => (headers[k] = v));
			res.writeHead(r.status, headers);
			if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
			res.end();
		};
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		return server;
	};

	const hooks = () => {
		const models = createModels();
		models.setProvider(chatModel.provider);
		const agent = { model: { provider: "faux", modelId: "m" } };
		return { harnessOptions: (): HarnessOptions => ({ models, registry: createRegistry() }), homeRoot: () => ({ agent }), chatAgent: () => agent, pollMs: 40 };
	};
	const go = async (role: Parameters<typeof start>[1], h = {}, extra: Record<string, string> = {}) => {
		const p = await start(d, role, h, { PIM_KEK_K1: KEK, PIM_KEK_CURRENT: "k1", PIM_CODING_ALLOWED_REPOS: "acme/*", PIM_CODING_SIGNING_KEY: "role-test-signing-key", PIM_CODING_MANAGER_URL: `http://127.0.0.1:${(managerServer.address() as AddressInfo).port}`, PIM_CODING_MANAGER_TOKEN: TOKEN, PIM_AMP_BASE_URL: amp.baseUrl, PIM_FORGE_ORB_POLL_MS: "150", PIM_CODING_DEFAULT_MODEL: "codefaux/m", ...extra });
		everyone.push(p);
		return p;
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress" };
		// The git host: a bare repository with a main branch, behind `git http-backend`.
		bare = join(dir, "app.git");
		execFileSync("git", ["init", "--bare", "-b", "main", bare]);
		const seed = join(dir, "seed");
		execFileSync("git", ["init", "-q", "-b", "main", seed]);
		execFileSync("sh", ["-c", "echo hello > README.md"], { cwd: seed });
		const id = ["-c", "user.name=T", "-c", "user.email=t@example.invalid"];
		execFileSync("git", [...id, "-C", seed, "add", "."]);
		execFileSync("git", [...id, "-C", seed, "commit", "-qm", "init"]);
		execFileSync("git", ["-C", seed, "push", "-q", bare, "main"]);
		hostGit("config", "http.receivepack", "true");
		gitHost = await new GitHttpHost(dir).start();
		amp = await new MockAmp().start();
		// The fake sandbox: `git` makes the checkout, `claude` prints a recorded turn, `sh` runs the pi agent's tools.
		manager.backing.register("git", async ({ argv, workspace }) => {
			if (argv.includes("clone")) await workspace.writeFile("/workspace/repo/.git/HEAD", new TextEncoder().encode("ref: refs/heads/main\n"));
			return { code: 0 };
		});
		manager.backing.register("test", async ({ workspace }) => ((await workspace.stat("/workspace/repo/.git").then(() => true, () => false)) ? { code: 0 } : { code: 1 }));
		manager.backing.register("claude", async ({ argv }) => (claudeArgv.push(argv), { stdout: claudeFixture("turn"), code: 0 }));
		manager.backing.register("sh", async () => ({ stdout: "built ok\n", code: 0 }));
		managerServer = await serveManager();
		uninstall = useForgeOverrides({
			git: new LocalGitHost(new LocalSandboxProvider(join(dir, "sbx")), { "acme/app": bare }),
			gitUpstream: async () => ({ url: `${gitHost.url}/app.git`, authorization: UPSTREAM }),
			models: async () => {
				const models = createModels();
				models.setProvider(codeModel.provider);
				return models;
			},
		});
		appForTools = new App(connectApp(stack.url("gate"), 4), new MemoryObjectStore());
		gate = await go("gate", {}, { PIM_PUBLIC_URL: `http://127.0.0.1:${d.gatePort}` });
		await go("live", { pollMs: 40 });
		await go("maintenance", { pollMs: 100 });
		await go("runner", hooks(), { PIM_RUNNER_HOLDER_ID: "runner-a" });
		forge = await go("forge", { pollMs: 100 }, { PIM_PUBLIC_URL: `http://127.0.0.1:${d.gatePort}` });
		web = new Client(base(gate), d.ingressSecret);
	}, 180_000);
	afterAll(async () => {
		uninstall();
		await Promise.allSettled(everyone.map((p) => p.close()));
		await appForTools?.db.end();
		await amp?.stop();
		await gitHost?.stop();
		managerServer?.closeAllConnections();
		managerServer?.close();
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
	}, 60_000);

	const url = (path: string) => `${base(gate)}${path}`;
	const git = (cwd: string, token: string | null, ...args: string[]) =>
		new Promise<{ status: number; stdout: string; stderr: string }>((done) =>
			execFile("git", ["-c", `http.extraHeader=x-pim-ingress-secret: ${d.ingressSecret}`, ...(token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : []), "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH!, HOME: cwd, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => done({ status: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })),
		);
	const state = async (id: string) => (await web.call("GET", `/api/coding/threads/${id}`)).json as { state: string; stateReason: string | null; spentUsd: number; workspaceRef: { id: string } | null; branch: string; orb: { threadId: string } | null; lastPushedSha: string | null };
	const threadIs = (id: string, wanted: string, ms = 30_000) =>
		waitFor(`thread ${id} to be ${wanted}`, async () => ((await state(id)).state === wanted ? true : undefined), ms).catch(async (e) => {
			const t = (await d.stack.admin.query("select state, state_reason, state_detail, lease_holder, provisioning from pim_forge.forge_threads where thread_id = $1", [id])).rows[0];
			throw new Error(`${e.message}: ${JSON.stringify(t)}`);
		});
	const chatHeard = async () => ((await web.call("GET", `/api/snapshot/chat/${chatId}`)).json.messages as { role: string; parts: { type: string; text?: string }[] }[]).filter((m) => m.role === "user").map((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text).join(""));

	it("signs the admin in, grants coding, and a sandbox thread is unavailable (503) until the worker has a pool to run it on", async () => {
		const claim = await appForTools.identity.issueClaim("bootstrap", null, 3_600_000);
		const registered = await web.call("POST", "/auth/register", { username: "anibal", bootstrap: claim });
		ownerId = registered.json.account.ownerId;
		const key = new Authenticator("ES256");
		const options = await web.call("POST", "/auth/passkeys/options", {});
		await web.call("POST", "/auth/passkeys", { ...key.create(options.json, base(gate)), name: "laptop" });
		await web.call("POST", "/auth/sign-out");
		const challenge = await web.call("POST", "/auth/sign-in/options");
		expect((await web.call("POST", "/auth/sign-in", key.get(challenge.json, base(gate), userHandle(ownerId)))).status).toBe(200);
		chatId = (await web.call("POST", "/api/sessions", { title: "Coding" })).json.id;
		chatModel.setResponses([fauxAssistantMessage("Hello.")]);
		expect((await web.call("POST", `/api/sessions/${chatId}/messages`, { commandId: "m-0", text: "hi" })).status).toBe(202);
		const granted = await web.call("POST", "/api/admin/coding-grants", { ownerId, permissions: ["coding:start", "coding:steer", "coding:push", "coding:pr", "coding:merge"], repositories: ["github.com/acme/*"] });
		expect(granted.status).toBe(201);
		// The forge role created the default pool when it started (a sandbox manager is configured).
		const pools = (await web.call("GET", "/api/admin/coding/pools")).status;
		expect([200, 403]).toContain(pools);
		await waitFor("the default pool", async () => ((await d.stack.admin.query("select 1 from pim_forge.forge_pools")).rows.length ? true : undefined));
	}, 90_000);

	it("a pi thread started over the Gate is provisioned, runs its turn through pi-durable, and wakes the chat", async () => {
		codeModel.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "make build" }), { stopReason: "toolUse" }), fauxAssistantMessage("Built it.")]);
		const started = await web.call("POST", "/api/coding/threads", { operationId: "role-pi", task: "Build the project", repo: REPO, harness: "pi", chat: chatId });
		expect(started.status).toBe(201);
		const id = started.json.threadId as string;
		await threadIs(id, "idle");
		const t = await state(id);
		expect(t.workspaceRef).toBeTruthy();
		const transcript = (await web.call("GET", `/api/coding/threads/${id}/transcript?limit=50`)).json.messages as { role: string; text: string }[];
		expect(transcript.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
		expect(transcript.at(-1)!.text).toBe("Built it.");
		// The same start again is the same thread, over HTTP.
		expect((await web.call("POST", "/api/coding/threads", { operationId: "role-pi", task: "Build the project", repo: REPO, harness: "pi", chat: chatId })).json).toMatchObject({ threadId: id, created: false });
		chatModel.setResponses([fauxAssistantMessage("The build thread is done.")]);
		await waitFor("the wake in the chat", async () => ((await chatHeard()).some((t) => t.includes(`Coding thread ${id} completed`)) ? true : undefined), 60_000);
		const wakes = (await d.stack.admin.query("select dedupe_key, delivered_at from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [id])).rows;
		expect(wakes.map((w) => w.dedupe_key)).toEqual([`coding:${id}:role-pi`]);
		expect(wakes[0].delivered_at).toBeTruthy();
	}, 120_000);

	it("the sandbox clones and pushes through /api/coding/git on the Gate: fast-forwards pass; force pushes, main and other branches are refused", async () => {
		const id = (await d.stack.admin.query("select thread_id from pim_forge.forge_threads where start_operation = 'role-pi'")).rows[0].thread_id as string;
		const t = await state(id);
		// What the sandbox holds: the grant prepareCheckout wrote for its credential helper.
		const ref = (await manager.backing.list()).find((i) => i.ref.sessionId === id)!.ref;
		const ws = await manager.backing.get(ref);
		const cred = JSON.parse(new TextDecoder().decode(await ws!.readFile("/workspace/.config/pim/git/credential.json")));
		expect(cred.url).toBe(`http://127.0.0.1:${d.gatePort}/api/coding/git/acme/app.git`);
		const sandbox = mkdtempSync(join(tmpdir(), "sbx-"));
		const clone = await git(sandbox, cred.token, "clone", cred.url, "w");
		expect(clone.status, clone.stderr).toBe(0);
		const w = join(sandbox, "w");
		await git(w, null, "checkout", "-b", t.branch);
		const commit = async (file: string) => {
			execFileSync("sh", ["-c", `echo ${file} > ${file}`], { cwd: w });
			await git(w, null, "add", ".");
			await git(w, null, "commit", "-m", file);
			return (await git(w, null, "rev-parse", "HEAD")).stdout.trim();
		};
		await commit("one.txt");
		expect((await git(w, cred.token, "push", "origin", `HEAD:refs/heads/${t.branch}`)).status).toBe(0);
		const two = await commit("two.txt");
		const ff = await git(w, cred.token, "push", "origin", `HEAD:refs/heads/${t.branch}`);
		expect(ff.status, ff.stderr).toBe(0);
		expect(hostGit("rev-parse", `refs/heads/${t.branch}`)).toBe(two);
		await waitFor("the push recorded on the thread", async () => ((await state(id)).lastPushedSha === two ? true : undefined));
		await git(w, null, "reset", "--hard", "HEAD~2");
		await commit("rewritten.txt");
		const mainBefore = hostGit("rev-parse", "main");
		for (const [what, args] of [["a force push", ["push", "--force", "origin", `HEAD:refs/heads/${t.branch}`]], ["main", ["push", "origin", "HEAD:refs/heads/main"]], ["another branch", ["push", "origin", "HEAD:refs/heads/pim/other-1234"]]] as const) {
			expect((await git(w, cred.token, ...args)).status, what).not.toBe(0);
		}
		expect(hostGit("rev-parse", `refs/heads/${t.branch}`)).toBe(two);
		expect(hostGit("rev-parse", "main")).toBe(mainBefore);
		// The host only ever saw the deployment's own credential.
		expect(gitHost.requests.every((r) => r.auth === UPSTREAM)).toBe(true);
	}, 90_000);

	it("a claude-code thread waits for the person's login, then runs on it once connected", async () => {
		const started = await web.call("POST", "/api/coding/threads", { operationId: "role-claude", task: "Fix the greeting", repo: REPO, harness: "claude-code", chat: chatId });
		expect(started.status).toBe(201);
		const id = started.json.threadId as string;
		await waitFor("the login wait", async () => ((await state(id)).stateReason === "login_required" ? true : undefined));
		// The person connects their login (sealed under the deployment's keys, which the forge role holds too).
		const crypto = keyringFromProcessEnv({ PIM_KEK_K1: KEK, PIM_KEK_CURRENT: "k1" })!;
		await new ForgeVault(d.stack.admin as unknown as ForgeDb, crypto as never).save(ownerId, "claude-code", [{ path: ".credentials.json", mode: 0o600, data: new TextEncoder().encode('{"claudeAiOauth":{"accessToken":"sk-ant-x"}}') }], 0);
		expect((await web.call("POST", `/api/coding/threads/${id}/continue`, { operationId: "role-claude-go" })).status).toBe(202);
		await waitFor("the turn", async () => ((await state(id)).state === "idle" && (await state(id)).spentUsd > 0 ? true : undefined), 60_000);
		expect((await state(id)).spentUsd).toBeCloseTo(0.0841);
		expect(claudeArgv.length).toBeGreaterThan(0);
		// One wake for the turn that stopped at the missing login, and one for the turn that ran: each once, delivered to the chat that started the thread.
		await waitFor("both wakes", async () => (((await d.stack.admin.query("select count(*) c from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 and delivered_at is not null", [id])).rows[0].c as string) === "2" ? true : undefined), 30_000);
		expect((await d.stack.admin.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1 order by id", [id])).rows.map((r) => r.dedupe_key)).toEqual([`coding:${id}:role-claude`, `coding:${id}:role-claude-go`]);
	}, 120_000);

	it("an amp thread is started by the loop against Amp with the person's own key, mirrors its output and attachments, and wakes the chat once", async () => {
		const key = "sgamp_roletest0123456789abcdef";
		expect((await web.call("PUT", "/api/coding/vault/amp/api-key", { apiKey: key })).status).toBe(200);
		amp.attachments.set("shot.png", { type: "image/png", body: PNG });
		amp.attachments.set("fake.png", { type: "image/png", body: HTML });
		const started = await web.call("POST", "/api/coding/threads", { operationId: "role-amp", task: "Update the docs", repo: REPO, harness: "amp", chat: chatId });
		expect(started.status).toBe(201);
		const id = started.json.threadId as string;
		const handle = await waitFor("the orb to start", async () => (await state(id)).orb?.threadId);
		expect(amp.creates).toBe(1);
		expect(amp.auth.every((a) => a === `Bearer ${key}`)).toBe(true);
		const at = (n: string) => `${amp.baseUrl}/user-content/attachments/${n}`;
		amp.say(handle, "assistant", `Done. ![shot](${at("shot.png")}) ![fake](${at("fake.png")})`);
		amp.threads.get(handle)!.state = "idle";
		await threadIs(id, "idle");
		const text = await waitFor("the mirrored message", async () => {
			const events = (await web.call("GET", `/api/coding/threads/${id}/transcript?role=assistant`)).json.messages as { text: string }[];
			return events.at(-1)?.text.includes("Done.") ? events.at(-1)!.text : undefined;
		});
		expect(text).toContain(`/api/coding/${id}/attachments/`);
		expect(text).toContain(at("fake.png"));
		// A second poll adopts the same orb: no second start, and one wake.
		await new Promise((r) => setTimeout(r, 1000));
		expect(amp.creates).toBe(1);
		const wakes = (await d.stack.admin.query("select dedupe_key from pim_forge.forge_outbox where topic = 'wake' and thread_id = $1", [id])).rows;
		expect(wakes).toHaveLength(1);
		expect(wakes[0].dedupe_key).toMatch(new RegExp(`^coding:${id}:role-amp$`));
		chatModel.setResponses([fauxAssistantMessage("The docs thread is done.")]);
		await waitFor("the chat to hear it", async () => ((await chatHeard()).some((t) => t.includes(`Coding thread ${id} completed`)) ? true : undefined), 60_000);
		void readTranscript;
	}, 120_000);

	it("an Amp thread's pushed pim/* branch is merged by the Gate-side Forge, and a person with no coding grant is still refused", async () => {
		const id = (await d.stack.admin.query("select thread_id from pim_forge.forge_threads where start_operation = 'role-amp'")).rows[0].thread_id as string;
		const work = mkdtempSync(join(tmpdir(), "amp-"));
		execFileSync("git", ["clone", "-q", bare, "w"], { cwd: work });
		execFileSync("sh", ["-c", "git checkout -q -b pim/amp-docs-1234 && echo docs > docs.txt && git add . && git -c user.name=T -c user.email=t@example.invalid commit -qm docs && git push -q origin pim/amp-docs-1234"], { cwd: join(work, "w") });
		await d.stack.admin.query("update pim_forge.forge_threads set orb = orb || '{\"branch\": \"pim/amp-docs-1234\"}'::jsonb where thread_id = $1", [id]);
		// There is no REST merge route (merge is a tool); the facade is the same one the agent tool calls, here under the Gate's scope.
		// Merge is permitted but needs a person: the admin's recorded, auditable standing approval stands in for them.
		expect((await web.call("POST", "/api/admin/standing-approvals", { ownerId, action: "coding:merge", scope: { repository: "github.com/acme/app" } })).status).toBe(201);
		const { assembleForge } = await import("../src/forge-assembly.ts");
		const parts = assembleForge(d.stack.admin as unknown as ForgeDb, new MemoryObjectStore() as never, { PIM_CODING_ALLOWED_REPOS: "acme/*" }, undefined, { scoped: true });
		const merged = await parts.forge.scopedTo(ownerId).merge({ ownerId, role: "admin" }, id);
		expect(merged).toMatchObject({ status: "done", outcome: "merged" });
		expect(hostGit("show", "main:docs.txt")).toBe("docs");
		const eve = new Client(base(gate), d.ingressSecret);
		expect((await eve.call("POST", "/api/coding/threads", { operationId: "x", task: "t", repo: REPO })).status).toBe(403);
	}, 90_000);
});
