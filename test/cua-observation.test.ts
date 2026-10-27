import { describe, expect, it, vi } from "vitest";
import { admissionBlockers, applyControlEvent, type ControlState, initialControlState } from "../src/computer-control";
import { ObservationDesk, type ObservationStorage } from "../src/cua-observation-runtime";
import { appOrigin, type ClientLimits, CuaViewerClient, isHttpsOrigin, parseEndAnswer, parseLaunchAnswer, parseStatusAnswer, readBounded, settle } from "../src/cua-viewer";
import {
	admitObservationRequest,
	applyObservationEvent,
	initialObservationState,
	MAX_OBSERVATION_MS,
	MAX_OBSERVATION_RECORDS,
	MAX_UNRESOLVED_OBSERVATIONS,
	type ObservationEvent,
	type ObservationState,
	observationResponse,
	restoreObservationState,
} from "../src/cua-observation";

/**
 * The observation ledger and its admission check (src/cua-observation.ts),
 * alone: no route, Durable Object, host, browser or network. Requests are
 * built in the test and only read.
 *
 * Then the Worker's side of watching (src/cua-viewer.ts,
 * src/cua-observation-runtime.ts): the desk over a ledger in memory, and its
 * client to a viewer host that is a `fetch` written in the test, answering as
 * computer/cua-host/viewer-launch-manager.ts's types say the host would. No
 * host, adapter, spacesd, browser or network is involved, and nothing here
 * says what a real bridge answers.
 */

const NOW = 1_800_000_000_000;
const ORIGIN = "https://pim.example";
const id = (n: number) => `observation-${String(n).padStart(6, "0")}`;

/** Applies events in order, expecting each to be accepted. */
const ok = (state: ObservationState, ...events: ObservationEvent[]) => {
	let current = state;
	for (const event of events) {
		const result = applyObservationEvent(current, event);
		expect(result.outcome, JSON.stringify(event)).toEqual({ ok: true });
		current = result.state;
	}
	return current;
};
const refusal = (state: ObservationState, event: ObservationEvent) => {
	const result = applyObservationEvent(state, event);
	expect(result.state).toBe(state);
	return result.outcome;
};
const requested = (n: number, notAfter = NOW + 60_000): Extract<ObservationEvent, { type: "open_requested" }> => ({ type: "open_requested", owner: "ada", observationId: id(n), notAfter, now: NOW });
const acked = (n: number, hostLaunchId = `launch${n}`, hostGeneration = "gen-a"): ObservationEvent => ({ type: "open_acknowledged", observationId: id(n), hostLaunchId, hostGeneration });
const observed = (n: number, hostLaunchId = `launch${n}`, hostGeneration = "gen-a"): ObservationEvent => ({
	type: "closure_observed",
	observationId: id(n),
	hostLaunchId,
	hostGeneration,
	evidence: "every transport reported closed",
});
const record = (state: ObservationState, n: number) => state.records.find((candidate) => candidate.observationId === id(n));
const open = (n = 1) => ok(initialObservationState("ada"), requested(n), acked(n));

describe("the observation ledger", () => {
	it("keeps observations apart from control: one opens while the agent owns the application, and control admits as before", () => {
		const resumed = applyControlEvent(initialControlState(), { type: "resume", leaseId: "L1" });
		const control: ControlState = resumed.state;
		const snapshot = JSON.stringify(control);
		expect(admissionBlockers(control)).toEqual([]);

		const ledger = ok(open(1), { type: "revoke_requested", observationId: id(1) }, { type: "unconfirmed", observationId: id(1), evidence: "the end's reply was lost" });
		expect(record(ledger, 1)?.status).toBe("unconfirmed");
		// Nothing in the ledger reaches the control state: an unconfirmed observation closes no admission, and no observation opens one.
		expect(JSON.stringify(control)).toBe(snapshot);
		expect(admissionBlockers(control)).toEqual([]);
		expect(applyControlEvent(control, { type: "admit", requestId: "r1", agentId: "a", lease: { epoch: 1, leaseId: "L1" } }).outcome).toEqual({ ok: true });
		// The control state's own viewer rule is unchanged: a control viewer still needs the human to own the application.
		expect(applyControlEvent(control, { type: "viewer_open_requested", sessionId: "s1", epoch: 1 }).outcome).toEqual({ ok: false, reason: "wrong_owner" });
	});

	it("refuses a repeated id whatever its record says, and never moves a deadline", () => {
		const pending = ok(initialObservationState("ada"), requested(1));
		expect(refusal(pending, requested(1))).toEqual({ ok: false, reason: "duplicate_id" });
		const opened = ok(pending, acked(1));
		expect(refusal(opened, requested(1, NOW + 120_000))).toEqual({ ok: false, reason: "duplicate_id" });
		const closed = ok(opened, observed(1));
		expect(refusal(closed, requested(1))).toEqual({ ok: false, reason: "duplicate_id" });
		expect(record(closed, 1)?.notAfter).toBe(NOW + 60_000);
		expect(refusal(opened, { ...requested(2), owner: "grace" })).toEqual({ ok: false, reason: "wrong_owner" });
		expect(refusal(opened, requested(2, NOW))).toEqual({ ok: false, reason: "invalid_deadline" });
		expect(refusal(opened, requested(2, NOW + MAX_OBSERVATION_MS + 1))).toEqual({ ok: false, reason: "invalid_deadline" });
		expect(refusal(opened, { ...requested(2), observationId: "short" })).toEqual({ ok: false, reason: "empty_value" });
	});

	it("never takes a lost or late reply, or a requested end, for closure", () => {
		const pending = ok(initialObservationState("ada"), requested(1));
		const lost = ok(pending, { type: "unconfirmed", observationId: id(1), evidence: "the open's reply was lost" });
		// A late acknowledgment names what to close, and doesn't make the record open.
		const late = ok(lost, acked(1));
		expect(record(late, 1)).toMatchObject({ status: "unconfirmed", hostLaunchId: "launch1", hostGeneration: "gen-a" });
		expect(refusal(late, observed(1, "launch1", "gen-b"))).toEqual({ ok: false, reason: "generation_mismatch" });
		expect(refusal(late, observed(1, "launch9"))).toEqual({ ok: false, reason: "launch_mismatch" });
		expect(refusal(pending, observed(1))).toEqual({ ok: false, reason: "launch_mismatch" });
		expect(record(ok(late, observed(1)), 1)?.status).toBe("closed_observed");

		const revoking = ok(open(1), { type: "revoke_requested", observationId: id(1) });
		expect(record(revoking, 1)?.status).toBe("revoking");
		expect(ok(revoking, { type: "revoke_requested", observationId: id(1) })).toBe(revoking);
		expect(refusal(revoking, { type: "reconcile", observationId: id(1), evidence: "x" })).toEqual({ ok: false, reason: "wrong_status" });
		expect(refusal(revoking, { type: "open_refused", observationId: id(1), evidence: "x" })).toEqual({ ok: false, reason: "wrong_status" });
		expect(record(ok(revoking, observed(1)), 1)?.status).toBe("closed_observed");
		expect(refusal(ok(revoking, observed(1)), { type: "unconfirmed", observationId: id(1), evidence: "x" })).toEqual({ ok: false, reason: "already_final" });
	});

	it("leaves a record that saw two launches unconfirmed until an operator reconciles it", () => {
		const opened = open(1);
		expect(ok(opened, acked(1))).toBe(opened);
		const result = applyObservationEvent(opened, acked(1, "launch2"));
		expect(result.outcome).toEqual({ ok: false, reason: "conflicting_launch" });
		expect(record(result.state, 1)).toMatchObject({ status: "unconfirmed", hostLaunchId: "launch1", conflicting: true });
		expect(refusal(result.state, observed(1))).toEqual({ ok: false, reason: "conflicting_launch" });
		expect(refusal(result.state, { type: "reconcile", observationId: id(1), evidence: " " })).toEqual({ ok: false, reason: "empty_value" });
		const settled = ok(result.state, { type: "reconcile", observationId: id(1), evidence: "operator: both launches ended on the host" });
		expect(record(settled, 1)?.status).toBe("reconciled");
		expect(record(settled, 1)?.conflicting).toBeUndefined();

		const refused = ok(initialObservationState("ada"), requested(2), { type: "open_refused", observationId: id(2), evidence: "the host refused before starting" });
		const surprise = applyObservationEvent(refused, acked(2));
		expect(surprise.outcome).toEqual({ ok: false, reason: "conflicting_launch" });
		expect(record(surprise.state, 2)).toMatchObject({ status: "unconfirmed", hostLaunchId: "launch2" });
		expect(record(ok(surprise.state, observed(2)), 2)?.status).toBe("closed_observed");
	});

	it("refuses new observations at its limits and evicts nothing", () => {
		let state = initialObservationState("ada");
		for (let n = 1; n <= MAX_UNRESOLVED_OBSERVATIONS; n++) state = ok(state, requested(n));
		expect(refusal(state, requested(99))).toEqual({ ok: false, reason: "limit" });
		state = ok(state, { type: "unconfirmed", observationId: id(1), evidence: "lost" });
		expect(refusal(state, requested(99))).toEqual({ ok: false, reason: "limit" });
		expect(state.records.map((r) => r.status)).toEqual(["unconfirmed", "pending_open"]);
		state = ok(state, { type: "open_refused", observationId: id(2), evidence: "refused" });
		state = ok(state, requested(3));

		let full = initialObservationState("ada");
		for (let n = 1; n <= MAX_OBSERVATION_RECORDS; n++) full = ok(full, requested(n), { type: "open_refused", observationId: id(n), evidence: "refused" });
		expect(refusal(full, requested(999))).toEqual({ ok: false, reason: "limit" });
		expect(full.records).toHaveLength(MAX_OBSERVATION_RECORDS);
	});

	it("restores conservatively, and refuses a ledger that is missing, another owner's, or inconsistent", () => {
		const state = ok(initialObservationState("ada"), requested(1), requested(2), acked(2), { type: "revoke_requested", observationId: id(2) });
		const restored = restoreObservationState(JSON.parse(JSON.stringify(state)), "ada");
		expect(restored.ok).toBe(true);
		if (!restored.ok) return;
		expect(restored.state.records.map((r) => [r.status, r.hostLaunchId])).toEqual([
			["unconfirmed", null],
			["unconfirmed", "launch2"],
		]);
		const stillOpen = restoreObservationState(JSON.parse(JSON.stringify(open(3))), "ada");
		expect(stillOpen.ok && stillOpen.state.records[0]?.status).toBe("open");

		const raw = JSON.parse(JSON.stringify(open(3)));
		expect(restoreObservationState(undefined, "ada")).toEqual({ ok: false, error: "no ledger is stored" });
		expect(restoreObservationState(raw, "grace").ok).toBe(false);
		expect(restoreObservationState({ ...raw, version: 2 }, "ada").ok).toBe(false);
		expect(restoreObservationState({ ...raw, records: [{ ...raw.records[0], status: "pending_open" }] }, "ada").ok).toBe(false);
		expect(restoreObservationState({ ...raw, records: [{ ...raw.records[0], status: "closed_observed" }] }, "ada").ok).toBe(false);
		expect(restoreObservationState({ ...raw, records: [{ ...raw.records[0], hostGeneration: null }] }, "ada").ok).toBe(false);
		expect(restoreObservationState({ ...raw, records: [{ ...raw.records[0], owner: "grace" }] }, "ada").ok).toBe(false);
		expect(restoreObservationState({ ...raw, records: [raw.records[0], raw.records[0]] }, "ada").ok).toBe(false);
		// A late acknowledgment of a final record can leave more unresolved records than new ones may make; restore keeps them.
		const late = ok(initialObservationState("ada"), requested(1), { type: "open_refused", observationId: id(1), evidence: "refused" }, requested(2), requested(3));
		const over = applyObservationEvent(late, acked(1)).state;
		expect(over.records.filter((r) => r.status !== "not_opened")).toHaveLength(3);
		expect(restoreObservationState(JSON.parse(JSON.stringify(over)), "ada").ok).toBe(true);
	});
});

describe("admitting a browser to an observation", () => {
	const caller = { owner: "ada", viaSession: true };
	const ticket = "attachToken_0123456789abcdef";
	const at = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) => new Request(`${ORIGIN}/api/observations/${id(1)}/${path}`, init);
	const page = () => at("viewer/");
	const call = (method = "cua.env.v1.StreamService/OpenMedia", headers: Record<string, string> = { origin: ORIGIN }) => at(method, { method: "POST", headers });
	const media = (headers: Record<string, string> = {}, query = `?ticket=${ticket}`) =>
		at(`media${query}`, { headers: { upgrade: "websocket", origin: ORIGIN, "sec-websocket-protocol": "rcdp.v2", ...headers } });
	const admit = (request: Request, ledger: ObservationState | null = open(1), who: { owner: string; viaSession: boolean } | null = caller, now = NOW) =>
		admitObservationRequest(request, who, ledger, now, ORIGIN);
	const status = (admission: ReturnType<typeof admit>) => (admission.ok ? 200 : admission.status);

	it("admits the owner's browser session to an open record's files, calls and media socket, at the host's own paths", () => {
		expect(admit(page())).toEqual({ ok: true, owner: "ada", observationId: id(1), hostLaunchId: "launch1", hostGeneration: "gen-a", hostTarget: "/launch1/viewer/", kind: "file" });
		expect(admit(at("viewer/viewer.js"))).toMatchObject({ ok: true, hostTarget: "/launch1/viewer/viewer.js" });
		expect(admit(call())).toMatchObject({ ok: true, kind: "call", hostTarget: "/launch1/cua.env.v1.StreamService/OpenMedia" });
		expect(admit(media())).toMatchObject({ ok: true, kind: "media", hostTarget: `/launch1/media?ticket=${ticket}` });
	});

	it("admits no API or query token, no caller without a session, and no other owner", () => {
		expect(status(admit(page(), open(1), null))).toBe(401);
		expect(status(admit(page(), open(1), { owner: "ada", viaSession: false }))).toBe(401);
		expect(status(admit(at("viewer/", { headers: { authorization: "Bearer pim_ada_secret" } })))).toBe(401);
		expect(status(admit(media({}, `?ticket=${ticket}&token=pim_ada_secret`)))).toBe(401);
		// Another owner's session finds nothing, with their ledger or with ada's.
		expect(status(admit(page(), open(1), { owner: "grace", viaSession: true }))).toBe(404);
		expect(status(admit(page(), initialObservationState("grace"), { owner: "grace", viaSession: true }))).toBe(404);
		expect(status(admit(page(), null))).toBe(404);
	});

	it("admits only canonical targets, from this app, offering only rcdp.v2", () => {
		for (const path of ["cua.env.v1.PresenceService/Leave", "cua.env.v1.PresenceService/UpdateCursor", "cua.env.v1.SystemService/CreateViewerTicket", "viewer/other.js", "viewer/a%2fb", "files", ""]) {
			expect(status(admit(call(path))), path).toBe(404);
		}
		expect(status(admit(at("viewer/?x=1")))).toBe(404);
		expect(status(admit(at("viewer/?")))).toBe(404);
		expect(status(admit(media({}, `?ticket=${ticket}&x=1`)))).toBe(404);
		expect(status(admit(media({}, "")))).toBe(404);
		expect(status(admit(new Request(`${ORIGIN}/api/observations/short/viewer/`)))).toBe(404);
		expect(status(admit(call(undefined, {})))).toBe(403);
		expect(status(admit(call(undefined, { origin: "https://evil.example" })))).toBe(403);
		expect(status(admit(at("viewer/", { headers: { "sec-fetch-site": "cross-site" } })))).toBe(403);
		expect(status(admit(media({ origin: "https://evil.example" })))).toBe(403);
		expect(status(admit(at(`media?ticket=${ticket}`)))).toBe(426);
		expect(status(admit(media({ "sec-websocket-protocol": "rcdp.v2, other" })))).toBe(400);
		expect(status(admit(media({ "sec-websocket-protocol": "" })))).toBe(400);
		expect(status(admit(at("viewer/", { headers: { upgrade: "websocket", origin: ORIGIN } })))).toBe(404);
		expect(status(admit(at("cua.env.v1.StreamService/OpenMedia")))).toBe(405);
		expect(status(admit(at("viewer/", { method: "POST", headers: { origin: ORIGIN } })))).toBe(405);
	});

	it("admits nothing before the host acknowledges, once an end is requested, or at the deadline", () => {
		const pending = ok(initialObservationState("ada"), requested(1));
		expect(status(admit(page(), pending))).toBe(404);
		expect(status(admit(page(), ok(pending, acked(1))))).toBe(200);
		const revoking = ok(open(1), { type: "revoke_requested", observationId: id(1) });
		expect(status(admit(media(), revoking))).toBe(404);
		expect(status(admit(media(), ok(revoking, { type: "unconfirmed", observationId: id(1), evidence: "lost" })))).toBe(404);
		expect(status(admit(media(), open(1), caller, NOW + 59_999))).toBe(200);
		expect(status(admit(media(), open(1), caller, NOW + 60_000))).toBe(404);
	});

	it("answers without caching, storing or a referrer", async () => {
		const answered = observationResponse(new Response("body", { status: 404, headers: { "cache-control": "max-age=60" } }));
		expect(answered.status).toBe(404);
		expect(answered.headers.get("cache-control")).toBe("no-store");
		expect(answered.headers.get("referrer-policy")).toBe("no-referrer");
		expect(answered.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await answered.text()).toBe("body");
	});
});

// ---------------------------------------------------------------- the Worker's side

const SPACE = "o_0123456789abcdefghijklmnop";
const BRIDGE = { space: SPACE, url: "https://bridge.cua.test/pim", token: "cua-viewer-test-token-0123456789abcdef" };
const LAUNCH = "L".repeat(21) + "a";
const CREDENTIAL = "c".repeat(43);
const ATTACH = "t".repeat(43);
const LIFETIME = 30 * 60 * 1000;
const empty = () => JSON.stringify(initialObservationState(SPACE));
/** A launch as the host reads it on the read that observes its closure: every transport closed, nothing unconfirmed. */
const CLOSED = {
	phase: "closed",
	reason: "ended",
	remainingMs: 0,
	transports: { "media-viewer": 0, "media-upstream": 0, "presence-rpc": 0 },
	refused: 0,
	closeFailures: 0,
	sessions: 0,
	unconfirmed: 0,
	cleanup: { requested: 1, answered: 1, failed: 0 },
};

/** One request the desk's client sent, with the ledger as stored, and the flushes made, when it left. */
type Asked = { url: string; method: string; headers: Headers; body: string; ledger: string | undefined; flushes: number };

/** The host's answer to a launch request: the launch it asked for, with `changes`. */
const launched = (asked: Asked, changes: Record<string, unknown> = {}) => {
	const { key, notAfter } = JSON.parse(asked.body) as { key: string; notAfter: number };
	return Response.json({ outcome: "launched", key, launchId: LAUNCH, generation: "gen-1", notAfter, viewerPath: `/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`, replayed: false, ...changes });
};

/**
 * A desk over a ledger held in memory (`stored`, the raw value; undefined for
 * none), whose client's `fetch` records what it is sent and lets `host` answer.
 */
function desk(options: {
	stored?: string;
	host?: (asked: Asked) => Response | Promise<Response>;
	failWrite?: (value: string) => boolean;
	/** What each flush waits on; by default none. */
	flush?: () => Promise<void>;
	openObservations?: number;
	limits?: Partial<ClientLimits>;
}) {
	const store = { value: options.stored, flushes: 0 };
	const storage: ObservationStorage = {
		read: () => store.value,
		write: (value) => {
			if (options.failWrite?.(value)) throw new Error("disk full");
			store.value = value;
		},
		flush: async () => {
			store.flushes++;
			await options.flush?.();
		},
	};
	const asked: Asked[] = [];
	const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init);
		const entry: Asked = { url: request.url, method: request.method, headers: request.headers, body: await request.text(), ledger: store.value, flushes: store.flushes };
		asked.push(entry);
		if (!options.host) throw new Error("This test's host answers nothing");
		return options.host(entry);
	}) as typeof fetch;
	let made = 0;
	const clock = { now: NOW };
	const instance = new ObservationDesk({
		owner: SPACE,
		storage,
		client: () => new CuaViewerClient(BRIDGE, SPACE, appOrigin(ORIGIN, false), fetcher, options.limits),
		observationMs: LIFETIME,
		openObservations: options.openObservations ?? 1,
		now: () => clock.now,
		newId: () => id(++made),
	});
	const records = () => (JSON.parse(store.value!) as ObservationState).records;
	return { desk: instance, store, asked, clock, records };
}

/** A wait the test holds: settled by the test, or let go by `owning` when the test ends. */
type Gate<T> = { readonly promise: Promise<T>; resolve(value: T): void; reject(error: Error): void; readonly settled: boolean };

/** What a test owns while it runs, for `owning` to let go of when it ends. */
type Owner = {
	/** A wait the test holds; if the test hasn't settled it when it ends, it is resolved with `release()`, which may also end what is waiting on it. */
	gate<T>(release: () => T): Gate<T>;
	/** An operation the test started and may not await, such as a launch waiting on a held flush. */
	track<T>(operation: Promise<T>): Promise<T>;
	/** A timer the test sets; cleared when the test ends if it hasn't run. */
	timeout(run: () => void, ms: number): void;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Runs a test's `body` with an `Owner`, then, whatever the body did, lets go
 * of everything it owns: its timers cleared, every gate it still holds
 * released, and every operation it started awaited, again until nothing is
 * held, a few times at most. Nothing is tried again and nothing is swallowed:
 * an operation that rejected, one that didn't settle within five seconds, or
 * a gate still held at the end is a cleanup failure. The body's error is
 * thrown as it is when only it failed, the cleanup's when only it did, and
 * both, the body's first, in one `AggregateError` naming each, as
 * test/cua-native-identity.test.ts does.
 */
async function owning(body: (own: Owner) => Promise<void>): Promise<void> {
	const held: { gate: Gate<unknown>; release: () => void }[] = [];
	const operations: Promise<unknown>[] = [];
	const timers = new Set<ReturnType<typeof setTimeout>>();
	const own: Owner = {
		gate<T>(release: () => T): Gate<T> {
			let settled = false;
			let resolve!: (value: T) => void;
			let reject!: (error: Error) => void;
			const promise = new Promise<T>((yes, no) => {
				resolve = yes;
				reject = no;
			});
			const gate: Gate<T> = {
				promise,
				resolve: (value) => {
					settled = true;
					resolve(value);
				},
				reject: (error) => {
					settled = true;
					reject(error);
				},
				get settled() {
					return settled;
				},
			};
			held.push({ gate, release: () => gate.resolve(release()) });
			return gate;
		},
		track<T>(operation: Promise<T>): Promise<T> {
			operations.push(operation);
			return operation;
		},
		timeout(run, ms) {
			const timer = setTimeout(() => {
				timers.delete(timer);
				run();
			}, ms);
			timers.add(timer);
		},
	};
	let failure: { readonly error: unknown } | undefined;
	try {
		await body(own);
	} catch (error) {
		failure = { error };
	}
	const problems: unknown[] = [];
	for (const timer of timers) clearTimeout(timer);
	timers.clear();
	for (let pass = 1; ; pass++) {
		for (const { gate, release } of held) {
			if (gate.settled) continue;
			try {
				release();
			} catch (error) {
				problems.push(error);
				gate.reject(new Error("Its release failed."));
			}
		}
		let stuck: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([Promise.allSettled(operations), new Promise<"stuck">((resolve) => (stuck = setTimeout(() => resolve("stuck"), 5_000)))]);
		clearTimeout(stuck);
		// One turn more, for what was let go late (an abandoned answer, a cancel) to run its course.
		await new Promise((resolve) => setTimeout(resolve, 0));
		const open = held.filter(({ gate }) => !gate.settled).length;
		if (outcome !== "stuck" && open === 0) {
			for (const result of outcome) if (result.status === "rejected") problems.push(result.reason);
			break;
		}
		if (pass === 5) {
			problems.push(new Error(outcome === "stuck" ? "An operation the test started never settled." : `${open} waits the test held were never let go.`));
			break;
		}
	}
	const cleanup = problems.length === 0 ? undefined : { error: problems.length === 1 ? problems[0] : new AggregateError(problems, problems.map(messageOf).join("; ")) };
	if (failure && cleanup) {
		throw new AggregateError([failure.error, cleanup.error], `The test failed (${messageOf(failure.error)}), and letting go of what it owned failed too (${messageOf(cleanup.error)})`);
	}
	if (failure) throw failure.error;
	if (cleanup) throw cleanup.error;
}

/** Flushes that wait until the test settles each, in the order they were asked for, owned by `own`. */
const heldFlushes = (own: Owner) => {
	const held: Gate<void>[] = [];
	return {
		held,
		flush: () => {
			const flush = own.gate<void>(() => undefined);
			held.push(flush);
			return flush.promise;
		},
	};
};

const body = async (response: Response) => (await response.json()) as Record<string, any>;
/** The launch's viewer on the host itself, at the bridge's origin, not under its `/pim` path. */
const VIEWER = `https://bridge.cua.test/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`;

describe("the Worker's client to the viewer host", () => {
	it("reads only the launch manager's own answers, field for field", () => {
		const good = { outcome: "launched", key: id(1), launchId: LAUNCH, generation: "gen-1", notAfter: NOW, viewerPath: `/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`, replayed: false };
		expect(parseLaunchAnswer(good)).toEqual(good);
		for (const bad of [
			{ ...good, extra: 1 },
			{ ...good, replayed: "no" },
			{ ...good, notAfter: String(NOW) },
			{ ...good, launchId: "short" },
			{ ...good, viewerPath: `/${LAUNCH}/viewer/#ticket=${CREDENTIAL}` },
			{ ...good, viewerPath: `/other${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0` },
			{ outcome: "refused", reason: "maybe" },
			{ outcome: "unconfirmed", key: id(1) },
			{ outcome: "launched" },
			"launched",
		]) {
			expect(parseLaunchAnswer(bad), JSON.stringify(bad)).toBeUndefined();
		}
		expect(parseEndAnswer({ outcome: "requested", recorded: true })).toEqual({ outcome: "requested", recorded: true });
		expect(parseEndAnswer({ outcome: "final", state: "closed" })).toBeUndefined();
		expect(parseEndAnswer({ outcome: "not_found", generation: "gen-1" })).toBeUndefined();
		const found = { outcome: "found", key: id(1), state: "open", generation: "gen-1", launchId: LAUNCH, notAfter: NOW, evidence: null, launch: null };
		expect(parseStatusAnswer(found)).toEqual(found);
		expect(parseStatusAnswer({ ...found, launch: { phase: "closed" } })).toBeUndefined();
		expect(parseStatusAnswer({ ...found, evidence: "" })).toBeUndefined();
	});

	it("builds the viewer's address only from the bridge's own origin and the adapter's path for that launch", () => {
		const unsent = (() => Promise.reject(new Error("nothing is sent"))) as typeof fetch;
		const client = new CuaViewerClient({ ...BRIDGE, url: "https://bridge.cua.test:8443/pim/" }, SPACE, appOrigin(ORIGIN, false), unsent);
		const path = `/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`;
		// At the bridge's root, not under its management path, and nothing of the bridge's token.
		expect(client.viewerUrl(LAUNCH, path)).toBe(`https://bridge.cua.test:8443${path}`);
		expect(new URL(client.viewerUrl(LAUNCH, path)).origin).toBe("https://bridge.cua.test:8443");
		for (const bad of [
			`//evil.example/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`,
			`https://evil.example/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`,
			`@evil.example/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=0`,
			`/${"M".repeat(22)}/viewer/#ticket=${CREDENTIAL}&clipboard=0`,
			`/${LAUNCH}/viewer/#ticket=${CREDENTIAL}&clipboard=1`,
			`/${LAUNCH}/viewer/?x=1#ticket=${CREDENTIAL}&clipboard=0`,
			`/${LAUNCH}/../viewer/#ticket=${CREDENTIAL}&clipboard=0`,
		]) {
			expect(() => client.viewerUrl(LAUNCH, bad), bad).toThrow(RangeError);
		}
		expect(() => client.viewerUrl("../x", path)).toThrow(RangeError);
		// A bridge that isn't HTTPS, or is another space's, makes no client at all.
		expect(() => new CuaViewerClient({ ...BRIDGE, url: "http://bridge.cua.test/pim" }, SPACE, appOrigin(ORIGIN, false), unsent)).toThrow();
		expect(() => new CuaViewerClient(BRIDGE, "o_zyxwvutsrqponmlkjihgfedcba", appOrigin(ORIGIN, false), unsent)).toThrow();
	});

	it("takes as the viewer's origin only a bridge origin written as a browser writes it, on another host than Pim's", () => {
		const unsent = (() => Promise.reject(new Error("nothing is sent"))) as typeof fetch;
		const make = (url: string, app = ORIGIN) => () => new CuaViewerClient({ ...BRIDGE, url }, SPACE, appOrigin(app, true), unsent);
		for (const good of ["https://bridge.cua.test/pim", "https://bridge.cua.test", "https://bridge.cua.test:8443/pim", "https://10.0.0.7/pim", "https://[2001:db8::1]:8443/pim"]) {
			expect(make(good), good).not.toThrow();
		}
		// As the host's --viewer-public-origin refuses them: an uppercase host, :443 written out, a trailing dot, an empty label, a wildcard.
		for (const bad of ["https://Bridge.cua.test/pim", "https://bridge.cua.test:443/pim", "https://bridge.cua.test./pim", "https://bridge..cua.test/pim", "https://*.cua.test/pim"]) {
			expect(make(bad), bad).toThrow();
		}
		// Pim's own host, on any port, would make the frame Pim's origin, or share its cookies.
		expect(make("https://pim.example/pim")).toThrow(RangeError);
		expect(make("https://pim.example:8443/pim")).toThrow(RangeError);
		expect(make("https://localhost/pim", "http://localhost:8787")).toThrow(RangeError);

		expect(isHttpsOrigin("https://bridge.cua.test")).toBe(true);
		for (const bad of ["https://bridge.cua.test/", "https://bridge.cua.test/pim", "https://user@bridge.cua.test", "http://bridge.cua.test", "https://bridge.cua.test:443", "https://BRIDGE.cua.test", "https://bridge.cua.test.", "https://*.cua.test", "https://bridge.cua.test?x", "https://bridge.cua.test#x"]) {
			expect(isHttpsOrigin(bad), bad).toBe(false);
		}
	});

	it("takes Pim's own address only as an exact HTTPS origin, or a local preview's loopback HTTP one, which is never embeddable", () => {
		expect(appOrigin("https://pim.example", false)).toEqual({ origin: "https://pim.example", embeddable: true });
		expect(appOrigin("https://pim.example:8443", true)).toEqual({ origin: "https://pim.example:8443", embeddable: true });
		for (const local of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "http://localhost"]) {
			expect(appOrigin(local, true), local).toEqual({ origin: local, embeddable: false });
			// Only where the caller says it is a local preview.
			expect(() => appOrigin(local, false), local).toThrow(RangeError);
		}
		// Nothing is normalized into one: another scheme, a path, a query, a fragment, credentials, uppercase, a default port written out, plain HTTP elsewhere.
		for (const bad of [
			"",
			"not an address",
			"file:///pim",
			"data:text/plain,pim",
			"https://pim.example/",
			"https://pim.example/app",
			"https://pim.example?x=1",
			"https://pim.example#x",
			"https://ada@pim.example",
			"HTTPS://pim.example",
			"https://pim.example:443",
			"http://pim.example",
			"http://localhost:8787/",
			"http://LOCALHOST:8787",
			"http://localhost:80",
			"http://ada@localhost:8787",
		]) {
			expect(() => appOrigin(bad, true), bad).toThrow(RangeError);
		}
	});

	it("observes a promise it no longer waits for, and leaves no timer or listener behind", () =>
		owning(async (own) => {
			const timers = vi.spyOn(globalThis, "setTimeout");
			const cleared = vi.spyOn(globalThis, "clearTimeout");
			try {
				const signal = (aborted: boolean) => ({ aborted, addEventListener: vi.fn(), removeEventListener: vi.fn() });
				// settle's own timers, told apart by their bound; anything else the runtime sets is not its.
				const bounded = (ms: number) => timers.mock.calls.flatMap(([, delay], index) => (delay === ms ? [timers.mock.results[index]!.value] : []));
				// Already aborted: stopped at once, with no timer or listener set, and the promise's rejection still handled (an unhandled one fails the run).
				const early = signal(true);
				expect(await settle(Promise.reject(new Error("refused")), early as unknown as AbortSignal, 1_000)).toEqual({ kind: "stopped" });
				expect(early.addEventListener).not.toHaveBeenCalled();
				expect(bounded(1_000)).toEqual([]);
				await new Promise((resolve) => setTimeout(resolve, 0));

				// Settled by its value: the timer cleared, and the listener it added removed.
				const live = signal(false);
				expect(await settle(Promise.resolve(7), live as unknown as AbortSignal, 1_000)).toEqual({ kind: "value", value: 7 });
				const listener = live.addEventListener.mock.calls[0]![1];
				expect(live.removeEventListener).toHaveBeenCalledWith("abort", listener);
				expect(bounded(1_000)).toHaveLength(1);
				expect(cleared).toHaveBeenCalledWith(bounded(1_000)[0]);

				// Stopped by its bound: the listener removed too.
				const slow = signal(false);
				// Its promise is held until the test ends, then settled.
				expect(await settle(own.gate(() => undefined).promise, slow as unknown as AbortSignal, 1)).toEqual({ kind: "stopped" });
				expect(slow.removeEventListener).toHaveBeenCalledWith("abort", slow.addEventListener.mock.calls[0]![1]);
			} finally {
				timers.mockRestore();
				cleared.mockRestore();
			}
		}));
});

describe("the desk: a space's observations, recorded before the host is asked", () => {
	it("records and flushes the observation before asking, and hands its viewer only to that answer", async () => {
		const t = desk({ stored: empty(), host: launched });
		const response = await t.desk.launch();
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("referrer-policy")).toBe("no-referrer");
		const answered = await body(response);
		expect(answered).toEqual({ observation: { id: id(1), status: "open", notAfter: NOW + LIFETIME, evidence: null }, viewer: VIEWER });

		expect(t.asked).toHaveLength(1);
		const [ask] = t.asked;
		expect(ask!.url).toBe("https://bridge.cua.test/pim/observations/launch");
		expect(ask!.method).toBe("POST");
		expect(ask!.headers.get("authorization")).toBe(`Bearer ${BRIDGE.token}`);
		expect(ask!.headers.get("x-pim-space")).toBe(SPACE);
		expect(ask!.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(ask!.body)).toEqual({ key: id(1), owner: SPACE, notAfter: NOW + LIFETIME });
		// Stored, and made durable, before the request left.
		expect((JSON.parse(ask!.ledger!) as ObservationState).records).toEqual([expect.objectContaining({ observationId: id(1), status: "pending_open", hostLaunchId: null })]);
		expect(ask!.flushes).toBe(1);
		// The launch is recorded; its credential never is.
		expect(t.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "open", hostLaunchId: LAUNCH, hostGeneration: "gen-1" })]);
		expect(t.store.value).not.toContain(CREDENTIAL);
		expect(JSON.stringify(t.desk.list())).not.toContain(CREDENTIAL);
		// The bridge's token goes only on the management request: never in the ledger, the listing or the browser's answer.
		for (const seen of [t.store.value, JSON.stringify(t.desk.list()), JSON.stringify(answered)]) expect(seen).not.toContain(BRIDGE.token);
	});

	it("fails closed on a ledger that is missing, unreadable or another owner's, and never makes one", async () => {
		for (const stored of [undefined, "not json", JSON.stringify(initialObservationState("o_zyxwvutsrqponmlkjihgfedcba")), JSON.stringify({ version: 2, owner: SPACE, records: [] })]) {
			const t = desk({ stored, host: launched });
			expect(t.desk.blocked, String(stored)).not.toBeNull();
			expect((await t.desk.launch()).status, String(stored)).toBe(503);
			expect(t.desk.list().blocked).not.toBeNull();
			expect(t.asked).toEqual([]);
			expect(t.store.value).toBe(stored);
		}
	});

	it("asks nothing when the observation can't be stored or made durable, and stays blocked", async () => {
		const unwritten = desk({ stored: empty(), host: launched, failWrite: (value) => value.includes("pending_open") });
		expect((await unwritten.desk.launch()).status).toBe(503);
		expect(unwritten.asked).toEqual([]);
		expect(unwritten.desk.blocked).not.toBeNull();
		expect((await unwritten.desk.launch()).status).toBe(503);
		expect(unwritten.asked).toEqual([]);
	});

	it("makes a record whose answer was lost or unreadable unconfirmed, and starts no fresh observation past it", async () => {
		const answers: [string, () => Response | Promise<Response>][] = [
			["no answer", () => Promise.reject(new Error("reset"))],
			["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } })],
			["a server error", () => new Response("no", { status: 500 })],
			["the manager not taking calls", () => new Response("The viewer isn't taking requests.", { status: 503, headers: { "retry-after": "5" } })],
			["not JSON", () => new Response("launched", { headers: { "content-type": "text/plain" } })],
			["JSON under another type than exactly application/json", () => new Response(JSON.stringify({ outcome: "start_failed", key: id(1) }), { headers: { "content-type": "application/json; charset=utf-8" } })],
			["an extra field", () => Response.json({ outcome: "start_failed", key: id(1), viewerPath: "/x" })],
			["too big", () => Response.json({ outcome: "start_failed", key: id(1), pad: "x".repeat(20_000) })],
			["another key", () => Response.json({ outcome: "start_failed", key: id(9) })],
			["the host unsure", () => Response.json({ outcome: "unconfirmed", key: id(1), reason: "timeout" })],
		];
		for (const [name, answer] of answers) {
			const t = desk({ stored: empty(), host: answer });
			expect((await t.desk.launch()).status, name).toBe(502);
			expect(t.records(), name).toEqual([expect.objectContaining({ observationId: id(1), status: "unconfirmed" })]);
			// No new id escapes it: the next Watch is refused, and nothing is asked.
			const again = await t.desk.launch();
			expect(again.status, name).toBe(409);
			expect((await body(again)).observation, name).toMatchObject({ id: id(1), status: "unconfirmed" });
			expect(t.asked, name).toHaveLength(1);
			expect(t.records(), name).toHaveLength(1);
		}
	});

	it("takes a refusal the host made before acting as nothing started, and lets the next observation start", async () => {
		let refuse = true;
		const t = desk({ stored: empty(), host: (asked) => (refuse ? new Response("Unauthorized", { status: 401 }) : launched(asked)) });
		expect((await t.desk.launch()).status).toBe(502);
		expect(t.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "not_opened" })]);
		refuse = false;
		expect((await t.desk.launch()).status).toBe(200);
		expect(JSON.parse(t.asked[1]!.body)).toMatchObject({ key: id(2) });
	});

	it("gives back the open observation by asking for its own key again, and keeps a different launch unconfirmed", async () => {
		let answer: (asked: Asked) => Response = launched;
		const t = desk({ stored: empty(), host: (asked) => answer(asked) });
		await t.desk.launch();
		answer = (asked) => launched(asked, { replayed: true });
		const again = await t.desk.launch();
		expect(again.status).toBe(200);
		expect((await body(again)).viewer).toBe(VIEWER);
		expect(JSON.parse(t.asked[1]!.body)).toEqual({ key: id(1), owner: SPACE, notAfter: NOW + LIFETIME });
		expect(t.records()).toHaveLength(1);

		answer = (asked) => launched(asked, { replayed: true, launchId: "M".repeat(22), viewerPath: `/${"M".repeat(22)}/viewer/#ticket=${CREDENTIAL}&clipboard=0` });
		expect((await t.desk.launch()).status).toBe(409);
		expect(t.records()).toEqual([expect.objectContaining({ status: "unconfirmed", hostLaunchId: LAUNCH, conflicting: true })]);
	});

	it("takes an end as requested, not closure: only the host's status for this launch and generation closes it", async () => {
		let answer: (asked: Asked) => Response = launched;
		const t = desk({ stored: empty(), host: (asked) => answer(asked) });
		await t.desk.launch();
		answer = () => Response.json({ outcome: "requested", recorded: true });
		const ended = await t.desk.end(id(1));
		expect(ended.status).toBe(202);
		expect((await body(ended)).observation).toMatchObject({ status: "revoking" });
		expect(t.asked[1]!.url).toBe("https://bridge.cua.test/pim/observations/end");
		expect(JSON.parse(t.asked[1]!.body)).toEqual({ owner: SPACE, key: id(1), generation: "gen-1" });
		// Recorded as revoking before the end was asked for.
		expect((JSON.parse(t.asked[1]!.ledger!) as ObservationState).records[0]!.status).toBe("revoking");

		const found = (state: string, changes: Record<string, unknown> = {}) => () =>
			Response.json({ outcome: "found", key: id(1), state, generation: "gen-1", launchId: LAUNCH, notAfter: NOW + LIFETIME, evidence: state === "closed_observed" ? "cleanup 1/1" : null, launch: state === "closed_observed" ? CLOSED : { ...CLOSED, phase: "closing", reason: "ended" }, ...changes });
		answer = found("ending");
		expect((await body(await t.desk.status(id(1)))).observation).toMatchObject({ status: "revoking" });
		// The host not taking calls: passed on as such, with nothing changed.
		answer = () => new Response("down", { status: 503 });
		expect((await t.desk.status(id(1))).status).toBe(503);
		expect(t.records()[0]!.status).toBe("revoking");
		// Still no new observation while this one isn't settled.
		expect((await t.desk.launch()).status).toBe(409);
		answer = found("closed_observed");
		expect((await body(await t.desk.status(id(1)))).observation).toMatchObject({ status: "closed_observed" });
		expect(t.asked.filter((asked) => asked.url.endsWith("/observations/status")).map((asked) => JSON.parse(asked.body))).toEqual(Array(3).fill({ owner: SPACE, key: id(1), generation: "gen-1" }));

		answer = launched;
		expect((await t.desk.launch()).status).toBe(200);
		expect(t.records().map((record) => [record.observationId, record.status])).toEqual([
			[id(1), "closed_observed"],
			[id(2), "open"],
		]);
	});

	it("takes the host's shutdown answers as they are, and never asks again by itself", async () => {
		let answer: (asked: Asked) => Response = () => Response.json({ outcome: "refused", reason: "blocked" });
		const t = desk({ stored: empty(), host: (asked) => answer(asked) });
		// A launch refused while the host shuts down started nothing: the next one may start.
		expect((await t.desk.launch()).status).toBe(503);
		expect(t.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "not_opened" })]);
		answer = launched;
		expect((await t.desk.launch()).status).toBe(200);

		// A status while it shuts down is "not now": nothing changes, the person is told when to ask, and Pim asks once.
		answer = () => new Response("The viewer isn't taking requests.", { status: 503, headers: { "retry-after": "5" } });
		const asked = t.asked.length;
		const later = await t.desk.status(id(2));
		expect(later.status).toBe(503);
		expect(later.headers.get("retry-after")).toBe("5");
		expect(t.asked).toHaveLength(asked + 1);
		expect(t.records()[1]!.status).toBe("open");

		// An end while it shuts down answers unconfirmed: so is the record, and no new observation starts past it.
		answer = () => Response.json({ outcome: "unconfirmed" });
		expect((await t.desk.end(id(2))).status).toBe(502);
		expect(t.records()[1]!.status).toBe("unconfirmed");
		expect((await t.desk.launch()).status).toBe(409);
		expect(t.asked).toHaveLength(asked + 2);
	});

	it("closes a record only on the host's read that observed it: this launch, this generation, every transport closed", async () => {
		const cases: [string, Record<string, unknown>][] = [
			["another launch", { launchId: "M".repeat(22) }],
			["another generation", { generation: "gen-2" }],
			["no launch to show (a read Pim didn't see)", { launch: null }],
			["a launch still closing", { launch: { ...CLOSED, phase: "closing" } }],
			["a presence stream unconfirmed", { launch: { ...CLOSED, unconfirmed: 1 } }],
			["the host's generation changed", { outcome: "generation_mismatch", generation: "gen-2" }],
		];
		for (const [name, changes] of cases) {
			let answer: (asked: Asked) => Response = launched;
			const t = desk({ stored: empty(), host: (asked) => answer(asked) });
			await t.desk.launch();
			const reply = { outcome: "found", key: id(1), state: "closed_observed", generation: "gen-1", launchId: LAUNCH, notAfter: NOW + LIFETIME, evidence: "closed", launch: CLOSED, ...changes };
			answer = () => Response.json(changes.outcome ? { outcome: changes.outcome, generation: changes.generation } : reply);
			await t.desk.status(id(1));
			expect(t.records()[0]!.status, name).toBe("unconfirmed");
		}
	});

	it("restores a record left pending as unconfirmed, writes it back, and refuses new ones at the limit without evicting", async () => {
		const pending = ok(initialObservationState(SPACE), { type: "open_requested", owner: SPACE, observationId: id(1), notAfter: NOW + 60_000, now: NOW });
		const restored = desk({ stored: JSON.stringify(pending), host: launched });
		expect(restored.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "unconfirmed" })]);
		expect((await restored.desk.launch()).status).toBe(409);
		expect(restored.asked).toEqual([]);

		let full = initialObservationState(SPACE);
		// Ids the desk won't mint, so that what refuses its next one is the limit, not a repeated id.
		for (let n = 101; n < 101 + MAX_OBSERVATION_RECORDS; n++) {
			full = ok(full, { type: "open_requested", owner: SPACE, observationId: id(n), notAfter: NOW + 60_000, now: NOW }, { type: "open_refused", observationId: id(n), evidence: "refused" });
		}
		expect(applyObservationEvent(full, { type: "open_requested", owner: SPACE, observationId: id(1), notAfter: NOW + 60_000, now: NOW }).outcome).toEqual({ ok: false, reason: "limit" });
		const t = desk({ stored: JSON.stringify(full), host: launched });
		expect((await t.desk.launch()).status).toBe(409);
		expect(t.asked).toEqual([]);
		expect(t.records()).toHaveLength(MAX_OBSERVATION_RECORDS);
		expect(t.records().every((record) => record.status === "not_opened")).toBe(true);
	});

	it("answers only management, for the owner's session from this app, and carries nothing of the viewer", async () => {
		const t = desk({ stored: empty(), host: launched });
		const serve = (path: string, init: RequestInit = {}, viaSession = true) => t.desk.serve(new Request(`${ORIGIN}${path}`, init), { viaSession }, ORIGIN);
		// Not the browser's session, an API token, or a write from another site: refused, and nothing is recorded or asked.
		expect((await serve("/api/observations", { method: "POST", headers: { origin: ORIGIN } }, false)).status).toBe(401);
		expect((await serve("/api/observations", { method: "POST", headers: { origin: ORIGIN, authorization: "Bearer pim_x_y" } })).status).toBe(401);
		expect((await serve("/api/observations", { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(403);
		expect((await serve("/api/observations", { method: "POST" })).status).toBe(403);
		expect(t.asked).toEqual([]);
		expect(t.records()).toEqual([]);

		expect((await serve("/api/observations", { method: "POST", headers: { origin: ORIGIN } })).status).toBe(200);
		// The viewer's page, files, calls and media are the host's, opened by the browser there: here they don't exist, and nothing is sent.
		const grpc = { origin: ORIGIN, "content-type": "application/grpc-web+proto", "x-cua-env-authorization": `Bearer ${CREDENTIAL}` };
		for (const [path, init] of [
			[`/api/observations/${id(1)}/viewer/`, {}],
			[`/api/observations/${id(1)}/viewer/viewer.js`, {}],
			[`/api/observations/${id(1)}/cua.env.v1.SystemService/GetCapabilities`, { method: "POST", headers: grpc, body: new Uint8Array(5) }],
			[`/api/observations/${id(1)}/media?ticket=${ATTACH}`, { headers: { upgrade: "websocket", origin: ORIGIN, "sec-websocket-protocol": "rcdp.v2" } }],
			[`/api/observations/${id(1)}?x=1`, {}],
		] as [string, RequestInit][]) {
			const answered = await serve(path, init);
			expect(answered.status, path).toBe(404);
			expect(answered.webSocket, path).toBeNull();
		}
		expect(t.asked.map((asked) => asked.url)).toEqual(["https://bridge.cua.test/pim/observations/launch"]);
	});

	it("asks the computer to end an unconfirmed observation's known launch again, without calling that closure", async () => {
		let answer: (asked: Asked) => Response = () => Response.json({ outcome: "unconfirmed", key: id(1), reason: "timeout" });
		const t = desk({ stored: empty(), host: (asked) => answer(asked) });
		// The launch's answer was lost: no launch is known, so there is nothing to end, and nothing is asked.
		await t.desk.launch();
		expect((await t.desk.end(id(1))).status).toBe(409);
		expect(t.asked).toHaveLength(1);

		// A known launch whose end's answer was unconfirmed: asking again reaches the host, and the record stays unconfirmed.
		const u = desk({ stored: empty(), host: (asked) => answer(asked) });
		answer = launched;
		await u.desk.launch();
		answer = () => Response.json({ outcome: "unconfirmed" });
		expect((await u.desk.end(id(1))).status).toBe(502);
		expect(u.records()[0]!.status).toBe("unconfirmed");
		answer = () => Response.json({ outcome: "requested", recorded: true });
		const again = await u.desk.end(id(1));
		expect(again.status).toBe(202);
		expect((await body(again)).observation).toMatchObject({ status: "unconfirmed" });
		expect(u.asked.filter((asked) => asked.url.endsWith("/observations/end")).map((asked) => JSON.parse(asked.body))).toEqual(Array(2).fill({ owner: SPACE, key: id(1), generation: "gen-1" }));
		expect(u.records()).toEqual([expect.objectContaining({ status: "unconfirmed", hostLaunchId: LAUNCH, hostGeneration: "gen-1" })]);
	});

	it("asks the host nothing after a flush it waited on, once another flush failed meanwhile", () =>
		owning(async (own) => {
			// Two launches in flight: the second's flush fails and blocks the ledger, so the first sends nothing, though its own flush succeeds.
			const flushes = heldFlushes(own);
			const t = desk({ stored: empty(), host: launched, flush: flushes.flush, openObservations: 2 });
			const first = own.track(t.desk.launch());
			const second = own.track(t.desk.launch());
			expect(flushes.held).toHaveLength(2);
			flushes.held[1]!.reject(new Error("disk gone"));
			expect((await second).status).toBe(503);
			flushes.held[0]!.resolve();
			expect((await first).status).toBe(503);
			expect(t.asked).toEqual([]);
			expect(t.desk.blocked).not.toBeNull();
			expect(t.records().map((record) => record.status)).toEqual(["pending_open", "pending_open"]);

			// An end whose flush fails while a launch waits on its own: neither the end nor the launch is sent.
			const later = heldFlushes(own);
			let holding = false;
			const u = desk({
				stored: empty(),
				host: (asked) => (asked.url.endsWith("/observations/end") ? Response.json({ outcome: "requested", recorded: true }) : launched(asked)),
				flush: () => (holding ? later.flush() : Promise.resolve()),
				openObservations: 2,
			});
			expect((await u.desk.launch()).status).toBe(200);
			holding = true;
			const starting = own.track(u.desk.launch());
			const stopping = own.track(u.desk.end(id(1)));
			expect(later.held).toHaveLength(2);
			later.held[1]!.reject(new Error("disk gone"));
			expect((await stopping).status).toBe(503);
			later.held[0]!.resolve();
			expect((await starting).status).toBe(503);
			expect(u.asked.map((asked) => asked.url)).toEqual(["https://bridge.cua.test/pim/observations/launch"]);
			expect(JSON.parse(u.asked[0]!.body)).toMatchObject({ key: id(1) });
		}));

	it("asks nothing once the deadline came during the flush, and hands out no viewer once it came during the host's answer", () =>
		owning(async (own) => {
			// The flush outlasted the deadline: nothing is asked, the record says nothing was opened, and the next one may start.
			const flushes = heldFlushes(own);
			const t = desk({ stored: empty(), host: launched, flush: flushes.flush });
			const starting = own.track(t.desk.launch());
			t.clock.now = NOW + LIFETIME;
			flushes.held[0]!.resolve();
			const late = await starting;
			expect(late.status).toBe(409);
			expect((await body(late)).viewer).toBeUndefined();
			expect(t.asked).toEqual([]);
			expect(t.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "not_opened" })]);

			// The host answered at the deadline: its launch is recorded, so it can still be ended and checked, but its credential goes to no one.
			const u = desk({
				stored: empty(),
				host: (asked) => {
					u.clock.now = NOW + LIFETIME;
					return launched(asked);
				},
			});
			const answered = await u.desk.launch();
			expect(answered.status).toBe(409);
			const text = await answered.text();
			expect(text).not.toContain(CREDENTIAL);
			expect(JSON.parse(text).viewer).toBeUndefined();
			expect(u.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "open", hostLaunchId: LAUNCH, hostGeneration: "gen-1" })]);
		}));

	it("leaves an observation that is still starting to finish when its end is asked for, and sends its launch once", () =>
		owning(async (own) => {
			const flushes = heldFlushes(own);
			const t = desk({ stored: empty(), host: launched, flush: flushes.flush });
			const starting = own.track(t.desk.launch());
			const stop = await t.desk.end(id(1));
			expect(stop.status).toBe(409);
			expect((await body(stop)).observation).toMatchObject({ id: id(1), status: "pending_open" });
			expect(t.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "pending_open" })]);
			expect(flushes.held).toHaveLength(1);
			flushes.held[0]!.resolve();
			expect((await starting).status).toBe(200);
			expect(t.asked).toHaveLength(1);
			expect(t.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "open", hostLaunchId: LAUNCH })]);
		}));

	it("gives up on a management answer that never comes or never ends within its bound, and holds the record unconfirmed", () =>
		owning(async (own) => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
			try {
				// A body that stops halfway: each pull, and its cancel, wait on gates held through the bounded result. Let go when the test ends,
				// a pull ends the stream, so nothing pulls again, and the cancel settles.
				const endless = () =>
					new ReadableStream<Uint8Array>({
						start: (controller) => controller.enqueue(new TextEncoder().encode('{"outcome":')),
						pull: (controller) =>
							own.gate(() => {
								try {
									controller.close();
								} catch {
									// Already cancelled: nothing to end.
								}
							}).promise,
						cancel: () => own.gate(() => undefined).promise,
					});

				// No answer: held until the test ends, then a late one, which the client lets go unread.
				const silent = desk({ stored: empty(), host: () => own.gate(() => new Response(null, { status: 500 })).promise, limits: { manageMs: 50 } });
				expect((await silent.desk.launch()).status).toBe(502);
				expect(silent.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "unconfirmed" })]);

				const halfway = desk({ stored: empty(), host: () => new Response(endless(), { headers: { "content-type": "application/json" } }), limits: { manageMs: 50 } });
				expect((await halfway.desk.launch()).status).toBe(502);
				expect(halfway.records()).toEqual([expect.objectContaining({ observationId: id(1), status: "unconfirmed" })]);
				const logged = errors.mock.calls.map(([line]) => String(line));
				expect(logged.filter((line) => line === JSON.stringify({ event: "cua.viewer.lost", action: "launch", reason: "timeout" }))).toHaveLength(2);

				// A read that stalls stops at its signal, and a cancel that hasn't settled is left after CLEANUP_MS, said to be unsettled.
				const stop = new AbortController();
				own.timeout(() => stop.abort(), 20);
				expect(await readBounded(endless(), 1024, stop.signal)).toEqual({ kind: "stopped", cleaned: false });
				expect(errors.mock.calls.map(([line]) => String(line))).toContain(JSON.stringify({ event: "cua.viewer.cleanup_unsettled", what: "body", outcome: "stopped" }));
			} finally {
				errors.mockRestore();
			}
		}));
});
