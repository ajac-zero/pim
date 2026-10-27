import {
	applyObservationEvent,
	type ObservationEvent,
	type ObservationOutcome,
	type ObservationRecord,
	type ObservationState,
	observationResponse,
	OBSERVATION_PATH_PREFIX,
	restoreObservationState,
	unresolvedObservations,
} from "./cua-observation";
import type { CuaViewerClient, HostReply, LaunchAnswer } from "./cua-viewer";

/**
 * A space's observation ledger kept durably, and the person's routes to
 * watch their Cua desktop through it (docs/cua-viewer-first-preview.md).
 * Nothing in a deployment constructs it: only the preview's `Pim` does, for
 * the one space its fixture seeded (preview/worker.ts).
 *
 * The ledger (./cua-observation.ts) is stored under `OBSERVATION_KEY`, apart
 * from the control state, which nothing here reads or writes: watching
 * grants no input, takes no lease and admits or blocks no agent request.
 *
 * - **Recorded before the host is asked.** Every event is one synchronous
 *   read-modify-write of the whole ledger in the space's storage, then
 *   `flush` (the Durable Object's `storage.sync()`) before the host is
 *   called. A write or flush that fails latches the desk blocked for the life
 *   of this instance, and the host is not asked.
 * - **Never provisioned here.** A missing ledger is not an empty one: only
 *   the preview's one-shot fixture writes the first. Missing, unreadable,
 *   another owner's or another version blocks every observation, and is
 *   left as it is. Nothing resets, evicts or recreates a ledger, and no
 *   fresh observation id escapes a record that is unconfirmed: while one is
 *   unresolved, no other observation starts.
 * - **Answers mapped, never guessed.** A lost answer makes a record
 *   `unconfirmed`; only the host's own report of closure, for the launch and
 *   generation the record names, closes one.
 * - **Management only.** The desk launches, ends and reads observations for
 *   the owner's browser session. The viewer itself goes from that browser
 *   straight to the host, at the address a launch answers with; nothing of
 *   it passes through here.
 */

/** Where a space keeps its ledger, in its own metadata. */
export const OBSERVATION_KEY = "cua_observations";

/** Where the desk keeps its ledger: synchronous reads and writes, and a flush that resolves once written writes are durable. */
export type ObservationStorage = { read(): string | undefined; write(value: string): void; flush(): Promise<void> };

export type ObservationDeskOptions = {
	/** The space's owner, from the Durable Object's own name. */
	readonly owner: string;
	readonly storage: ObservationStorage;
	/** The bridge's viewer client; throws, before anything is sent, when the space has no usable bridge. */
	readonly client: () => CuaViewerClient;
	/** How long an observation lasts from when it is recorded. */
	readonly observationMs: number;
	/** Observations unresolved at once; past it a new one is refused. */
	readonly openObservations: number;
	/** What the composition adds to the listing, such as what drives the space's agents. */
	readonly listing?: () => Record<string, unknown>;
	readonly now?: () => number;
	readonly newId?: () => string;
};

/** How the gateway found the caller: the space's owner header was checked by the space; `viaSession` from the Worker's own header. */
export type DeskCaller = { readonly viaSession: boolean };

/** A record as the person's browser sees it: never its launch, generation or viewer path. */
export type ObservationView = { id: string; status: ObservationRecord["status"]; notAfter: number; evidence: string | null };

const view = (record: ObservationRecord): ObservationView => ({ id: record.observationId, status: record.status, notAfter: record.notAfter, evidence: record.evidence ?? null });
const FINAL: readonly string[] = ["closed_observed", "not_opened", "reconciled"];
const ID = "[A-Za-z0-9_-]{16,64}";
const ONE = new RegExp(`^${OBSERVATION_PATH_PREFIX}(${ID})$`);
const END = new RegExp(`^${OBSERVATION_PATH_PREFIX}(${ID})/end$`);

/** A management answer: JSON, never kept, with no referrer. */
const answer = (value: unknown, status = 200) => observationResponse(Response.json(value, { status }));
const failure = (status: number, error: string, extra: Record<string, unknown> = {}) => answer({ error, ...extra }, status);

export class ObservationDesk {
	readonly #options: ObservationDeskOptions;
	readonly #now: () => number;
	readonly #newId: () => string;
	#state: ObservationState | null = null;
	/** Why the stored ledger can't be used, or a change couldn't be stored; never cleared in this instance. */
	#blocked: string | null = null;

	/** Loads the stored ledger. Records left `pending_open` or `revoking` come back `unconfirmed`, and are written back so. */
	constructor(options: ObservationDeskOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#newId = options.newId ?? (() => crypto.randomUUID());
		let raw: string | undefined;
		try {
			raw = options.storage.read();
		} catch {
			this.#blocked = "the ledger can't be read";
			return;
		}
		let parsed: unknown;
		try {
			parsed = raw === undefined ? undefined : JSON.parse(raw);
		} catch {
			this.#blocked = "the stored ledger isn't JSON";
			return;
		}
		const restored = restoreObservationState(parsed, options.owner);
		if (!restored.ok) {
			this.#blocked = `the ledger can't be used: ${restored.error}`;
			return;
		}
		this.#state = restored.state;
		if (JSON.stringify(restored.state) !== JSON.stringify(parsed)) this.#store(restored.state);
	}

	/** Why no observation is admitted, or null. */
	get blocked(): string | null {
		return this.#blocked;
	}

	get state(): ObservationState | null {
		return this.#blocked ? null : this.#state;
	}

	#store(next: ObservationState): boolean {
		try {
			this.#options.storage.write(JSON.stringify(next));
			this.#state = next;
			return true;
		} catch {
			this.#blocked = "a change to the ledger couldn't be stored";
			return false;
		}
	}

	/** Applies `event` and stores the result, synchronously. A refusal stores only what it changes (a conflict). */
	#apply(event: ObservationEvent): ObservationOutcome | { ok: false; reason: "storage" } {
		if (!this.#state || this.#blocked) return { ok: false, reason: "storage" };
		const result = applyObservationEvent(this.#state, event);
		if (result.state !== this.#state && !this.#store(result.state)) return { ok: false, reason: "storage" };
		return result.outcome;
	}

	/** Makes the ledger's stored writes durable before the host is asked; a failure blocks. */
	async #flush(): Promise<boolean> {
		try {
			await this.#options.storage.flush();
			return true;
		} catch {
			this.#blocked = "the ledger couldn't be made durable";
			return false;
		}
	}

	#record(id: string): ObservationRecord | undefined {
		return this.#state?.records.find((record) => record.observationId === id);
	}

	/** What the person sees of the ledger: whether observations are blocked, and its records, newest first. */
	list(): Record<string, unknown> & { blocked: string | null; observations: ObservationView[] } {
		return { ...this.#options.listing?.(), blocked: this.#blocked, observations: [...(this.#state?.records ?? [])].reverse().map(view) };
	}

	/**
	 * Answers the person's request under `/api/observations`: only the
	 * management routes, never the viewer, which the person's browser opens
	 * on the host itself. The space has checked the owner; `caller.viaSession`
	 * must say the Worker found the person's browser session, and a write must
	 * come from `publicOrigin`.
	 */
	async serve(request: Request, caller: DeskCaller, publicOrigin: string): Promise<Response> {
		const url = new URL(request.url);
		if (!caller.viaSession || request.headers.has("authorization") || url.searchParams.has("token")) return failure(401, "Only your signed-in browser can watch your desktop.");
		const path = url.pathname;
		const management = path === OBSERVATION_PATH_PREFIX.slice(0, -1) || ONE.test(path) || END.test(path);
		if (!management || url.search !== "" || request.headers.get("upgrade")) return failure(404, "Not found");
		if (request.method !== "GET" && request.headers.get("origin") !== publicOrigin) return failure(403, "Requests must come from this app");
		if (path === OBSERVATION_PATH_PREFIX.slice(0, -1)) {
			if (request.method === "GET") return answer(this.list());
			if (request.method === "POST") return this.launch();
			return failure(405, "Use GET or POST");
		}
		const one = ONE.exec(path);
		if (one) return request.method === "GET" ? this.status(one[1]!) : failure(405, "Use GET");
		const end = END.exec(path);
		if (end) return request.method === "POST" ? this.end(end[1]!) : failure(405, "Use POST");
		return failure(404, "Not found");
	}

	/** Starts an observation, or gives back the open one's viewer, recording it before the host is asked. */
	async launch(): Promise<Response> {
		if (!this.#state || this.#blocked) return failure(503, `Watching isn't available: ${this.#blocked}.`);
		let client: CuaViewerClient;
		try {
			client = this.#options.client();
		} catch {
			return failure(503, "This space's computer has no usable bridge, so nothing was asked of it.");
		}
		const now = this.#now();
		const unresolved = unresolvedObservations(this.#state);
		if (unresolved.length >= this.#options.openObservations) {
			const [current] = unresolved;
			if (unresolved.length === 1 && current!.status === "open" && now < current!.notAfter) return this.#replay(client, current!);
			// Not a new id past an uncertain one: the record must settle first, by the host's status, an end, or an operator.
			return failure(409, "Another observation is open or not settled yet. Stop it, or check it again.", { observation: view(current!) });
		}
		const id = this.#newId();
		const notAfter = now + this.#options.observationMs;
		const recorded = this.#apply({ type: "open_requested", owner: this.#options.owner, observationId: id, notAfter, now });
		if (!recorded.ok) return failure(recorded.reason === "storage" ? 503 : 409, `The observation couldn't be recorded (${recorded.reason}), so nothing was asked of the computer.`);
		if (!(await this.#flush())) return failure(503, "The observation couldn't be made durable, so nothing was asked of the computer.");
		// The flush was a wait: another flush may have failed and blocked the ledger, or the record changed. Only the exact intent stored, unblocked, is sent.
		const intent = this.#record(id);
		if (this.#blocked || intent?.status !== "pending_open" || intent.notAfter !== notAfter || intent.hostLaunchId !== null) {
			return failure(this.#blocked ? 503 : 409, "The observation changed before the computer was asked, so nothing was asked of it.", { observation: this.#view(id) });
		}
		// Nor once its deadline has come: nothing was asked, so the record says so, and the next observation may start.
		if (this.#now() >= notAfter) {
			this.#apply({ type: "open_refused", observationId: id, evidence: "its deadline came while it was being recorded; the host was never asked" });
			return failure(409, "The observation's time ran out before the computer was asked, so nothing was asked of it.", { observation: this.#view(id) });
		}
		const reply = await client.launch({ key: id, owner: this.#options.owner, notAfter });
		return this.#launched(client, id, notAfter, reply);
	}

	#launched(client: CuaViewerClient, id: string, notAfter: number, reply: HostReply<LaunchAnswer>): Response {
		const settle = (event: ObservationEvent, status: number, error: string) => {
			this.#apply(event);
			return failure(status, error, { observation: this.#view(id) });
		};
		if (reply.kind === "lost" || reply.kind === "unavailable") {
			// A `503` doesn't say whether the manager stored or started anything before it failed: as lost.
			const reason = reply.kind === "lost" ? reply.reason : "unavailable";
			return settle({ type: "unconfirmed", observationId: id, evidence: `the host's answer to launch was lost (${reason})` }, 502, "The computer's answer was lost; the observation may be open.");
		}
		if (reply.kind === "refused") return settle({ type: "open_refused", observationId: id, evidence: `the host refused the launch request before reading it (${reply.status})` }, 502, "The computer refused to start watching.");
		const host = reply.answer;
		if (host.outcome === "refused") return settle({ type: "open_refused", observationId: id, evidence: `the host refused the launch (${host.reason})` }, 503, `The computer didn't start watching (${host.reason}).`);
		if (host.key !== id) return settle({ type: "unconfirmed", observationId: id, evidence: "the host answered for another key" }, 502, "The computer answered for another observation.");
		if (host.outcome === "start_failed") return settle({ type: "open_refused", observationId: id, evidence: "the host's start failed or never happened" }, 502, "The computer couldn't start watching.");
		if (host.outcome === "unconfirmed") return settle({ type: "unconfirmed", observationId: id, evidence: `the host answered unconfirmed (${host.reason})` }, 502, "The computer can't say whether watching started.");
		// The launch is recorded first, so that whatever follows can still name it to end and observe it.
		const acknowledged = this.#apply({ type: "open_acknowledged", observationId: id, hostLaunchId: host.launchId, hostGeneration: host.generation });
		if (!acknowledged.ok) return failure(acknowledged.reason === "storage" ? 503 : 502, "The observation couldn't be recorded as open.", { observation: this.#view(id) });
		if (host.notAfter !== notAfter || host.replayed) return settle({ type: "unconfirmed", observationId: id, evidence: "the host acknowledged another deadline, or a replay for a new key" }, 502, "The computer's answer doesn't match this observation.");
		// The host was a wait: its page is handed out only if the record is still this launch, open, unblocked and before its deadline.
		if (!this.#deliverable(id, host.launchId, host.generation)) {
			return failure(409, "The observation's time ran out, or it changed, while the computer answered. Check it again.", { observation: this.#view(id) });
		}
		return this.#viewer(client, id, host.launchId, host.viewerPath);
	}

	/** The open record's launch again: the host gives back the same launch and page for a key it holds, and starts nothing new. */
	async #replay(client: CuaViewerClient, record: ObservationRecord): Promise<Response> {
		const reply = await client.launch({ key: record.observationId, owner: record.owner, notAfter: record.notAfter });
		if (reply.kind !== "answer") return failure(502, "The computer's answer was lost; try again.", { observation: view(record) });
		const host = reply.answer;
		if (host.outcome === "launched" && host.key === record.observationId && host.launchId === record.hostLaunchId && host.generation === record.hostGeneration && host.notAfter === record.notAfter) {
			// The host was a wait: the page is handed out only if the record is still this open launch, before its deadline, unblocked.
			if (!this.#deliverable(record.observationId, host.launchId, host.generation)) {
				return failure(409, "This observation changed while the computer answered. Check it again.", { observation: this.#view(record.observationId) });
			}
			return this.#viewer(client, record.observationId, host.launchId, host.viewerPath);
		}
		if (host.outcome === "launched" && host.key === record.observationId) {
			// Another launch or generation for the same record: neither replaces the first.
			this.#apply({ type: "open_acknowledged", observationId: record.observationId, hostLaunchId: host.launchId, hostGeneration: host.generation });
		} else {
			this.#apply({ type: "unconfirmed", observationId: record.observationId, evidence: `the host no longer offers this launch (${host.outcome})` });
		}
		return failure(409, "The computer no longer offers this observation's viewer. Check it again.", { observation: this.#view(record.observationId) });
	}

	/**
	 * The viewer's address on the host itself (`CuaViewerClient.viewerUrl`),
	 * which the person's browser opens directly. Its fragment is the launch's
	 * credential: it is in this answer only, never in the ledger, the listing
	 * or a log.
	 */
	#viewer(client: CuaViewerClient, id: string, launchId: string, viewerPath: string): Response {
		return answer({ observation: this.#view(id), viewer: client.viewerUrl(launchId, viewerPath) });
	}

	/** Whether `id`'s viewer may be handed out now: the ledger unblocked, the record open with exactly this launch and generation, and before its deadline. */
	#deliverable(id: string, launchId: string, generation: string): boolean {
		const current = this.#record(id);
		return !this.#blocked && current?.status === "open" && current.hostLaunchId === launchId && current.hostGeneration === generation && this.#now() < current.notAfter;
	}

	#view(id: string): ObservationView | null {
		const record = this.#record(id);
		return record ? view(record) : null;
	}

	/** Asks the host to end the record's launch. That is not closure: only `status` can observe it. */
	async end(id: string): Promise<Response> {
		if (this.#blocked) return failure(503, `Watching isn't available: ${this.#blocked}.`);
		const record = this.#record(id);
		if (!record) return failure(404, "No such observation");
		if (FINAL.includes(record.status)) return answer({ observation: view(record) });
		// A launch still being recorded or asked for is left to finish: its answer names what to end. Revoking it now would leave a record no host answer can settle.
		if (record.status === "pending_open") return failure(409, "This observation is still starting. Stop it once it has started.", { observation: view(record) });
		// An unconfirmed record whose answer named no launch gives the computer nothing to end.
		const { hostLaunchId: launchId, hostGeneration: generation } = record;
		if (launchId === null || generation === null) return failure(409, "The computer never named a launch for this observation, so there is nothing to ask it to end.", { observation: view(record) });
		// On an unconfirmed record this changes nothing: asking for an end is not closure, and it stays unconfirmed whatever the host answers.
		const revoked = this.#apply({ type: "revoke_requested", observationId: id });
		if (!revoked.ok) return failure(503, "Stopping couldn't be recorded, so nothing was asked of the computer.", { observation: view(record) });
		const current = this.#record(id)!;
		let client: CuaViewerClient;
		try {
			client = this.#options.client();
		} catch {
			return failure(503, "This space's computer has no usable bridge, so nothing was asked of it.", { observation: view(current) });
		}
		if (!(await this.#flush())) return failure(503, "Stopping couldn't be made durable, so nothing was asked of the computer.", { observation: view(current) });
		// The flush was a wait: the ledger may have blocked, or the record settled, meanwhile.
		const still = this.#record(id);
		if (this.#blocked) return failure(503, "Stopping couldn't be made durable, so nothing was asked of the computer.", { observation: this.#view(id) });
		if (!still || FINAL.includes(still.status) || still.hostLaunchId !== launchId || still.hostGeneration !== generation) return answer({ observation: this.#view(id) });
		const reply = await client.end({ owner: this.#options.owner, key: id, generation });
		if (reply.kind === "lost" || reply.kind === "unavailable") {
			this.#apply({ type: "unconfirmed", observationId: id, evidence: `the host's answer to end was lost (${reply.kind === "lost" ? reply.reason : "unavailable"})` });
			return failure(502, "The computer's answer was lost; the observation may still be open.", { observation: this.#view(id) });
		}
		if (reply.kind === "refused") return failure(502, "The computer refused the request to stop.", { observation: this.#view(id) });
		const host = reply.answer;
		if (host.outcome === "requested" || (host.outcome === "final" && host.state === "closed_observed")) return answer({ observation: this.#view(id) }, 202);
		this.#apply({ type: "unconfirmed", observationId: id, evidence: `the host answered end with ${host.outcome}${host.outcome === "final" ? ` (${host.state})` : ""}` });
		return failure(502, "The computer can't say this observation ended.", { observation: this.#view(id) });
	}

	/** Reads the record's launch on the host, and records its closure if the host observed it. A lost answer changes nothing. */
	async status(id: string): Promise<Response> {
		if (this.#blocked) return failure(503, `Watching isn't available: ${this.#blocked}.`);
		const record = this.#record(id);
		if (!record) return failure(404, "No such observation");
		if (FINAL.includes(record.status) || record.hostLaunchId === null || record.hostGeneration === null) return answer({ observation: view(record) });
		let client: CuaViewerClient;
		try {
			client = this.#options.client();
		} catch {
			return failure(503, "This space's computer has no usable bridge, so nothing was asked of it.", { observation: view(record) });
		}
		const reply = await client.status({ owner: this.#options.owner, key: id, generation: record.hostGeneration });
		if (reply.kind === "unavailable") {
			// The host's "not now": nothing changes, and the person, not Pim, asks again after `retry-after`.
			const response = failure(503, "The computer isn't taking requests right now. Check again in a few seconds.", { observation: view(record) });
			if (reply.retryAfter !== null) response.headers.set("retry-after", String(reply.retryAfter));
			return response;
		}
		if (reply.kind !== "answer") return failure(502, "The computer's answer was lost.", { observation: view(record) });
		const host = reply.answer;
		if (host.outcome !== "found" || host.key !== id || host.launchId !== record.hostLaunchId || host.generation !== record.hostGeneration) {
			this.#apply({ type: "unconfirmed", observationId: id, evidence: `the host's status doesn't name this launch (${host.outcome})` });
		} else if (host.state === "closed_observed" && host.launch !== null && host.launch.phase === "closed" && host.launch.unconfirmed === 0) {
			// Closure only from the read on which the host observed it: its own launch, in its generation, every transport closed.
			this.#apply({
				type: "closure_observed",
				observationId: id,
				hostLaunchId: host.launchId,
				hostGeneration: host.generation,
				evidence: `the host observed every transport closed${host.evidence ? `: ${host.evidence}` : ""}`,
			});
		} else if (host.state === "closed_observed") {
			// The host recorded closure on a read whose answer Pim didn't see, and no longer holds the launch to show it: not closure here.
			this.#apply({ type: "unconfirmed", observationId: id, evidence: "the host recorded closure on a read Pim didn't see; it can't be shown again" });
		} else if (host.state === "unconfirmed" || host.state === "start_failed" || host.state === "reconciled") {
			this.#apply({ type: "unconfirmed", observationId: id, evidence: `the host holds this launch as ${host.state}` });
		}
		return answer({ observation: this.#view(id), phase: host.outcome === "found" ? (host.launch?.phase ?? null) : null });
	}
}
