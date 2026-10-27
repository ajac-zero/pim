import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What a test, or the setup before it, waits for and what it starts, so that
 * a test that runs out of time says which wait it was in, and the work it
 * started is seen to finish before the next test runs.
 *
 * Each setup, test and cleanup has its own `Waits`, which owns the code it
 * runs (`ownedBy`) through the runtime's async context: the scope that owns
 * a promise continuation or a timer callback is the one that owned the code
 * that awaited or set it, whenever it runs. So a continuation of a test that
 * ran out of time still answers to that test's scope after the next test
 * has begun, and `owned()` gives it that scope, never the next test's.
 *
 * Watching (`watch`) changes nothing: it records a wait for work already
 * under way and passes the work's outcome on. Starting (`start`) takes the
 * work unstarted, as a function, and refuses to call it once the scope's
 * test has run out of time or the scope has closed; work started before
 * then isn't stopped, only tracked. Gates (`gate`) are what a test holds a
 * fixture back with. Cleanup (`defer`) is what the test needs undone
 * however it ends.
 *
 * `settle`, run after each test, first closes the scope, so nothing more
 * starts in it and the set of tasks it waits for can't grow; then opens
 * every gate still shut and waits, up to a deadline, for every task the
 * scope started to finish. Then it runs the cleanup not dismissed, last
 * registered first, in a cleanup scope of its own that admits only that
 * cleanup's work, up to a deadline of its own, and waits for what the
 * cleanup started too. It fails naming every task or cleanup not seen to
 * finish, and every cleanup that failed. A finished task is all it reports:
 * not that a socket closed (watch the socket's close event for that), nor
 * that nothing else is under way. Code that changes shared state without
 * starting work through a scope, such as a plain assignment, isn't held
 * back by any of this.
 *
 * Labels are the tests' own words, and requests' methods and paths, with IDs
 * and token-like words replaced and cut to a bounded length; nothing a wait
 * sends or gets back is kept.
 */

const MAX_LABEL = 80;
const MAX_DONE = 20;

/** `text` as a label: UUIDs, owner IDs and other long words as `:id`, at most `MAX_LABEL` characters. */
export function label(text: string): string {
	return text
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
		.replace(/\bo_[0-9a-z]{26}\b/g, ":id")
		.replace(/[0-9A-Za-z_-]{24,}/g, ":id")
		.slice(0, MAX_LABEL);
}

/** A request as a label: its method and path, without its query. */
export function requestLabel(request: Request): string {
	return label(`${request.method} ${new URL(request.url).pathname}`);
}

/** Work asked of a scope whose test had run out of time, or that had closed; it was never started. */
export class Cancelled extends Error {
	constructor(what: string, why: "ran out of time" | "had ended") {
		super(`${what} was not started: its test ${why === "ran out of time" ? "had already run out of time" : "had ended"}.`);
		this.name = "Cancelled";
	}
}

/** What `settle` didn't see finish within its deadlines, and the cleanup that failed. */
export class CleanupNotObserved extends Error {
	constructor(
		readonly unfinished: readonly string[],
		readonly failed: readonly string[],
		budget: Budget,
		cause?: unknown,
	) {
		super(
			[
				unfinished.length > 0 && `Not seen to finish within ${budget.tasks} ms for the test's work and ${budget.cleanup} ms for its cleanup: ${unfinished.join(", ")}.`,
				failed.length > 0 && `Cleanup that failed: ${failed.join(", ")}.`,
			]
				.filter(Boolean)
				.join(" "),
			{ cause },
		);
		this.name = "CleanupNotObserved";
	}
}

/** How long `settle` waits for a scope's tasks once its gates are open, and then for its cleanup, in milliseconds. */
export type Budget = { tasks: number; cleanup: number };

type Task = { label: string; finished: Promise<void> };

const owners = new AsyncLocalStorage<Waits>();

/** Runs `work` as `scope`'s own: what it starts, and every continuation and timer it leads to, answers to `scope`. */
export function ownedBy<T>(scope: Waits, work: () => T): T {
	return owners.run(scope, work);
}

/** The scope that owns the code running now, if any. */
export function owner(): Waits | undefined {
	return owners.getStore();
}

/** The scope that owns the code running now; code no setup, test or cleanup owns gets none and fails here. */
export function owned(): Waits {
	const scope = owners.getStore();
	if (!scope) throw new Error("This code runs outside any setup, test or cleanup, so nothing may start from it.");
	return scope;
}

export class Waits {
	readonly scope: "setup" | "test" | "cleanup";
	readonly #signal: AbortSignal | undefined;
	readonly #open = new Map<number, { label: string; at: number }>();
	#done: { label: string; ms: number; times?: number }[] = [];
	#next = 0;
	/** Set by `settle`: nothing more starts, and no gate or cleanup is added. */
	#closed = false;
	/** Each task `start` started, with a promise that resolves, never rejects, once it has finished either way. */
	readonly #started: Task[] = [];
	/** The gates still shut, by what each holds back. */
	readonly #gates = new Map<() => void, string>();
	/** The cleanup not yet dismissed, in the order it was registered. */
	readonly #cleanups = new Map<symbol, { label: string; run: () => unknown }>();

	/** `signal` says the scope's test ran out of time; setup and cleanup have none. */
	constructor(scope: "setup" | "test" | "cleanup", signal?: AbortSignal) {
		this.scope = scope;
		this.#signal = signal;
	}

	/** Whether any watched wait is still open. */
	get waiting(): boolean {
		return this.#open.size > 0;
	}

	/** Waits for `work`, already under way, recording the wait under `what`; its outcome is passed on as it is. */
	watch<T>(what: string, work: T): Promise<Awaited<T>> {
		return this.#watch(label(what), work);
	}

	/**
	 * Starts `begin`'s work as this scope's own and tracks it until it
	 * finishes, recording the wait under `what`; or, once the scope's test has
	 * run out of time or the scope has closed, rejects with `Cancelled`
	 * without calling `begin`.
	 */
	start<T>(what: string, begin: () => T): Promise<Awaited<T>> {
		const name = label(what);
		const refused = this.#refusal(name);
		if (refused) return Promise.reject(refused);
		let finish = () => undefined as void;
		this.#started.push({
			label: name,
			finished: new Promise<void>((resolve) => {
				finish = () => resolve();
			}),
		});
		let work: T | Promise<never>;
		try {
			work = ownedBy(this, begin);
		} catch (error) {
			work = Promise.reject(error);
		}
		return this.#watch(name, work, finish);
	}

	/** A gate the test holds a fixture back with: `opened` resolves once `open` is called, or once `settle` opens it. None is made once the scope has closed. */
	gate(what: string): { opened: Promise<void>; open: () => void } {
		const name = label(what);
		if (this.#closed) throw new Cancelled(name, "had ended");
		let open = () => undefined as void;
		const opened = new Promise<void>((resolve) => {
			open = () => {
				this.#gates.delete(open);
				resolve();
			};
		});
		this.#gates.set(open, name);
		return { opened, open };
	}

	/**
	 * Registers `run` as cleanup `settle` runs after the test, however the test
	 * ends, in a cleanup scope of its own; the function returned dismisses it,
	 * for when the test has undone the same itself. None is registered once
	 * the scope has closed.
	 */
	defer(what: string, run: () => unknown): () => void {
		const name = label(what);
		if (this.#closed) throw new Cancelled(name, "had ended");
		const key = Symbol(name);
		this.#cleanups.set(key, { label: name, run });
		return () => void this.#cleanups.delete(key);
	}

	/**
	 * Closes the scope, opens every gate still shut, and waits up to
	 * `budget.tasks` for every task the scope started to finish. Then runs
	 * the cleanup not dismissed, last registered first, in a cleanup scope,
	 * whether or not the tasks finished, and waits up to `budget.cleanup`
	 * for it and what it started. Rejects with `CleanupNotObserved` naming
	 * what wasn't seen to finish and the cleanup that failed.
	 */
	async settle(budget: Budget): Promise<void> {
		// First, so the tasks waited for below are all there will be: a task that asks for more while settling is refused.
		this.#closed = true;
		for (const open of [...this.#gates.keys()]) open();
		const unfinished = await unfinishedAfter(this.#started, budget.tasks);

		const cleanup = new Waits("cleanup");
		const deadline = Date.now() + budget.cleanup;
		const due = [...this.#cleanups.values()].reverse();
		this.#cleanups.clear();
		const failed: string[] = [];
		const errors: unknown[] = [];
		for (const [index, { label: name, run }] of due.entries()) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				unfinished.push(...due.slice(index).map((each) => `cleanup not started: ${each.label}`));
				break;
			}
			const outcome = await before(
				cleanup.start(name, run).then(
					() => ({ failed: false as const }),
					(error: unknown) => ({ failed: true as const, error }),
				),
				remaining,
			);
			if (outcome === undefined) {
				// The cleanup deadline passed with this one unfinished: it is named below, and what's left is not started.
				unfinished.push(...due.slice(index + 1).map((each) => `cleanup not started: ${each.label}`));
				break;
			}
			if (outcome.failed) {
				failed.push(name);
				errors.push(outcome.error);
			}
		}
		cleanup.#closed = true;
		unfinished.push(...(await unfinishedAfter(cleanup.#started, Math.max(0, deadline - Date.now()))).map((name) => `cleanup: ${name}`));

		if (unfinished.length > 0 || failed.length > 0) throw new CleanupNotObserved(unfinished, failed, budget, errors[0]);
	}

	/** The waits as one line of JSON: those open, the gates still shut, the cleanup still due and the last waits that finished, with `extra`. */
	report(extra: Record<string, unknown> = {}): string {
		const now = Date.now();
		return JSON.stringify({
			event: "test.waits",
			scope: this.scope,
			closed: this.#closed,
			open: [...this.#open.values()].map((wait) => ({ label: wait.label, ms: now - wait.at })),
			shut: [...this.#gates.values()],
			cleanup: [...this.#cleanups.values()].map((each) => each.label),
			done: this.#done,
			...extra,
		});
	}

	#refusal(name: string): Cancelled | null {
		if (this.#closed) return new Cancelled(name, "had ended");
		if (this.#signal?.aborted) return new Cancelled(name, "ran out of time");
		return null;
	}

	async #watch<T>(name: string, work: T, finished?: () => void): Promise<Awaited<T>> {
		const id = this.#next++;
		const at = Date.now();
		this.#open.set(id, { label: name, at });
		try {
			return await work;
		} finally {
			this.#open.delete(id);
			const ms = Date.now() - at;
			// One after another with the same label, as a poll's requests are, count as one.
			const last = this.#done.at(-1);
			if (last?.label === name) Object.assign(last, { ms: last.ms + ms, times: (last.times ?? 1) + 1 });
			else this.#done = [...this.#done.slice(1 - MAX_DONE), { label: name, ms }];
			finished?.();
		}
	}
}

/** `promise`'s value, or undefined if `ms` pass first. */
async function before<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ms);
	});
	try {
		return await Promise.race([promise, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** The labels of `tasks` not finished `ms` from now. */
async function unfinishedAfter(tasks: readonly Task[], ms: number): Promise<string[]> {
	const unfinished = new Set(tasks);
	for (const task of tasks) void task.finished.then(() => unfinished.delete(task));
	await before(Promise.all(tasks.map((task) => task.finished)), ms);
	return [...unfinished].map((task) => task.label);
}
