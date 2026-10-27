/**
 * What a test, or the setup before it, waits for and what it starts, so that
 * a test that runs out of time says which wait it was in, and the work it
 * started is seen to finish before the next test runs.
 *
 * Watching (`watch`) changes nothing: it records a wait for work already
 * under way and passes the work's outcome on. Starting (`start`) takes the
 * work unstarted, as a function, and refuses to start it once the test has
 * run out of time; work started before then isn't stopped, only tracked.
 * Gates (`gate`) are what a test holds a fixture back with. `settle`, run
 * after each test, opens every gate still shut, then waits up to a deadline
 * for every task the test started to finish, and fails naming those that
 * didn't. A finished task is all it reports: not that a socket closed (watch
 * the socket's close event for that), nor that nothing else is under way.
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

/** Work a test asked for after it had run out of time; it was never started. */
export class Cancelled extends Error {
	constructor(what: string) {
		super(`${what} was not started: its test had already run out of time.`);
		this.name = "Cancelled";
	}
}

/** Work a test started that hadn't finished by the deadline after its gates opened. */
export class CleanupNotObserved extends Error {
	constructor(
		readonly unfinished: readonly string[],
		deadlineMs: number,
	) {
		super(`Work the test started hadn't finished ${deadlineMs} ms after its gates opened: ${unfinished.join(", ")}.`);
		this.name = "CleanupNotObserved";
	}
}

export class Waits {
	readonly scope: "setup" | "test";
	readonly #signal: AbortSignal | undefined;
	readonly #open = new Map<number, { label: string; at: number }>();
	#done: { label: string; ms: number; times?: number }[] = [];
	#next = 0;
	/** Each task `start` started, with a promise that resolves, never rejects, once it has finished either way. */
	readonly #started: { label: string; finished: Promise<void> }[] = [];
	/** The gates still shut, by what each holds back. */
	readonly #gates = new Map<() => void, string>();

	/** `signal` says the test ran out of time; setup has none. */
	constructor(scope: "setup" | "test", signal?: AbortSignal) {
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
	 * Starts `begin`'s work and tracks it until it finishes, recording the
	 * wait under `what`; or, once the test has run out of time, rejects with
	 * `Cancelled` without calling `begin`.
	 */
	start<T>(what: string, begin: () => T): Promise<Awaited<T>> {
		const name = label(what);
		if (this.#signal?.aborted) return Promise.reject(new Cancelled(name));
		let finish = () => undefined as void;
		this.#started.push({
			label: name,
			finished: new Promise<void>((resolve) => {
				finish = () => resolve();
			}),
		});
		let work: T | Promise<never>;
		try {
			work = begin();
		} catch (error) {
			work = Promise.reject(error);
		}
		return this.#watch(name, work, finish);
	}

	/** A gate the test holds a fixture back with: `opened` resolves once `open` is called, or once `settle` opens it. */
	gate(what: string): { opened: Promise<void>; open: () => void } {
		let open = () => undefined as void;
		const opened = new Promise<void>((resolve) => {
			open = () => {
				this.#gates.delete(open);
				resolve();
			};
		});
		this.#gates.set(open, label(what));
		return { opened, open };
	}

	/**
	 * Opens every gate still shut, then waits up to `deadlineMs` for every task
	 * `start` started to finish. Rejects with `CleanupNotObserved`, naming the
	 * tasks still unfinished, when the deadline passes first.
	 */
	async settle(deadlineMs: number): Promise<void> {
		for (const open of [...this.#gates.keys()]) open();
		const unfinished = new Set(this.#started);
		for (const task of this.#started) void task.finished.then(() => unfinished.delete(task));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, deadlineMs);
		});
		await Promise.race([Promise.all(this.#started.map((task) => task.finished)), deadline]);
		clearTimeout(timer);
		if (unfinished.size > 0) throw new CleanupNotObserved([...unfinished].map((task) => task.label), deadlineMs);
	}

	/** The waits as one line of JSON: those open, the gates still shut and the last waits that finished, with `extra`. */
	report(extra: Record<string, unknown> = {}): string {
		const now = Date.now();
		return JSON.stringify({
			event: "test.waits",
			scope: this.scope,
			open: [...this.#open.values()].map((wait) => ({ label: wait.label, ms: now - wait.at })),
			shut: [...this.#gates.values()],
			done: this.#done,
			...extra,
		});
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
