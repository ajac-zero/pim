import type { Context } from "@earendil-works/pi-ai";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { codingThread, type StartThread } from "../src/coding/thread-do";
import { REPO_DIR } from "../src/coding/tools";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { workspaceRegistry } from "../src/coding/workspace/registry";
import { fakeGit, fakeRemotes } from "./fake-git";
import { type CodingThreadDO, codingBackends, codingCompute, codingContainers, codingEvents, codingFaux, codingSchedulers, codingThreadClock, codingTimings, codingWorkspaces } from "./worker";

// Shared by the files that test the coding thread's object (coding-thread-do.test.ts, coding-thread-workspaces.test.ts,
// coding-thread-harnesses.test.ts). Each thread here works in the in-memory workspace with a fake git, with the real coding tools, talks to the scripted
// `coding-faux` model, and asks a scheduler of its own space for a slot; the schedulers tell threads what happens to them
// for real. Workspaces clone through the git broker on this Pim, https://pim.test, which the fake git stands in for.

export const REPO = "https://github.com/acme/demo";
export const BROKER_URL = "https://pim.test/api/coding/git/acme/demo.git";
fakeRemotes.set(BROKER_URL, { "README.md": "# Demo\n" });

export const CODER = { providerId: "coding-faux", model: "coder" };

export type Stub = DurableObjectStub<CodingThreadDO>;

export function startInput(id: string, overrides: Partial<StartThread> = {}): StartThread {
	return { space: `space-${id}`, repo: REPO, task: "Add a greeting", profile: CODER, createdBy: "tester", operationId: `start-${id}`, ...overrides };
}

export async function startThread(overrides: Partial<StartThread> = {}) {
	const id = crypto.randomUUID();
	const stub = codingThread(env, id);
	const input = startInput(id, overrides);
	const status = await stub.start(input);
	return { id, stub, input, status };
}

/** The thread's `thread.turn_ended` events, once it has had `count`. With `wake`, asks for its status meanwhile, which starts a thread that was reset. */
export async function turns(id: string, count: number, wake = false) {
	return vi.waitFor(
		async () => {
			// A stub of an object that was reset is broken: each try takes a new one.
			if (wake) await codingThread(env, id).status();
			const ended = codingEvents.filter((event) => event.threadId === id);
			expect(ended).toHaveLength(count);
			return ended;
		},
		{ timeout: 15_000, interval: 50 },
	);
}

/**
 * Calls the thread in its object rather than over RPC, for calls that throw: the Workers test pool reports an error
 * thrown across RPC as unhandled, though the caller catches it.
 */
export const inside = <T>(stub: Stub, call: (thread: CodingThreadDO) => Promise<T>) => runInDurableObject(stub, (instance: CodingThreadDO) => call(instance));

/** Every row of every table the thread's object keeps, as one text, to look for what must never be stored. */
export const everything = (stub: Stub) =>
	runInDurableObject(stub, (_instance: CodingThreadDO, state) => {
		const tables = state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").toArray();
		return JSON.stringify(tables.map(({ name }) => state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()));
	});

/** The thread's workspace, as its provider has it. */
export async function workspaceOf(id: string) {
	const [info] = await codingWorkspaces.list({ sessionId: id });
	return (await codingWorkspaces.get(info!.ref))!;
}

export const fileIn = async (id: string, path: string) => new TextDecoder().decode(await (await workspaceOf(id)).readFile(`${REPO_DIR}/${path}`));

export const sql = (stub: Stub, query: string) => runInDurableObject(stub, (_instance: CodingThreadDO, state) => state.storage.sql.exec(query).toArray());

/** The text the model was last sent, its system prompt included. */
export const sent = (context: Context) => JSON.stringify(context);

beforeEach(() => {
	codingBackends.registry = null;
	codingBackends.production = false;
	codingCompute.providers = null;
	codingContainers.service = null;
	codingSchedulers.notifier = null;
	codingSchedulers.now = null;
	codingThreadClock.now = null;
	codingTimings.resumeWaitMs = 120_000;
	codingTimings.retryMs = 30_000;
	codingEvents.length = 0;
});

afterEach(() => {
	// Every scripted response was used: the thread called its model as the test expected.
	expect(codingFaux.getPendingResponseCount()).toBe(0);
});

/** A fake provider with a one-minute session cap, driven by the thread's clock, which starts now. */
export function capped(options: ConstructorParameters<typeof FakeWorkspaceProvider>[0] = {}) {
	const t0 = Date.now();
	codingThreadClock.now = t0;
	const provider = new FakeWorkspaceProvider({ sessionMaxMin: 1, suspendResume: true, keepAlive: true, egressInjection: true, now: () => codingThreadClock.now ?? Date.now(), ...options });
	provider.register("git", fakeGit);
	codingBackends.registry = workspaceRegistry([provider]);
	return { provider, t0 };
}
