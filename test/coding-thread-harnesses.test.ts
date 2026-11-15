import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { codingScheduler } from "../src/coding/scheduler-do";
import { CONTINUE_TEXT, codingThread, LOST_RESUME_TEXT, type StartThread } from "../src/coding/thread-do";
import { REPO_DIR } from "../src/coding/tools";
import { codingVault } from "../src/coding/vault/vault";
import { ComposeWorkspaceProvider } from "../src/coding/workspace/compose";
import { type FakeCommandHandler, type FakeCommandResult } from "../src/coding/workspace/fake";
import { workspaceRegistry } from "../src/coding/workspace/registry";
import { fakeGit, fakeRemotes } from "./fake-git";
import { fakeManager, json, TOKEN, URL_BASE } from "./fake-manager";
import { CLAUDE_SESSION, claudeFixture, claudeLines } from "./fixtures/claude-code";
import { CODEX_SESSION, codexFixture, codexLines } from "./fixtures/codex";
import { VIBE_META, VIBE_SESSION, vibeExport, vibeOutput } from "./fixtures/vibe";
import { api, OWNER } from "./helpers";
import { type CodingThreadDO, codingBackends, codingEvents, codingThreadClock, codingTimings, codingWorkspaces } from "./worker";
import { REPO, type Stub, startInput, turns, inside, everything, workspaceOf, sql, sent , capped } from "./coding-thread-support";

describe("a Claude Code thread", () => {
	// The thread runs `claude` in its in-memory workspace, where it is a script that prints the stream-json of
	// test/fixtures/claude-code/, and `pkill` tells the script the signal it was sent. Its person is the file's account,
	// `OWNER`, whose space keeps their Claude Code login in the coding vault for real.
	type Run = { argv: string[]; env: Record<string, string>; cwd: string; login: string };
	const runs: Run[] = [];
	const signals: string[][] = [];
	const waiting: { signal: string; resolve: () => void }[] = [];
	/** What `claude` does this time, after it is recorded in `runs`. */
	let claude: (context: Parameters<FakeCommandHandler>[0]) => Promise<FakeCommandResult> = async () => ({ stdout: claudeFixture("turn") });
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const LOGIN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-original-login","refreshToken":"sk-ant-ort01-original"}}';
	const REFRESHED = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-refreshed-login","refreshToken":"sk-ant-ort01-refreshed"}}';
	const CREDENTIALS = "/workspace/.claude/.credentials.json";
	const started: Stub[] = [];

	const claudeCommand: FakeCommandHandler = async (context) => {
		const login = await context.workspace.readFile(`${context.env.CLAUDE_CONFIG_DIR}/.credentials.json`).then(
			(data) => decoder.decode(data),
			() => "",
		);
		runs.push({ argv: context.argv, env: context.env, cwd: context.cwd, login });
		return claude(context);
	};
	const pkillCommand: FakeCommandHandler = ({ argv }) => {
		signals.push(argv.slice(1));
		for (const waiter of waiting.splice(0).filter((each) => each.signal === argv[1] || (waiting.push(each), false))) waiter.resolve();
		return {};
	};
	// A repository's setup script, which a test of the thread's environment has run: it installs by writing node_modules.
	codingWorkspaces.register("bash", async ({ cwd, workspace }) => {
		await workspace.writeFile(`${cwd}/node_modules/.modules.yaml`, encoder.encode("installed\n"));
		return { stdout: "Done in 8s\n" };
	});
	codingWorkspaces.register("claude", claudeCommand);
	codingWorkspaces.register("pkill", pkillCommand);

	/** Resolves when `pkill` sends `signal`, or the command is killed. */
	const until = (signal: string, killed: Promise<void>) => Promise.race([new Promise<void>((resolve) => waiting.push({ signal, resolve })), killed]);

	/** The person's login, as Claude Code's own sign-in would have left it, in the vault. */
	async function signIn(login = LOGIN) {
		const vault = codingVault(env);
		const { version } = await vault.load(OWNER, "claude-code");
		await vault.save(OWNER, "claude-code", [{ path: ".credentials.json", mode: 0o600, data: encoder.encode(login) }], version);
	}

	const storedLogin = async () => {
		const files = (await codingVault(env).load(OWNER, "claude-code")).files;
		return files ? decoder.decode(files.find((file) => file.path === ".credentials.json")!.data) : null;
	};

	/** Starts a Claude Code thread in `OWNER`'s space, entered in its list as the API enters it. */
	async function startClaude(overrides: Partial<StartThread> = {}) {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "claude-code", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "claude-code", task: "Fix the greeting test", ...overrides }));
		return { id, stub };
	}

	const running = (count: number) => vi.waitFor(() => expect(runs).toHaveLength(count), { timeout: 10_000, interval: 20 });

	beforeEach(async () => {
		runs.length = 0;
		signals.length = 0;
		waiting.length = 0;
		claude = async () => ({ stdout: claudeFixture("turn") });
		await signIn();
	});

	afterEach(async () => {
		// Its slots and the person's lock are free for the next test.
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
	});

	it("readies its environment before the person's login goes in, so the snapshot holds none of it", async () => {
		const name = `Env-${crypto.randomUUID().slice(0, 8)}`;
		fakeRemotes.set(`https://pim.test/api/coding/git/Acme/${name}.git`, { "README.md": "# Env\n", ".pim/setup.sh": "pnpm install\n", "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" });
		const { id, stub } = await startClaude({ repo: `https://github.com/Acme/${name}` });
		await turns(id, 1);
		expect((await stub.status()).environment).toMatchObject({ state: "cached" });
		// The CLI ran signed in, after the snapshot was kept without the login in it.
		expect(runs[0]).toMatchObject({ login: LOGIN });
		const saved = [...codingWorkspaces.environments.values()].find((each) => each.userId === OWNER && each.repo === `acme/${name.toLowerCase()}`)!;
		expect(saved.nodes.has(`${REPO_DIR}/node_modules/.modules.yaml`)).toBe(true);
		expect([...saved.nodes.keys()].filter((path) => path.startsWith("/workspace/.claude"))).toEqual([]);
		expect(JSON.stringify([...saved.nodes.values()].map((node) => ("data" in node ? decoder.decode(node.data) : "")))).not.toContain("sk-ant-");
	});

	it("runs a turn with the person's login, and keeps its transcript, cost, tests, checkpoint and refreshed login, then resumes it", async () => {
		claude = async ({ workspace }) => {
			await workspace.writeFile(`${REPO_DIR}/greet.ts`, encoder.encode("export const greet = (name: string) => `Hello, ${name}`;\n"));
			// The CLI refreshed its token, as it does.
			await workspace.writeFile(CREDENTIALS, encoder.encode(REFRESHED), 0o600);
			return { stdout: claudeFixture("turn") };
		};
		const { id, stub } = await startClaude();
		const [ended] = await turns(id, 1);
		const status = await stub.status();
		expect(ended).toMatchObject({ outcome: "completed", checkpoint: status.checkpoint!.sha, said: "Fixed `greet` to include the name; the greeting test passes now." });
		expect(status).toMatchObject({ state: "idle", harness: "claude-code", profile: { providerId: "claude-code", model: "default" }, resolvedProfile: { provider: "claude-code", model: "claude-sonnet-5", source: "harness default" }, currentOperation: null });
		// The CLI ran in the checkout, signed in with the person's login, a new session, and no telemetry.
		const [first] = runs;
		expect(first).toMatchObject({ cwd: REPO_DIR, login: LOGIN, env: { HOME: "/workspace", CLAUDE_CONFIG_DIR: "/workspace/.claude", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } });
		const sessionId = first!.argv[first!.argv.indexOf("--session-id") + 1]!;
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(first!.argv.slice(-2)).toEqual(["--", "Fix the greeting test"]);
		// A thread has no budget unless one is given, so the CLI is given no ceiling either.
		expect(first!.argv).not.toContain("--max-budget-usd");
		expect(first!.argv[first!.argv.indexOf("--append-system-prompt") + 1]).toContain(`on the branch ${status.repo.branch}`);
		// Its workspace may reach Anthropic, besides the broker and the registries.
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["api.anthropic.com", "claude.ai", "platform.claude.com", "registry.npmjs.org"]));
		// The refreshed login is kept, and none is left in the workspace or anywhere in the thread's tables.
		expect(await storedLogin()).toBe(REFRESHED);
		await expect((await workspaceOf(id)).readFile(CREDENTIALS)).rejects.toThrow();
		expect(await everything(stub)).not.toContain("sk-ant-");
		// The transcript, as the web app shows it: the task, the agent's text, its tools with their results.
		const transcript = (await inside(stub, (thread) => thread.transcript())).filter((message) => message.role !== "notice");
		expect(transcript.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant", "tool", "assistant", "tool", "assistant", "tool", "assistant"]);
		expect(transcript.find((message) => message.role === "user")!.parts).toEqual([{ type: "text", text: "Fix the greeting test" }]);
		expect(transcript[3]!.parts).toEqual([{ type: "tool-call", id: "toolu_01Bash", name: "Bash", arguments: { command: "npm test", description: "Run the tests" } }]);
		expect(transcript[4]!.parts[0]).toMatchObject({ type: "tool-result", id: "toolu_01Bash", name: "Bash", error: true });
		// What it cost as the CLI estimated it, its test run, its retry and refusal, and its checkpoint's diff.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "claude-code", model: "claude-sonnet-5", costUsd: 0.0841, input: 2569, output: 396 })]);
		expect(status.spentUsd).toBeCloseTo(0.0841, 10);
		expect(log.find((event) => event.kind === "harness.api_retry")?.data).toMatchObject({ attempt: 1, error: "overloaded", status: 529 });
		expect(log.find((event) => event.kind === "harness.permission_denied")?.data).toMatchObject({ tool: "WebFetch" });
		expect(await stub.tests()).toEqual([expect.objectContaining({ command: "npm test", exitCode: 1, summary: { format: "vitest", passed: 3, failed: 1, skipped: 0, total: 4 } })]);
		expect((await stub.diff()).diff).toContain("+++ b/greet.ts");

		// A steer is the next turn, which resumes the CLI's session; its cost is what the session's whole cost grew by.
		const turn = claudeLines("turn");
		claude = async () => ({ stdout: [turn[0], turn.at(-2), turn.at(-1)!.replace('"total_cost_usd": 0.0841', '"total_cost_usd": 0.1341')].join("\n") });
		await stub.steer("Also add a test for an empty name", { operationId: "steer-1" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "steer-1" });
		expect(runs[1]!.argv[runs[1]!.argv.indexOf("--resume") + 1]).toBe(CLAUDE_SESSION);
		expect(runs[1]!.argv).not.toContain("--session-id");
		expect(runs[1]!.login).toBe(REFRESHED);
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls[1]!.costUsd).toBeCloseTo(0.05, 10);
		expect((await stub.status()).spentUsd).toBeCloseTo(0.1341, 10);
	});

	it("stops on abort with SIGINT, ending the turn cancelled, and keeps the login", async () => {
		claude = async ({ killed }) => {
			await until("-INT", killed);
			return { stdout: `${claudeLines("turn")[0]}\n{"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"${CLAUDE_SESSION}","total_cost_usd":0.01,"errors":["Interrupted"]}\n`, code: 130 };
		};
		const { id, stub } = await startClaude();
		await running(1);
		await stub.abort();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null });
		const sessionId = runs[0]!.argv[runs[0]!.argv.indexOf("--session-id") + 1];
		expect(signals).toEqual([["-INT", "-f", sessionId]]);
		expect(await storedLogin()).toBe(LOGIN);
		await expect((await workspaceOf(id)).readFile(CREDENTIALS)).rejects.toThrow();
	});

	it("fails a turn that runs out of time, killing a CLI that ignores SIGINT after the grace", async () => {
		claude = async ({ killed }) => {
			await until("-KILL", killed);
			return {};
		};
		const { id, stub } = await startClaude({ limits: { wallClockMin: 0.005 } });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "error", reason: "timeout", state: "failed" });
		expect((await stub.status()).stateDetail).toContain("ran out of time");
		await vi.waitFor(() => expect(signals.map((each) => each[0])).toEqual(["-INT", "-KILL"]));
	});

	it("stops a turn that prints nothing as stalled, then continues it once by itself, resuming the session, and leaves it failed if that stalls too", async () => {
		claude = async ({ killed }) => {
			await until("-INT", killed);
			return { stdout: `${claudeLines("turn")[0]}\n`, code: 130 };
		};
		const { id, stub } = await startClaude();
		const [first, second] = await turns(id, 2);
		expect(first).toMatchObject({ outcome: "error", reason: "stalled", state: "failed" });
		expect(second).toMatchObject({ outcome: "error", reason: "stalled", state: "failed" });
		expect(second!.operationId).toMatch(/^auto-continue:/);
		// Once: the continuation resumed the CLI's session, and its own stall is not continued again.
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(runs).toHaveLength(2);
		expect(runs[1]!.argv[runs[1]!.argv.indexOf("--resume") + 1]).toBe(CLAUDE_SESSION);
		expect(await stub.status()).toMatchObject({ state: "failed", stateReason: "stalled" });
	});

	it("ends the CLI of a turn whose session is about to end, runs it again resuming its session in the new workspace, and doesn't if the person stopped it", async () => {
		// A provider with a one-minute session cap, whose workspaces run `claude` and `pkill` as the default ones do.
		const { provider, t0 } = capped();
		provider.register("claude", claudeCommand);
		provider.register("pkill", pkillCommand);
		const sessions: number[] = [];
		claude = async ({ killed, workspace }) => {
			sessions.push((workspace as unknown as { startedAt: number }).startedAt);
			await until("-INT", killed);
			return { stdout: `${claudeLines("turn")[0]}\n`, code: 130 };
		};
		const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		const { id, stub } = await startClaude();
		await running(1);
		await vi.waitFor(async () => expect(await sql(stub, "SELECT record FROM coding_harness_run")).toHaveLength(1), { timeout: 15_000, interval: 50 });
		expect((await stub.status()).session).toMatchObject({ startedAt: t0, continuations: 0 });
		codingThreadClock.now = t0 + 50_000;
		await heartbeat(stub);
		// The CLI got its interrupt, and ran again in a session that began after the move, resuming its own.
		await running(2);
		expect(signals.map((each) => each[0])).toEqual(["-INT"]);
		expect(runs[1]!.argv[runs[1]!.argv.indexOf("--resume") + 1]).toBe(CLAUDE_SESSION);
		expect(runs[1]!.argv).toContain("-p");
		await vi.waitFor(() => expect(sessions).toEqual([t0, t0 + 50_000]), { timeout: 15_000, interval: 50 });
		await vi.waitFor(async () => expect((await stub.status()).session).toMatchObject({ state: "active", continuations: 1, last: { mode: "turn_restarted" } }), { timeout: 15_000, interval: 50 });
		expect(await stub.status()).toMatchObject({ state: "running", consecutiveInterrupts: 0 });
		// The person stops the second run: nothing runs it a third time.
		await stub.abort();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		await new Promise((resolve) => setTimeout(resolve, 600));
		expect(runs).toHaveLength(2);
		expect(await stub.status()).toMatchObject({ state: "idle", currentOperation: null, inbox: 0 });
	});

	it("goes on after a stall when the continuation finishes", async () => {
		let attempt = 0;
		claude = async ({ killed }) => {
			if (attempt++ === 0) {
				await until("-INT", killed);
				return { stdout: `${claudeLines("turn")[0]}\n`, code: 130 };
			}
			return { stdout: claudeFixture("turn") };
		};
		const { id, stub } = await startClaude();
		const [first, second] = await turns(id, 2);
		expect(first).toMatchObject({ reason: "stalled" });
		expect(second).toMatchObject({ outcome: "completed", state: "idle" });
	});

	it("ends a turn its object's reset cut off as interrupted, auto-resumes, and finishes the run off", async () => {
		let first = true;
		claude = async ({ killed }) => {
			if (!first) return { stdout: claudeFixture("turn") };
			first = false;
			await until("-KILL", killed);
			return {};
		};
		const { id, stub } = await startClaude();
		await running(1);
		await vi.waitFor(async () => expect(await sql(stub, "SELECT record FROM coding_harness_run")).toHaveLength(1), { timeout: 15_000, interval: 50 });
		await runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.abort("evicted")).catch(() => {});
		// Auto-resume should happen - no turn_ended event is emitted to supervisor
		// The turn continues with a new CLI run
		const after = codingThread(env, id);
		// Wait for the auto-resume to complete
		const ended = await turns(id, 1, true);
		// The first (and only) turn_ended event should be the completed turn after auto-resume
		expect(ended).toHaveLength(1);
		expect(ended[0]).toMatchObject({ outcome: "completed" });
		// The CLI was killed, the login written back and taken out of the workspace, and the person's lock let go.
		expect(signals.map((each) => each[0])).toContain("-KILL");
		expect(await sql(after, "SELECT record FROM coding_harness_run")).toEqual([]);
		expect(await storedLogin()).toBe(LOGIN);
		const scheduler = codingScheduler(env, OWNER);
		expect(await scheduler.acquireHarness("claude-code", "probe", 1000)).toBe(true);
		await scheduler.releaseHarness("claude-code", "probe");
		started.splice(started.indexOf(stub), 1, after);
		// The resumed turn completed normally, so the counter is back to 0, and the log keeps the resume.
		const status = await after.status();
		expect(status).toMatchObject({ consecutiveInterrupts: 0 });
		const log = await after.log();
		expect(log.some((event) => event.kind === "thread.resumed")).toBe(true);
	});

	describe("on the Compose sandbox manager, when its workspace goes down", () => {
		// The thread's workspaces are the stubbed manager's (test/fake-manager.ts), which a test makes go down: a container
		// that dies under a turn, a host that comes back with or without the workspace's volume, a manager that restarts.
		/** The Compose provider on a stubbed manager whose workspaces run the fake git and `claude`. */
		function compose() {
			const manager = fakeManager();
			manager.backing.register("git", fakeGit);
			manager.backing.register("claude", claudeCommand);
			manager.backing.register("pkill", pkillCommand);
			codingBackends.registry = workspaceRegistry([new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: manager.fetch, sleep: async () => {} })]);
			const creates = () => manager.requests.filter((request) => request.method === "POST" && request.path === "/sessions").length;
			const deletes = () => manager.requests.filter((request) => request.method === "DELETE" && /^\/sessions\/[^/?]+(\?|$)/.test(request.path)).map((request) => request.path);
			return { manager, creates, deletes };
		}

		const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		/** Runs `what` in the thread's object, as what a workspace does reaches the thread from its own requests: a stream the object reads may only be moved on from there. */
		const within = (stub: Stub, what: () => unknown) => inside(stub, async () => void (await what()));
		const kinds = async (stub: Stub) => (await stub.log()).map((event) => event.kind);
		const SESSION_FILE = `/workspace/.claude/projects/repo/${CLAUDE_SESSION}.jsonl`;

		/** A run that writes half its work, then works on until `release` is called: when its container dies, or when the test lets it finish with `then`. */
		function halfway(then: () => FakeCommandResult = () => ({})) {
			const run = { release: null as (() => void) | null };
			const command = async ({ cwd, workspace }: Parameters<FakeCommandHandler>[0]) => {
				await workspace.writeFile(`${cwd}/wip.txt`, encoder.encode("half done\n"));
				await new Promise<void>((resolve) => {
					run.release = resolve;
				});
				return then();
			};
			return { run, command, started: () => vi.waitFor(() => expect(run.release).not.toBeNull(), { timeout: 10_000, interval: 20 }) };
		}

		beforeEach(() => {
			// The runs that wait for their container to die print nothing meanwhile.
			codingTimings.stallMs = 60_000;
		});

		afterEach(() => {
			Object.assign(codingTimings, { stallMs: 300, lostGraceMs: 1_000, autosaveMs: 3 * 60_000 });
		});

		it("makes the workspace again from its kept volume when its container dies mid-turn, and resumes the CLI's session there", async () => {
			const { manager, creates, deletes } = compose();
			const cut = halfway();
			let sessionKept: boolean | null = null;
			claude = async (context) => {
				if (runs.length === 1) {
					await context.workspace.writeFile(SESSION_FILE, encoder.encode("{}\n"));
					return { stdout: claudeFixture("turn") };
				}
				if (runs.length === 2) return cut.command(context);
				sessionKept = await context.workspace.stat(SESSION_FILE).then(
					() => true,
					() => false,
				);
				return { stdout: claudeFixture("turn") };
			};
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			await cut.started();
			// The container dies; the manager, which didn't see it go, still lists the session as running.
			await within(stub, () => manager.crash(id));
			await within(stub, cut.run.release!);
			// The cut-off turn went on by itself: the only turn to end after the first is the one it went on with.
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "completed", operationId: "resume-1-steer-1", state: "idle" });
			// It resumed Claude Code's session, whose files were on the kept volume, told why.
			expect(runs).toHaveLength(3);
			expect(runs[2]!.argv).toEqual(expect.arrayContaining(["--resume", CLAUDE_SESSION]));
			expect(runs[2]!.argv.at(-1)).toBe(LOST_RESUME_TEXT);
			expect(sessionKept).toBe(true);
			// The dead session was let go with its volume kept, and made again from it; what the cut-off run wrote is in the checkpoint.
			expect(deletes()).toEqual([`/sessions/${id}?keepVolume=1`]);
			expect(creates()).toBe(2);
			expect((await stub.diff()).diff).toContain("+half done");
			const log = await stub.log();
			expect(log.map((event) => event.kind)).toEqual(expect.arrayContaining(["workspace.lost", "thread.resumed"]));
			expect(log.find((event) => event.kind === "thread.resumed")?.data).toMatchObject({ attempt: 1, reason: "workspace_lost" });
			expect(await stub.status()).toMatchObject({ state: "idle", slot: "held", consecutiveInterrupts: 0 });
		});

		it("fails, telling whoever started it, once its workspace went down more times in a row than it goes on after", async () => {
			const { manager } = compose();
			const cuts: ReturnType<typeof halfway>[] = [];
			claude = async (context) => {
				if (runs.length === 1) return { stdout: claudeFixture("turn") };
				const cut = halfway();
				cuts.push(cut);
				return cut.command(context);
			};
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			for (let attempt = 0; attempt < 4; attempt++) {
				await vi.waitFor(() => expect(cuts).toHaveLength(attempt + 1), { timeout: 10_000, interval: 20 });
				await cuts[attempt]!.started();
				// The first time the manager still lists the dead session; later the host came back, and its manager kept the volume.
				await within(stub, () => manager.crash(id, { restart: attempt > 0 }));
				await within(stub, cuts[attempt]!.run.release!);
			}
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "error", reason: "workspace_lost", state: "failed" });
			const status = await stub.status();
			expect(status).toMatchObject({ state: "failed", stateReason: "workspace_lost", slot: "none", consecutiveInterrupts: 3 });
			expect(status.stateDetail).toContain("went down 4 times in a row");
			expect(ended!.detail).toBe(status.stateDetail);
			expect(runs).toHaveLength(5);
			expect((await stub.log()).filter((event) => event.kind === "thread.resumed")).toHaveLength(3);
		});

		it("tells whoever started it once, with why, when the workspace it makes again keeps going down before a turn starts in it", async () => {
			const { manager, creates } = compose();
			// From now on each workspace the manager makes dies as soon as it is made.
			let doomed = false;
			const doom: typeof fetch = async (input, init) => {
				const res = await manager.fetch(input, init);
				const { pathname } = new URL(String(input));
				if (doomed && pathname === "/sessions" && init?.method === "POST") await manager.crash((JSON.parse(String(init.body)) as { sessionId: string }).sessionId);
				return res;
			};
			codingBackends.registry = workspaceRegistry([new ComposeWorkspaceProvider({ managerUrl: URL_BASE, token: TOKEN, fetch: doom, sleep: async () => {} })]);
			claude = async () => ({ stdout: claudeFixture("turn") });
			const { id, stub } = await startClaude();
			await turns(id, 1);
			doomed = true;
			await within(stub, () => manager.crash(id));
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "error", reason: "workspace_lost", state: "failed" });
			expect(ended!.detail).toContain("went down 4 times in a row");
			expect(ended!.detail).toContain("Last: ");
			// It failed as the workspace was readied, not at a turn's end.
			expect(ended!.operationId).toMatch(/^failed-workspace_lost-/);
			const status = await stub.status();
			expect(status).toMatchObject({ state: "failed", stateReason: "workspace_lost", stateDetail: ended!.detail, slot: "none" });
			expect(creates()).toBe(4);
			// Nothing else ends a turn for it afterwards: one failure, heard of once.
			await new Promise((resolve) => setTimeout(resolve, 500));
			expect(codingEvents.filter((event) => event.threadId === id)).toHaveLength(2);
			expect(await sql(stub, "SELECT * FROM coding_inbox")).toEqual([]);
		});

		it("loses nothing when the manager restarts while the workspace lives on", async () => {
			const { manager, creates, deletes } = compose();
			const cut = halfway(() => ({ stdout: claudeFixture("turn") }));
			claude = async (context) => (runs.length === 1 ? { stdout: claudeFixture("turn") } : cut.command(context));
			const warn = vi.spyOn(console, "warn");
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			await cut.started();
			codingTimings.autosaveMs = 0;
			// For a moment nothing reaches the manager: the autosave the heartbeat starts fails, and waits to see whether the workspace answers again.
			manager.outage.down = true;
			setTimeout(() => {
				manager.outage.down = false;
			}, 300);
			await heartbeat(stub);
			await vi.waitFor(() => expect(warn.mock.calls.some((call) => String(call[0]).includes("pim.coding.autosave_failed"))).toBe(true), { timeout: 10_000, interval: 50 });
			// It does, so the turn goes on in it, and its work is autosaved once the manager is back.
			await vi.waitFor(
				async () => {
					await heartbeat(stub);
					expect(await sql(stub, "SELECT commit_sha FROM coding_autosave")).toHaveLength(1);
				},
				{ timeout: 10_000, interval: 100 },
			);
			await within(stub, cut.run.release!);
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "completed", operationId: "steer-1" });
			expect(await kinds(stub)).not.toEqual(expect.arrayContaining(["workspace.lost"]));
			expect(await kinds(stub)).not.toEqual(expect.arrayContaining(["thread.resumed"]));
			expect(runs).toHaveLength(2);
			expect([creates(), deletes()]).toEqual([1, []]);
			expect(await stub.status()).toMatchObject({ state: "idle", consecutiveInterrupts: 0 });
			// The autosave is a commit the workspace keeps under a ref of Pim's, pushed nowhere, its checkout untouched.
			const [info] = await manager.backing.list({ sessionId: id });
			const workspace = (await manager.backing.get(info!.ref))!;
			const saved = (await sql(stub, "SELECT commit_sha, bundle FROM coding_autosave"))[0]!;
			expect(decoder.decode(await workspace.readFile(`${REPO_DIR}/.git/refs/pim/autosave`))).toBe(saved.commit_sha);
			expect((saved.bundle as ArrayBuffer).byteLength).toBeGreaterThan(0);
			warn.mockRestore();
		});

		it("starts again from the work it autosaved when the workspace's volume was lost with its host", async () => {
			const { manager, creates } = compose();
			const cut = halfway();
			let restored: string | null = null;
			claude = async (context) => {
				if (runs.length === 1) return { stdout: claudeFixture("turn") };
				if (runs.length === 2) return cut.command(context);
				restored = decoder.decode(await context.workspace.readFile(`${context.cwd}/wip.txt`));
				return { stdout: claudeFixture("turn") };
			};
			const { id, stub } = await startClaude();
			await turns(id, 1);
			await stub.steer("Add a farewell too", { operationId: "steer-1" });
			await cut.started();
			codingTimings.autosaveMs = 0;
			await vi.waitFor(
				async () => {
					await heartbeat(stub);
					expect(await sql(stub, "SELECT commit_sha FROM coding_autosave")).toHaveLength(1);
				},
				{ timeout: 10_000, interval: 100 },
			);
			// The host dies, and comes back without the workspace's volume.
			await within(stub, () => manager.crash(id, { restart: true, volume: "lost" }));
			await within(stub, cut.run.release!);
			const [, ended] = await turns(id, 2);
			expect(ended).toMatchObject({ outcome: "completed", operationId: "resume-1-steer-1" });
			// A new workspace, cloned again, with the run's work put back from the autosave, uncommitted as it was.
			expect(creates()).toBe(2);
			expect(restored).toBe("half done\n");
			expect((await stub.log()).find((event) => event.kind === "workspace.restored")?.data).toMatchObject({ from: "autosave" });
			expect((await stub.diff()).diff).toContain("+half done");
			// Claude Code's session went with the volume: the turn went on in a new one, told what it was doing.
			expect(runs[2]!.argv).not.toContain("--resume");
			expect(runs[2]!.argv).toContain("--session-id");
			expect(runs[2]!.argv.at(-1)).toContain(LOST_RESUME_TEXT);
			expect(runs[2]!.argv.at(-1)).toContain("The task you were given:\n\nFix the greeting test");
		});
	});

	it("runs one of the person's threads at a time on their login: the next waits for the first to end", async () => {
		// The first run prints nothing while it waits for the gate, longer than the tests' usual 300 ms stall limit on a slow runner.
		codingTimings.stallMs = 60_000;
		onTestFinished(() => {
			codingTimings.stallMs = 300;
		});
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		claude = async () => {
			if (runs.length === 1) await gate;
			return { stdout: claudeFixture("turn") };
		};
		const first = await startClaude();
		await running(1);
		const second = await startClaude({ task: "Another task" });
		const heartbeat = (stub: Stub) => inside(stub, (thread) => thread.onJob({ job: { fn: "advance" } } as Parameters<CodingThreadDO["onJob"]>[0]));
		await vi.waitFor(async () => expect(await second.stub.status()).toMatchObject({ stateReason: "harness_busy", currentOperation: null, inbox: 1 }));
		await heartbeat(second.stub);
		expect(runs).toHaveLength(1);
		release();
		await turns(first.id, 1);
		await heartbeat(second.stub);
		const [ended] = await turns(second.id, 1);
		expect(ended).toMatchObject({ outcome: "completed" });
		expect(runs.map((run) => run.argv.at(-1))).toEqual(["Fix the greeting test", "Another task"]);
	});

	it("waits for the person when the CLI says its login is gone, and goes on once continued", async () => {
		claude = async () => ({ stdout: claudeFixture("login"), code: 1 });
		const { id, stub } = await startClaude();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "needs_approval", reason: "login_required", state: "waiting_input" });
		expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", slot: "held" });
		claude = async () => ({ stdout: claudeFixture("turn") });
		await stub.continue({ operationId: "after-login" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "after-login" });
		expect(runs[1]!.argv.at(-1)).toBe(CONTINUE_TEXT);
	});
});

describe("a Codex thread", () => {
	// The thread runs `codex` in its in-memory workspace, where it is a script that prints the JSONL of
	// test/fixtures/codex/, and `pkill` records the signal it was sent. The person's Codex login, `auth.json`, is in
	// the coding vault for real.
	type Run = { argv: string[]; env: Record<string, string>; cwd: string; login: string };
	const runs: Run[] = [];
	const signals: string[][] = [];
	const waiting: (() => void)[] = [];
	let codexCli: (context: Parameters<FakeCommandHandler>[0]) => Promise<FakeCommandResult> = async () => ({ stdout: codexFixture("turn") });
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const LOGIN = '{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ-original-access","refresh_token":"rt_original"}}';
	const REFRESHED = '{"auth_mode":"chatgpt","tokens":{"access_token":"eyJ-refreshed-access","refresh_token":"rt_rotated"}}';
	const AUTH = "/workspace/.codex/auth.json";
	const started: Stub[] = [];

	codingWorkspaces.register("codex", async (context) => {
		const login = await context.workspace.readFile(`${context.env.CODEX_HOME}/auth.json`).then(
			(data) => decoder.decode(data),
			() => "",
		);
		runs.push({ argv: context.argv, env: context.env, cwd: context.cwd, login });
		return codexCli(context);
	});

	async function signIn(login = LOGIN) {
		const vault = codingVault(env);
		const { version } = await vault.load(OWNER, "codex");
		await vault.save(OWNER, "codex", [{ path: "auth.json", mode: 0o600, data: encoder.encode(login) }], version);
	}

	const storedLogin = async () => {
		const files = (await codingVault(env).load(OWNER, "codex")).files;
		return files ? decoder.decode(files.find((file) => file.path === "auth.json")!.data) : null;
	};

	async function startCodex(overrides: Partial<StartThread> = {}) {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "codex", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "codex", task: "Fix the greeting test", ...overrides }));
		return { id, stub };
	}

	beforeEach(async () => {
		runs.length = 0;
		signals.length = 0;
		codexCli = async () => ({ stdout: codexFixture("turn") });
		await signIn();
	});

	afterEach(async () => {
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
	});

	it("runs a turn with the person's login, keeps its transcript, tokens, tests and refreshed login, then resumes Codex's session", async () => {
		codexCli = async ({ workspace }) => {
			await workspace.writeFile(`${REPO_DIR}/greet.ts`, encoder.encode("export const greet = (name: string) => `Hello, ${name}`;\n"));
			// Codex refreshed its token, rotating the refresh token, as it does.
			await workspace.writeFile(AUTH, encoder.encode(REFRESHED), 0o600);
			return { stdout: codexFixture("turn") };
		};
		const { id, stub } = await startCodex();
		const [ended] = await turns(id, 1);
		const status = await stub.status();
		expect(ended).toMatchObject({ outcome: "completed", said: "Fixed `greet` to include the name; the greeting test passes now." });
		expect(status).toMatchObject({ state: "idle", harness: "codex", profile: { providerId: "codex", model: "default" }, resolvedProfile: { provider: "codex", model: "default", source: "harness default" } });
		const [first] = runs;
		expect(first).toMatchObject({ cwd: REPO_DIR, login: LOGIN, env: { HOME: "/workspace", CODEX_HOME: "/workspace/.codex" } });
		expect(first!.argv.slice(0, 2)).toEqual(["codex", "exec"]);
		expect(first!.argv).not.toContain("resume");
		expect(first!.argv.slice(-2)).toEqual(["--", "Fix the greeting test"]);
		expect(first!.argv.find((arg) => arg.startsWith("developer_instructions="))).toContain(`on the branch ${status.repo.branch}`);
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["auth.openai.com", "chatgpt.com", "api.openai.com", "registry.npmjs.org"]));
		// The rotated login is kept, and none is left in the workspace or the thread's tables.
		expect(await storedLogin()).toBe(REFRESHED);
		await expect((await workspaceOf(id)).readFile(AUTH)).rejects.toThrow();
		const tables = await everything(stub);
		for (const secret of ["eyJ-", "rt_original", "rt_rotated"]) expect(tables).not.toContain(secret);
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.find((message) => message.role === "user")!.parts).toEqual([{ type: "text", text: "Fix the greeting test" }]);
		expect(transcript.flatMap((message) => message.parts).find((part) => part.type === "tool-call" && part.name === "shell")).toMatchObject({ arguments: { command: "npm test" } });
		expect(transcript.at(-1)!.parts).toEqual([{ type: "text", text: "Fixed `greet` to include the name; the greeting test passes now." }]);
		// Its tokens as Codex counted them, at no cost, as it estimates none; its tests; its notices and retries.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "codex", model: "codex", costUsd: 0, input: 5110, output: 1180 })]);
		expect(status.spentUsd).toBe(0);
		expect(log.find((event) => event.kind === "harness.notice")?.data).toMatchObject({ message: expect.stringContaining("Falling back") });
		expect(log.find((event) => event.kind === "harness.api_retry")?.data).toMatchObject({ attempt: 1, status: 503 });
		expect((await stub.tests()).map((run) => [run.command, run.exitCode])).toEqual([
			["npm test", 1],
			["npx vitest run test/greet.test.ts && echo 'all good'", 0],
		]);
		expect((await stub.diff()).diff).toContain("+++ b/greet.ts");

		// A steer is the next turn, which resumes the session Codex named; its tokens are what the session's grew by.
		const turn = codexLines("turn");
		codexCli = async () => ({ stdout: [turn[0], turn.at(-2), turn.at(-1)!.replace('"input_tokens":24310', '"input_tokens":30310').replace('"output_tokens":1180', '"output_tokens":1500')].join("\n") });
		await stub.steer("Also add a test for an empty name", { operationId: "steer-1" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "steer-1" });
		expect(runs[1]!.argv.slice(-4)).toEqual(["resume", CODEX_SESSION, "--", "Also add a test for an empty name"]);
		expect(runs[1]!.login).toBe(REFRESHED);
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls[1]).toMatchObject({ input: 6000, output: 320, cacheRead: 0, costUsd: 0 });
	});

	it("doesn't hold Codex to a dollar budget, since it reports no cost: its spend is unmetered", async () => {
		// $0.02 against a turn that used 25,490 tokens: tokens are no price, so it neither stops nor refuses more.
		const { id, stub } = await startCodex({ budgetUsd: 0.02 });
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed", spentUsd: 0, unmetered: true });
		await stub.steer("Go on.", { operationId: "more" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "more" });
	});

	it("waits for the person when Codex says its login expired, and goes on once continued", async () => {
		codexCli = async () => ({ stdout: codexFixture("expired"), code: 1 });
		const { id, stub } = await startCodex();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "needs_approval", reason: "login_required", state: "waiting_input" });
		expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		codexCli = async () => ({ stdout: codexFixture("turn") });
		await stub.continue({ operationId: "after-login" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "after-login" });
	});

	it("waits for the person's login before running Codex when there is none", async () => {
		const vault = codingVault(env);
		await vault.delete(OWNER, "codex");
		const { stub } = await startCodex();
		await vi.waitFor(async () => expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required", inbox: 1 }), { timeout: 10_000, interval: 20 });
		expect((await stub.status()).stateDetail).toMatch(/Connect Codex/);
		expect(runs).toEqual([]);
	});

	it("stops on abort with SIGINT to the process the turn's id names, ending the turn cancelled, and keeps the login", async () => {
		// Registered here, once the Claude Code tests above have run, as it replaces their `pkill`.
		codingWorkspaces.register("pkill", ({ argv }) => {
			signals.push(argv.slice(1));
			for (const resolve of waiting.splice(0)) resolve();
			return {};
		});
		codexCli = async ({ killed }) => {
			await Promise.race([new Promise<void>((resolve) => waiting.push(resolve)), killed]);
			return { stdout: `${codexLines("turn")[0]}\n`, code: 1 };
		};
		const { id, stub } = await startCodex();
		await vi.waitFor(() => expect(runs).toHaveLength(1), { timeout: 10_000, interval: 20 });
		await stub.abort();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "cancelled" });
		expect(signals[0]![0]).toBe("-INT");
		// The id Pim gave the first turn, which its command line carries, as Codex hadn't named its session yet.
		expect(runs[0]!.argv.join(" ")).toContain(signals[0]![2]);
		expect(await storedLogin()).toBe(LOGIN);
	});
});

describe("a Mistral Vibe thread", () => {
	// The thread runs Vibe in its in-memory workspace, where `/bin/sh` is a script that prints the streaming output of
	// test/fixtures/vibe/ and leaves the export.json beside it that Vibe would. The person's API key is in the coding
	// vault for real.
	type Run = { argv: string[]; env: Record<string, string>; cwd: string };
	const runs: Run[] = [];
	let vibe: (run: Run & { workspace: Parameters<FakeCommandHandler>[0]["workspace"]; out: string }) => Promise<FakeCommandResult>;
	const KEY = "THREADMISTRALKEY0123456789abcdef";
	const started: Stub[] = [];
	const encoder = new TextEncoder();

	codingWorkspaces.register("/bin/sh", async ({ argv, env, cwd, workspace }) => {
		runs.push({ argv, env, cwd });
		// The shell's `$1` is the run's directory, where Vibe writes its export.
		return vibe({ argv, env, cwd, workspace, out: `${argv[4]}/out` });
	});

	/** Vibe's run that printed `name` and left its export. */
	const printsRun =
		(name: "turn" | "resume" | "auth", code = 0) =>
		async ({ workspace, out }: { workspace: Parameters<FakeCommandHandler>[0]["workspace"]; out: string }) => {
			await workspace.writeFile(`${out}/export.json`, encoder.encode(vibeExport(name)));
			await workspace.writeFile(`${out}/session/meta.json`, encoder.encode(VIBE_META));
			return { stdout: vibeOutput(name), code };
		};

	async function startVibe() {
		const id = crypto.randomUUID();
		await codingScheduler(env, OWNER).registerThread({ threadId: id, createdBy: { type: "person" }, parent: null, chat: null, harness: "mistral-vibe", task: "Fix the greeting test", repo: REPO, ref: "main", budgetUsd: 3, createdAt: Date.now() });
		const stub = codingThread(env, id);
		started.push(stub);
		await stub.start(startInput(id, { space: OWNER, harness: "mistral-vibe", task: "Fix the greeting test" }));
		return { id, stub };
	}

	beforeEach(async () => {
		runs.length = 0;
		vibe = printsRun("turn");
		expect((await api("/coding/vault/mistral-vibe/api-key", { method: "PUT", body: JSON.stringify({ apiKey: KEY }) })).status).toBe(200);
	});

	afterEach(async () => {
		for (const stub of started.splice(0)) await stub.archive().catch(() => {});
		await codingVault(env).delete(OWNER, "mistral-vibe");
	});

	it("runs a turn with the person's key, keeps its transcript, tests and cost, then resumes Vibe's session, counting only what the new run cost", async () => {
		const { id, stub } = await startVibe();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "completed", said: "Fixed `greet` to end with an exclamation mark; the greeting test passes now." });
		const [first] = runs;
		expect(first).toMatchObject({ cwd: REPO_DIR, env: { HOME: "/workspace", MISTRAL_API_KEY: KEY, VIBE_ENABLE_MCP: "false" } });
		expect(first!.argv[7]).toBe("vibe");
		expect(first!.argv).not.toContain("--resume");
		expect(first!.argv[5]).toContain(`on the branch ${(await stub.status()).repo.branch}`);
		expect(first!.argv[6]).toBe("Fix the greeting test");
		expect(JSON.stringify(first!.argv)).not.toContain(KEY);
		const spec = (await workspaceOf(id)) as unknown as { spec: { egress: { allow: string[] } } };
		expect(spec.spec.egress.allow).toEqual(expect.arrayContaining(["api.mistral.ai", "registry.npmjs.org"]));
		// The run's directory, with its export, is gone after.
		await expect((await workspaceOf(id)).readFile(`${first!.argv[4]}/out/export.json`)).rejects.toThrow();
		const transcript = await inside(stub, (thread) => thread.transcript());
		expect(transcript.flatMap((message) => message.parts).find((part) => part.type === "tool-call" && part.name === "file_system.bash")).toMatchObject({ arguments: { command: "npm test" } });
		expect((await stub.tests()).map((run) => [run.command, run.exitCode])).toEqual([
			["npm test", 1],
			["npm test", 0],
		]);
		// What the run cost, as Vibe estimated it, with its tokens, cached input apart.
		const log = await stub.log();
		expect(log.filter((event) => event.kind === "model_call")).toEqual([expect.objectContaining({ provider: "mistral-vibe", model: "mistral-vibe-cli-latest", costUsd: 0.007125, input: 2500, output: 200, cacheRead: 12500 })]);
		expect((await stub.status()).spentUsd).toBeCloseTo(0.007125, 12);

		// A steer is the next turn, which resumes the session Vibe named; its export counts that run alone.
		vibe = printsRun("resume");
		await stub.steer("Now say what you changed", { operationId: "steer-1" });
		const [, second] = await turns(id, 2);
		expect(second).toMatchObject({ outcome: "completed", operationId: "steer-1" });
		expect(runs[1]!.argv.slice(runs[1]!.argv.indexOf("--resume"), runs[1]!.argv.indexOf("--resume") + 2)).toEqual(["--resume", VIBE_SESSION]);
		const calls = (await stub.log()).filter((event) => event.kind === "model_call");
		expect(calls).toHaveLength(2);
		expect(calls[1]).toMatchObject({ input: 500, output: 40, cacheRead: 3500 });
		expect(calls[1]!.costUsd).toBeCloseTo(0.001575, 12);
		expect((await stub.status()).spentUsd).toBeCloseTo(0.0087, 12);
		// The key is nowhere in the thread's tables, its log or its transcript.
		expect(await everything(stub)).not.toContain(KEY);
		expect(JSON.stringify(await stub.log())).not.toContain(KEY);
		expect(JSON.stringify(await inside(stub, (thread) => thread.transcript()))).not.toContain(KEY);
	});

	it("waits for the person when Mistral refused the key, and goes on once continued", async () => {
		vibe = printsRun("auth", 1);
		const { id, stub } = await startVibe();
		const [ended] = await turns(id, 1);
		expect(ended).toMatchObject({ outcome: "needs_approval", reason: "login_required", state: "waiting_input" });
		expect(await stub.status()).toMatchObject({ state: "waiting_input", stateReason: "login_required" });
		vibe = printsRun("turn");
		await stub.continue({ operationId: "after-key" });
		const [, again] = await turns(id, 2);
		expect(again).toMatchObject({ outcome: "completed", operationId: "after-key" });
	});
});
