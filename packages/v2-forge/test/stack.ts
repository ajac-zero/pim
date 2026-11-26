// A full Forge on a real PostgreSQL database of its own, a local sandbox provider, a local bare git host and a fake Amp orb client.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { inject } from "vitest";
import { FakeOrbClient } from "@pim/coding/orb/fake";
import { Authz, type Actor } from "../src/authz";
import { migrate, type Db } from "../src/db";
import { Forge } from "../src/forge";
import { LocalGitHost } from "../src/local-git";
import { LocalSandboxProvider } from "../src/local-sandbox";
import { MemoryObjects, type TurnPort, type TurnRequest, type TurnResult } from "../src/ports";
import { ForgeScheduler } from "../src/scheduler";
import { StallSupervisor, Journal } from "../src/stall";
import { ForgeStore } from "../src/store";
import { Credentials } from "../src/tokens";
import { ForgeWorker, type WorkerDeps } from "../src/worker";
import type { Harness } from "../src/harnesses";

let seq = 0;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export const REPO = "https://github.com/acme/app";
export const ada: Actor = { ownerId: "ada", role: "member" };

export async function stack(o: { ampConfigured?: boolean } = {}) {
	const admin = new pg.Client(inject("pgUrl" as never) as string);
	await admin.connect();
	const name = `t_${process.pid}_${++seq}_${Date.now()}`;
	await admin.query(`create database ${name}`);
	await admin.end();
	const pool = new pg.Pool({ connectionString: (inject("pgUrl" as never) as string).replace(/\/postgres$/, `/${name}`), max: 20 });
	const db = pool as unknown as Db;
	await migrate(db);

	const dir = mkdtempSync(join(tmpdir(), "forge-t-"));
	const bare = join(dir, "app.git");
	git(dir, "init", "--bare", "-b", "main", bare);
	const seed = join(dir, "seed");
	mkdirSync(seed);
	git(seed, "init", "-b", "main");
	writeFileSync(join(seed, "README.md"), "hello\n");
	git(seed, "add", ".");
	git(seed, "commit", "-m", "init");
	git(seed, "push", bare, "main");

	let now = Date.now();
	const clock = () => now;
	const sandboxes = new LocalSandboxProvider(join(dir, "sandboxes"));
	const gitHost = new LocalGitHost(sandboxes, { "acme/app": bare });
	const store = new ForgeStore(db);
	const authz = new Authz(db);
	const scheduler = new ForgeScheduler(db, store, clock);
	const credentials = new Credentials(db, "test-signing-key", clock);
	const objects = new MemoryObjects();
	const orb = new FakeOrbClient();
	const orbs = () => orb;
	// The local sandbox is the checkout itself: its working directory is the repository.
	const forge = new Forge({ db, store, authz, scheduler, credentials, git: gitHost, objects, orbs, compute: sandboxes, ampConfigured: o.ampConfigured ?? true, repoDir: "." });
	await scheduler.upsertPool({ poolId: "default", provider: "local", size: 50 });

	const worker = (deps: Partial<WorkerDeps> = {}, holder?: string) => new ForgeWorker({ store, scheduler, turns: {}, compute: sandboxes, orbs, objects, defaultPool: "default", clock, holder, repoDir: ".", watchMs: 25, ...deps });

	/** Gives the person every coding permission, as an admin would. */
	const grantAll = async (owner = "ada", opts: { requiresApproval?: boolean } = {}) => {
		const ids: number[] = [];
		for (const p of ["coding:start", "coding:steer", "coding:abort", "coding:push", "coding:pr", "coding:merge"] as const) ids.push(await authz.grant({ subjectType: "user", subjectId: owner, permission: p, grantedBy: "admin", requiresApproval: opts.requiresApproval && ["coding:push", "coding:merge"].includes(p) }));
		return ids;
	};

	/** Clones the repository into the thread's sandbox on its own branch, the way a harness's checkout would. */
	const checkout = async (threadId: string) => {
		const t = (await store.get(threadId))!;
		const h = t.workspaceRef;
		if ((await sandboxes.exec(h, ["test", "-d", ".git"])).code !== 0) {
			await sandboxes.exec(h, ["git", "clone", bare, "."]);
			await sandboxes.exec(h, ["git", "checkout", "-b", t.branch!]);
		}
		return h;
	};
	const sh = (h: any, ...cmd: string[]) => sandboxes.exec(h, ["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...cmd]);
	const commit = async (threadId: string, file: string, content: string) => {
		const h = await checkout(threadId);
		await sandboxes.exec(h, ["sh", "-c", `printf %s '${content}' > ${file}`]);
		await sh(h, "add", ".");
		await sh(h, "commit", "-m", `edit ${file}`);
	};

	/** Moves the clock; DB-side lease times are real, so leases are shortened with leaseMs instead. */
	const advance = (ms: number) => (now += ms);
	const close = async () => {
		await pool.end();
	};
	return { db, pool, store, authz, scheduler, credentials, objects, orb, forge, worker, sandboxes, git: gitHost, bare, dir, grantAll, checkout, commit, sh, advance, clock, stall: new StallSupervisor(db, store, clock), journal: new Journal(db, clock), close };
}

/** A turn runner a test scripts: each call takes the next script entry (a result or a function). */
export class ScriptedPort implements TurnPort {
	readonly calls: TurnRequest[] = [];
	constructor(private script: (TurnResult | ((t: TurnRequest) => Promise<TurnResult> | TurnResult))[]) {}
	async run(turn: TurnRequest): Promise<TurnResult> {
		this.calls.push(turn);
		const next = this.script.shift() ?? { outcome: "completed", text: "done" };
		return typeof next === "function" ? next(turn) : next;
	}
}

export const startReq = (operationId: string, over: Partial<Parameters<Forge["start"]>[1]> = {}) => ({ operationId, task: "Fix the login bug", repo: REPO, chatId: "chat-1", ...over });
export type { Harness };
