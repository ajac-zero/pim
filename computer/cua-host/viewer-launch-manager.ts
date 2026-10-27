/**
 * Starts the viewer adapter's launches (./viewer-adapter.ts) at most once per
 * key, through a journal that outlives the host process
 * (docs/cua-observation.md). The key is the id of Pim's observation record;
 * the owner and `notAfter` come with it and are fixed by the first request.
 *
 * `startLaunch` mints a spacesd viewer ticket and answers an in-memory
 * handle that nothing can look up again, so the manager decides before that
 * side effect: a key's intent is stored durably first, and a key already in
 * the journal is never started again. A repeated request gets the original
 * launch back while this process holds it, or an answer that says nothing
 * new was started (`refused`, `start_failed`, `unconfirmed`); it never mints
 * a second launch. Concurrent repeats share the first one's answer.
 *
 * What it keeps apart:
 *
 * - Requested and observed. `end` asks the launch to shut down. Only a
 *   status read in which every transport the launch owned has reported
 *   itself closed, with no presence stream unconfirmed, makes an entry
 *   `closed_observed`. spacesd answering `CloseMedia` is not closure, and
 *   closure of network transports is not quiescence of the desktop.
 * - This process and earlier ones. Every process has its own generation.
 *   On start, entries an earlier generation left unresolved become
 *   `unconfirmed`: their transports may still be open upstream, and nothing
 *   here can see them. A caller naming another generation is answered
 *   `generation_mismatch`, never closure.
 * - Missing and empty. A journal that is missing, unreadable or invalid
 *   blocks every launch and is left as it is. The manager never creates
 *   one: a missing journal can't be told from a lost one, and a lost one
 *   took with it the keys that must never start again. A journal is
 *   provisioned outside this module, under its own gate. Nothing clears
 *   entries, and the limits refuse new launches rather than evict.
 *
 * The root token is read for each launch and passed to `startLaunch`; it is
 * never stored, returned or logged, and neither is a launch's viewer path,
 * which is answered only to the request that started it and its repeats.
 * The manager logs nothing.
 *
 * Importing it does nothing; `openViewerLaunchManager(...)` reads the journal.
 * The host doesn't call it, so no route reaches it.
 */

import type { LaunchHandle, LaunchRequest, ViewerAdapter } from "./viewer-adapter.ts";
import { lifetimeUntil, type Timers } from "./viewer-lifetime.ts";

export const JOURNAL_VERSION = 1;

/** Entries the journal holds in all. Nothing retires them yet: at the limit, launches are refused. */
export const MAX_JOURNAL_ENTRIES = 64;

/** Entries not yet final, starts in progress included. At the limit, launches are refused; none is evicted. */
export const MAX_UNRESOLVED_LAUNCHES = 4;

/** How long a start may take before it is answered `unconfirmed`. */
export const DEFAULT_START_TIMEOUT_MS = 15_000;

export type EntryState =
	/** Stored before `startLaunch` is called; whether it was called, or minted anything, is not known from the journal alone. */
	| "intent"
	/** `startLaunch` answered a launch, and it was stored. */
	| "open"
	/** Its shutdown was requested; nothing is known to have closed. */
	| "ending"
	/** What it holds upstream is not known: a timeout, a failed write, an earlier generation. */
	| "unconfirmed"
	/** Final: a status read saw every transport the launch owned report itself closed, in the generation that held it. */
	| "closed_observed"
	/** Final: no launch was started, or `startLaunch` failed. A ticket it minted may last until `notAfter` and was never answered. */
	| "start_failed"
	/** Final: an operator reconciled an unconfirmed entry, with evidence. Not an observation. */
	| "reconciled";

const FINAL: readonly EntryState[] = ["closed_observed", "start_failed", "reconciled"];
const STATES: readonly string[] = ["intent", "open", "ending", "unconfirmed", "closed_observed", "start_failed", "reconciled"];

export type JournalEntry = {
	readonly key: string;
	readonly owner: string;
	/** Unix milliseconds, as Pim set it. Converted to a lifetime once, when the launch starts. */
	readonly notAfter: number;
	/** The host generation that stored the intent. */
	readonly generation: string;
	readonly launchId: string | null;
	readonly state: EntryState;
	readonly evidence?: string;
};

export type Journal = {
	readonly version: typeof JOURNAL_VERSION;
	/** Counts writes; each write names the revision it replaces. */
	readonly revision: number;
	/** The generation that wrote it last. */
	readonly generation: string;
	/** What whoever provisioned it, outside the manager, recorded when they did. The manager only carries it. */
	readonly initialized: string;
	readonly entries: readonly JournalEntry[];
};

/**
 * Where the journal lives. The manager awaits every write before acting on
 * it, and serializes its own writes.
 */
export type JournalStore = {
	/** The stored journal, parsed, or `undefined` when none is stored. Rejects when it can't be read. */
	readonly read: () => Promise<unknown>;
	/**
	 * Replaces the journal at `expectedRevision` with
	 * `journal`, atomically and durably: when it resolves, every later `read`,
	 * by any process, gives `journal` or a later one. A crash during it
	 * leaves the old journal or the new one whole, never a mix (write a
	 * temporary file, flush it, rename it over the old one, flush the
	 * directory). It rejects if the stored revision isn't `expectedRevision`,
	 * so a second writer is refused. A rejection says nothing about which
	 * journal is stored.
	 */
	readonly write: (journal: Journal, expectedRevision: number) => Promise<void>;
};

export type LaunchManagerOptions = {
	readonly adapter: Pick<ViewerAdapter, "startLaunch">;
	/** Without one, every launch is refused. */
	readonly store?: JournalStore;
	/** This process's generation: new each time the host starts, such as `crypto.randomUUID()`. */
	readonly generation: string;
	/** spacesd's root token, read for each launch; `undefined` refuses it. */
	readonly rootToken: () => string | undefined;
	/** The wall clock `notAfter` is read against once per launch; `Date.now` by default. */
	readonly wallClock?: () => number;
	readonly timers?: Timers;
	readonly startTimeoutMs?: number;
};

export type LaunchRequestKey = {
	/** Pim's observation id. */
	readonly key: string;
	/** The space's owner, as Pim's route derived it. */
	readonly owner: string;
	readonly notAfter: number;
	readonly displayName?: string;
};

export type LaunchRefusal =
	/** Malformed. */
	| "invalid"
	/** The manager admits nothing: see `blockers()`. */
	| "blocked"
	/** The key is journaled with another owner or `notAfter`. */
	| "conflict"
	| "no_credential"
	| "invalid_deadline"
	| "limit"
	/** The intent's write failed. `startLaunch` was not called; the intent may be stored. */
	| "storage"
	/** The key's launch was closed. */
	| "closed";

export type LaunchAnswer =
	| {
			readonly outcome: "launched";
			readonly key: string;
			readonly launchId: string;
			readonly generation: string;
			readonly notAfter: number;
			/** The viewer page with the launch's credential in its fragment. */
			readonly viewerPath: string;
			readonly replayed: boolean;
	  }
	/** Nothing was started for this request. */
	| { readonly outcome: "refused"; readonly reason: LaunchRefusal }
	/** The key's start failed or never happened; no launch is held. */
	| { readonly outcome: "start_failed"; readonly key: string }
	/** A launch may exist for the key, and none is offered. */
	| { readonly outcome: "unconfirmed"; readonly key: string; readonly reason: "timeout" | "storage" | "ended" | "earlier_generation" | "unconfirmed" };

/** A read of the key's launch: transports, requests to spacesd and their answers. `cleanup` counts requests and answers, not closures. */
export type LaunchSnapshot = ReturnType<LaunchHandle["status"]>;

export type KeyRequest = { readonly owner: string; readonly key: string; readonly generation: string };

export type EndAnswer =
	| { readonly outcome: "not_found" }
	| { readonly outcome: "generation_mismatch"; readonly generation: string }
	/** The launch this process holds was asked to shut down; `recorded` if the journal says so. Not closure. */
	| { readonly outcome: "requested"; readonly recorded: boolean }
	/** This process holds no launch for the key, and an earlier one may. */
	| { readonly outcome: "unconfirmed" }
	| { readonly outcome: "final"; readonly state: EntryState };

export type StatusAnswer =
	| { readonly outcome: "not_found" }
	| { readonly outcome: "generation_mismatch"; readonly generation: string }
	| {
			readonly outcome: "found";
			readonly key: string;
			readonly state: EntryState;
			/** The generation that stored the entry. */
			readonly generation: string;
			readonly launchId: string | null;
			readonly notAfter: number;
			readonly evidence: string | null;
			/** The launch this process holds for the key, read now; `null` when it holds none. */
			readonly launch: LaunchSnapshot | null;
	  };

export type ViewerLaunchManager = {
	readonly generation: string;
	/** Why no launch is admitted; empty when launches are. */
	readonly blockers: () => readonly string[];
	readonly launch: (request: LaunchRequestKey) => Promise<LaunchAnswer>;
	readonly end: (request: KeyRequest) => Promise<EndAnswer>;
	readonly status: (request: KeyRequest) => Promise<StatusAnswer>;
	/** Settles an unconfirmed entry this process holds no launch for, on an operator's evidence. */
	readonly reconcile: (key: string, evidence: string) => Promise<boolean>;
};

const KEY = /^[A-Za-z0-9_-]{16,64}$/;
const isName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The named fields of a plain object, read once each, or `undefined` when
 * it isn't one: another prototype, a symbol or unknown key, an accessor, or
 * a required field missing. The copy is frozen, so nothing the caller does
 * to its object afterwards reaches it. Values are not converted.
 */
function snapshot(value: unknown, required: readonly string[], optional: readonly string[] = []): Readonly<Record<string, unknown>> | undefined {
	// A proxy's traps can throw, or a revoked proxy can, at any of these reads: that is a malformed request too, not an error for the caller.
	try {
		if (!isRecord(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const keys = Reflect.ownKeys(value);
		if (keys.length > required.length + optional.length) return undefined;
		const copy: Record<string, unknown> = {};
		for (const name of keys) {
			if (typeof name !== "string" || (!required.includes(name) && !optional.includes(name))) return undefined;
			const descriptor = Object.getOwnPropertyDescriptor(value, name);
			if (!descriptor || !("value" in descriptor)) return undefined;
			copy[name] = descriptor.value;
		}
		if (required.some((name) => !(name in copy))) return undefined;
		return Object.freeze(copy);
	} catch {
		return undefined;
	}
}

/** A launch request as a frozen copy taken before anything waits, or `undefined` if it is malformed. */
function launchSnapshot(request: unknown): LaunchRequestKey | undefined {
	const fields = snapshot(request, ["key", "owner", "notAfter"], ["displayName"]);
	if (!fields) return undefined;
	const { key, owner, notAfter, displayName } = fields;
	if (typeof key !== "string" || !KEY.test(key) || !isName(owner) || !isTime(notAfter)) return undefined;
	if (displayName !== undefined && (typeof displayName !== "string" || displayName.length > 64)) return undefined;
	return Object.freeze({ key, owner, notAfter, ...(typeof displayName === "string" ? { displayName } : {}) });
}

/** A key request as a frozen copy, or `undefined` if it is malformed. */
function keySnapshot(request: unknown): KeyRequest | undefined {
	const fields = snapshot(request, ["owner", "key", "generation"]);
	if (!fields) return undefined;
	const { owner, key, generation } = fields;
	if (!isName(owner) || typeof key !== "string" || !KEY.test(key) || !isName(generation)) return undefined;
	return Object.freeze({ owner, key, generation });
}

const defaultTimers: Timers = {
	set: (callback, ms) => setTimeout(callback, ms).unref(),
	clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A stored journal, checked whole; anything off is refused, never repaired. */
function readJournal(raw: unknown): { ok: true; journal: Journal } | { ok: false; error: string } {
	const fail = (error: string) => ({ ok: false as const, error });
	if (!isRecord(raw)) return fail("not an object");
	if (raw.version !== JOURNAL_VERSION) return fail(`unsupported version ${String(raw.version)}`);
	if (!isTime(raw.revision) || !isName(raw.generation) || typeof raw.initialized !== "string" || !raw.initialized.trim()) return fail("invalid header");
	if (!Array.isArray(raw.entries) || raw.entries.length > MAX_JOURNAL_ENTRIES) return fail("entries must be an array within the limit");
	const entries: JournalEntry[] = [];
	for (const item of raw.entries) {
		if (!isRecord(item) || typeof item.key !== "string" || !KEY.test(item.key) || !isName(item.owner) || !isTime(item.notAfter) || !isName(item.generation)) return fail("invalid entry");
		if (typeof item.state !== "string" || !STATES.includes(item.state)) return fail("unknown entry state");
		const state = item.state as EntryState;
		const launchId = isName(item.launchId) ? item.launchId : null;
		if (launchId === null && item.launchId !== null) return fail("invalid launch id");
		if ((state === "intent" && launchId !== null) || ((state === "open" || state === "ending" || state === "closed_observed") && launchId === null)) return fail("state and launch disagree");
		if (item.evidence !== undefined && (typeof item.evidence !== "string" || !item.evidence.trim())) return fail("invalid evidence");
		if ((FINAL.includes(state) || state === "unconfirmed") && item.evidence === undefined) return fail(`${state} entry without evidence`);
		if (entries.some((entry) => entry.key === item.key)) return fail("duplicate key");
		entries.push({
			key: item.key,
			owner: item.owner,
			notAfter: item.notAfter,
			generation: item.generation,
			launchId,
			state,
			...(item.evidence === undefined ? {} : { evidence: item.evidence as string }),
		});
	}
	if (entries.filter((entry) => !FINAL.includes(entry.state)).length > MAX_UNRESOLVED_LAUNCHES) return fail("more unresolved entries than the limit");
	return { ok: true, journal: { version: JOURNAL_VERSION, revision: raw.revision, generation: raw.generation, initialized: raw.initialized, entries } };
}

export async function openViewerLaunchManager(options: LaunchManagerOptions): Promise<ViewerLaunchManager> {
	const generation = options.generation;
	if (!isName(generation)) throw new RangeError("A launch manager needs its generation.");
	const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	if (!Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1) throw new RangeError("A start's timeout must be a whole number of milliseconds.");
	const { adapter, store } = options;
	const wall = options.wallClock ?? Date.now;
	const timers = options.timers ?? defaultTimers;

	let journal: Journal | undefined;
	/** Why nothing is admitted. Once set by a failure it stays for this process's life: what is stored and what is remembered may disagree. */
	let blocker: string | undefined;
	/** Launches this process holds, by key, until their closure is recorded. */
	const handles = new Map<string, LaunchHandle>();
	/** Starts in progress, by key, which repeats share. */
	const starting = new Map<string, { readonly owner: string; readonly notAfter: number; readonly answer: Promise<LaunchAnswer> }>();
	/** Starts in progress whose end was requested. */
	const endRequested = new Set<string>();
	/** Starts answered `unconfirmed` on their timeout whose adapter call hasn't settled: not reconcilable yet. */
	const lateStarts = new Set<string>();
	let queue: Promise<unknown> = Promise.resolve();

	/** Writes the journal changed by `change`, after every earlier write; false, and blocked for good, if it fails. */
	function commit(change: (entries: readonly JournalEntry[]) => readonly JournalEntry[]): Promise<boolean> {
		const run = async (): Promise<boolean> => {
			if (blocker !== undefined || journal === undefined || store === undefined) return false;
			const next: Journal = { ...journal, revision: journal.revision + 1, generation, entries: change(journal.entries) };
			try {
				await store.write(next, journal.revision);
			} catch {
				blocker = "a journal write failed, so what is stored is not known; restart the host to read it again";
				return false;
			}
			journal = next;
			return true;
		};
		const written = queue.then(run, run);
		queue = written;
		return written;
	}

	const update = (key: string, fields: Partial<Omit<JournalEntry, "key" | "owner" | "notAfter" | "generation">>) =>
		commit((entries) => entries.map((entry) => (entry.key === key ? { ...entry, ...fields } : entry)));

	const find = (key: string) => journal?.entries.find((entry) => entry.key === key);

	if (store === undefined) blocker = "no journal store is configured";
	else {
		let raw: unknown;
		try {
			raw = await store.read();
		} catch {
			blocker = "the journal could not be read";
		}
		if (blocker === undefined && raw === undefined) {
			// Never created here: a lost journal took its keys with it, and starting from an empty one would let them start again.
			blocker = "no journal is stored, and this manager never creates one: launches stay refused until a journal is provisioned outside it";
		} else if (blocker === undefined) {
			const read = readJournal(raw);
			if (!read.ok) blocker = `the journal is invalid (${read.error}) and is left as it is`;
			else if (read.journal.generation === generation || read.journal.entries.some((entry) => entry.generation === generation)) {
				blocker = "the journal already names this host generation";
			} else {
				journal = read.journal;
				// Nothing from an earlier generation is held here, and none of it was seen to close.
				await commit((entries) =>
					entries.map((entry) =>
						FINAL.includes(entry.state) || entry.state === "unconfirmed"
							? entry
							: { ...entry, state: "unconfirmed" as const, evidence: `host generation ${entry.generation} ended with this launch ${entry.state}; nothing here saw it close` },
					),
				);
			}
		}
	}

	function replay(entry: JournalEntry): LaunchAnswer {
		const handle = handles.get(entry.key);
		switch (entry.state) {
			case "open":
				if (handle && entry.generation === generation && entry.launchId === handle.id && handle.status().phase === "live") {
					return { outcome: "launched", key: entry.key, launchId: handle.id, generation, notAfter: entry.notAfter, viewerPath: handle.viewerPath, replayed: true };
				}
				return { outcome: "unconfirmed", key: entry.key, reason: entry.generation === generation ? "ended" : "earlier_generation" };
			case "ending":
				return { outcome: "unconfirmed", key: entry.key, reason: "ended" };
			case "intent":
			case "unconfirmed":
				return { outcome: "unconfirmed", key: entry.key, reason: entry.generation === generation ? "unconfirmed" : "earlier_generation" };
			case "start_failed":
				return { outcome: "start_failed", key: entry.key };
			case "closed_observed":
			case "reconciled":
				return { outcome: "refused", reason: "closed" };
		}
	}

	async function start(request: LaunchRequestKey, rootToken: string): Promise<LaunchAnswer> {
		const { key } = request;
		const entry: JournalEntry = { key, owner: request.owner, notAfter: request.notAfter, generation, launchId: null, state: "intent" };
		// The intent is stored before anything reaches spacesd.
		if (!(await commit((entries) => [...entries, entry]))) return { outcome: "refused", reason: "storage" };
		const failed = async (evidence: string): Promise<LaunchAnswer> => {
			await update(key, { state: "start_failed", evidence });
			return { outcome: "start_failed", key };
		};
		// The deadline is read against the wall clock once, now, and is the launch's from here on.
		let lifetimeMs: number;
		try {
			lifetimeMs = lifetimeUntil(request.notAfter, wall());
		} catch {
			return failed("the deadline passed before the launch started; nothing was started");
		}
		let timer: unknown;
		let timedOut!: () => void;
		const timeout = new Promise<"timeout">((resolve) => {
			timedOut = () => resolve("timeout");
		});
		try {
			timer = timers.set(timedOut, startTimeoutMs);
		} catch {
			return failed("the start's timer could not be set; nothing was started");
		}
		const launchRequest: LaunchRequest = { lifetimeMs, rootToken, ...(request.displayName === undefined ? {} : { displayName: request.displayName }) };
		// An end requested while the intent was stored cancels the start before the adapter is called: nothing is minted.
		if (endRequested.has(key)) {
			try {
				timers.clear(timer);
			} catch {
				// A timer that fires later finds the race settled.
			}
			return failed("its end was requested before the start; nothing was started");
		}
		let started: Promise<LaunchHandle>;
		try {
			started = adapter.startLaunch(launchRequest);
		} catch (error) {
			started = Promise.reject(error);
		}
		const settled = started.then(
			(handle) => ({ handle }),
			() => ({ handle: undefined }),
		);
		const first = await Promise.race([settled, timeout]);
		if (first === "timeout") {
			await update(key, { state: "unconfirmed", evidence: `no answer from the adapter within ${startTimeoutMs} ms` });
			// A launch that comes later is ended at once: nobody was given its page.
			lateStarts.add(key);
			void settled.then(async ({ handle }) => {
				lateStarts.delete(key);
				if (!handle) {
					await update(key, { evidence: `no answer from the adapter within ${startTimeoutMs} ms; its start failed later` });
					return;
				}
				handles.set(key, handle);
				handle.end();
				await update(key, { launchId: handle.id, evidence: `the adapter answered after ${startTimeoutMs} ms; the launch was ended at once` });
			});
			return { outcome: "unconfirmed", key, reason: "timeout" };
		}
		try {
			timers.clear(timer);
		} catch {
			// A timer that fires later finds the race settled.
		}
		const { handle } = first;
		if (!handle) return failed("the adapter refused to start the launch; a viewer ticket it minted may last until notAfter, and was never answered");
		handles.set(key, handle);
		if (endRequested.has(key)) {
			handle.end();
			await update(key, { state: "ending", launchId: handle.id });
			return { outcome: "unconfirmed", key, reason: "ended" };
		}
		if (!(await update(key, { state: "open", launchId: handle.id }))) {
			// A launch the journal can't name is not handed out.
			handle.end();
			return { outcome: "unconfirmed", key, reason: "storage" };
		}
		// An end requested while `open` was being stored is kept too.
		if (endRequested.has(key)) {
			handle.end();
			await update(key, { state: "ending" });
			return { outcome: "unconfirmed", key, reason: "ended" };
		}
		return { outcome: "launched", key, launchId: handle.id, generation, notAfter: request.notAfter, viewerPath: handle.viewerPath, replayed: false };
	}

	async function launch(given: LaunchRequestKey): Promise<LaunchAnswer> {
		// Everything below reads this copy, taken before the first wait: the intent stored is what starts.
		const request = launchSnapshot(given);
		if (!request) return { outcome: "refused", reason: "invalid" };
		const { key, owner, notAfter } = request;
		if (blocker !== undefined) return { outcome: "refused", reason: "blocked" };
		const pending = starting.get(key);
		if (pending) {
			if (pending.owner !== owner || pending.notAfter !== notAfter) return { outcome: "refused", reason: "conflict" };
			const answer = await pending.answer;
			return answer.outcome === "launched" ? { ...answer, replayed: true } : answer;
		}
		const entry = find(key);
		if (entry) {
			if (entry.owner !== owner || entry.notAfter !== notAfter) return { outcome: "refused", reason: "conflict" };
			return replay(entry);
		}
		const rootToken = options.rootToken();
		if (typeof rootToken !== "string" || rootToken.length === 0) return { outcome: "refused", reason: "no_credential" };
		try {
			lifetimeUntil(notAfter, wall());
		} catch {
			return { outcome: "refused", reason: "invalid_deadline" };
		}
		// A start in progress counts once, whether or not its intent is stored yet.
		const stored = (journal?.entries ?? []).filter((candidate) => !starting.has(candidate.key));
		const unresolved = stored.filter((candidate) => !FINAL.includes(candidate.state)).length + starting.size;
		if (unresolved >= MAX_UNRESOLVED_LAUNCHES || stored.length + starting.size >= MAX_JOURNAL_ENTRIES) return { outcome: "refused", reason: "limit" };
		const answer = start(request, rootToken).finally(() => {
			starting.delete(key);
			endRequested.delete(key);
		});
		starting.set(key, { owner, notAfter, answer });
		return answer;
	}

	/** The key's entry for `request`, or why there's none to show. */
	function lookup(given: KeyRequest): { entry: JournalEntry } | { answer: { outcome: "not_found" } | { outcome: "generation_mismatch"; generation: string } } {
		const request = keySnapshot(given);
		if (!request) return { answer: { outcome: "not_found" } };
		if (request.generation !== generation) return { answer: { outcome: "generation_mismatch", generation } };
		const entry = find(request.key);
		// Another owner's key answers as if it didn't exist.
		if (!entry || entry.owner !== request.owner) return { answer: { outcome: "not_found" } };
		return { entry };
	}

	async function end(given: KeyRequest): Promise<EndAnswer> {
		const request = keySnapshot(given);
		if (!request) return { outcome: "not_found" };
		const pending = request.generation === generation ? starting.get(request.key) : undefined;
		if (pending && pending.owner === request.owner) {
			endRequested.add(request.key);
			// A start that already has its launch, and is storing it, ends it now.
			handles.get(request.key)?.end();
			return { outcome: "requested", recorded: false };
		}
		const found = lookup(request);
		if ("answer" in found) return found.answer;
		const { entry } = found;
		if (FINAL.includes(entry.state)) return { outcome: "final", state: entry.state };
		const handle = handles.get(entry.key);
		if (!handle) return { outcome: "unconfirmed" };
		// Ending comes first, whatever the journal can record: it only closes.
		handle.end();
		if (entry.state !== "open") return { outcome: "requested", recorded: entry.state === "ending" };
		return { outcome: "requested", recorded: await update(entry.key, { state: "ending" }) };
	}

	async function status(request: KeyRequest): Promise<StatusAnswer> {
		const found = lookup(request);
		if ("answer" in found) return found.answer;
		let { entry } = found;
		const handle = handles.get(entry.key);
		const launch = handle ? handle.status() : null;
		// Closure is what the launch saw: every transport it owned reported closed, and no presence stream is unconfirmed.
		if (handle && launch && launch.phase === "closed" && launch.unconfirmed === 0 && !FINAL.includes(entry.state) && entry.launchId === handle.id) {
			const evidence = `every transport the launch owned reported itself closed (shutdown: ${launch.reason}); CloseMedia requested ${launch.cleanup.requested}, answered ${launch.cleanup.answered}`;
			if (await update(entry.key, { state: "closed_observed", evidence })) handles.delete(entry.key);
			entry = find(entry.key) ?? entry;
		}
		return {
			outcome: "found",
			key: entry.key,
			state: entry.state,
			generation: entry.generation,
			launchId: entry.launchId,
			notAfter: entry.notAfter,
			evidence: entry.evidence ?? null,
			launch,
		};
	}

	async function reconcile(key: string, evidence: string): Promise<boolean> {
		const entry = find(key);
		if (!entry || entry.state !== "unconfirmed" || handles.has(key) || lateStarts.has(key) || typeof evidence !== "string" || !evidence.trim()) return false;
		return update(key, { state: "reconciled", evidence });
	}

	return Object.freeze({
		generation,
		blockers: () => (blocker === undefined ? [] : [blocker]),
		launch,
		end,
		status,
		reconcile,
	});
}
