import { describe, expect, it } from "vitest";
import { admissionBlockers, applyControlEvent, type ControlState, initialControlState } from "../src/computer-control";
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
