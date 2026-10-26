import { describe, expect, it } from "vitest";
import { admissionBlockers, applyControlEvent, type ControlEvent, type ControlState, initialControlState, restoreControlState } from "../src/computer-control";

/** Applies events in order, expecting each to be accepted. */
const ok = (state: ControlState, ...events: ControlEvent[]) => {
	let current = state;
	for (const event of events) {
		const result = applyControlEvent(current, event);
		expect(result.outcome, JSON.stringify(event)).toEqual({ ok: true });
		current = result.state;
	}
	return current;
};
const refusal = (state: ControlState, event: ControlEvent) => {
	const result = applyControlEvent(state, event);
	expect(result.state).toBe(state);
	return result.outcome;
};

const lease1 = { epoch: 1, leaseId: "L1" };
const admit = (requestId: string, agentId = "a", lease = lease1): ControlEvent => ({ type: "admit", requestId, agentId, lease });
const agentOwned = () => ok(initialControlState(), { type: "resume", leaseId: "L1" });
/** The state after agent control is taken over and handed back, with no viewers: epoch 3. */
const resumed = (state: ControlState) => ok(state, { type: "takeover" }, { type: "resume", leaseId: "L3" });

describe("computer control state", () => {
	it("starts with the human in control and never grants the agent control by default", () => {
		const state = initialControlState();
		expect(state.owner).toBe("human");
		expect(state.inputQuiescence).toBe("unproven");
		expect(refusal(state, admit("r1", "a", { epoch: 0, leaseId: "" }))).toEqual({ ok: false, reason: "empty_value" });
		expect(refusal(state, admit("r1", "a", { epoch: 0, leaseId: "x" }))).toEqual({ ok: false, reason: "not_agent_owned" });
	});

	it("admits two agents in one epoch under distinct request IDs and refuses a duplicate ID from either", () => {
		const state = ok(agentOwned(), admit("r1", "a"), admit("r2", "b"));
		expect(state.requests.map((request) => [request.requestId, request.agentId, request.status])).toEqual([["r1", "a", "in_flight"], ["r2", "b", "in_flight"]]);
		expect(refusal(state, admit("r1", "a"))).toEqual({ ok: false, reason: "duplicate_id" });
		expect(refusal(state, admit("r2", "a"))).toEqual({ ok: false, reason: "duplicate_id" });
		expect(refusal(state, admit("r3", "a", { epoch: 1, leaseId: "other" }))).toEqual({ ok: false, reason: "stale_lease" });
	});

	it("keeps a duplicate ID refused after the first request finishes, and does not re-admit it", () => {
		const state = ok(agentOwned(), admit("r1"), { type: "request_result", requestId: "r1", epoch: 1, outcome: "completed" });
		expect(refusal(state, admit("r1"))).toEqual({ ok: false, reason: "duplicate_id" });
	});

	it("takes over immediately: the lease is invalid, admissions close, and pending work stays pending", () => {
		const state = ok(agentOwned(), admit("r1"), { type: "takeover" });
		expect(state.owner).toBe("human");
		expect(state.lease).toBeNull();
		expect(state.inputQuiescence).toBe("unproven");
		// Not marked stopped, finished or failed: nothing here knows.
		expect(state.requests[0]?.status).toBe("in_flight");
		expect(refusal(state, admit("r2"))).toEqual({ ok: false, reason: "not_agent_owned" });
		expect(admissionBlockers(state)).toContain("human owns the application");
	});

	it("takes over twice without a new epoch", () => {
		const once = ok(agentOwned(), { type: "takeover" });
		expect(ok(once, { type: "takeover" })).toBe(once);
	});

	it("records a rejection or a completion after takeover against its own epoch only", () => {
		const taken = ok(agentOwned(), admit("r1"), admit("r2"), { type: "takeover" });
		const state = ok(taken, { type: "request_result", requestId: "r1", epoch: 1, outcome: "rejected" }, { type: "request_result", requestId: "r2", epoch: 1, outcome: "completed" });
		expect(state.requests.map((request) => request.status)).toEqual(["rejected", "completed"]);
		expect([state.epoch, state.owner, state.lease]).toEqual([taken.epoch, "human", null]);
	});

	it("ignores a stale finish: wrong epoch, repeated, or for an unknown request", () => {
		const state = ok(agentOwned(), admit("r1"), { type: "request_result", requestId: "r1", epoch: 1, outcome: "completed" });
		expect(refusal(state, { type: "request_result", requestId: "r1", epoch: 1, outcome: "rejected" })).toEqual({ ok: false, reason: "already_final" });
		const pending = ok(agentOwned(), admit("r1"));
		expect(refusal(pending, { type: "request_result", requestId: "r1", epoch: 2, outcome: "completed" })).toEqual({ ok: false, reason: "epoch_mismatch" });
		expect(refusal(pending, { type: "request_result", requestId: "nope", epoch: 1, outcome: "completed" })).toEqual({ ok: false, reason: "unknown_id" });
	});

	it("keeps an old request's late finish from changing a later epoch, and the old lease from admitting in it", () => {
		const later = resumed(ok(agentOwned(), admit("r1")));
		// r1 is unresolved from epoch 1, so epoch 3 stays closed even for the current lease.
		expect(refusal(later, admit("r2", "a", { epoch: 3, leaseId: "L3" }))).toEqual({ ok: false, reason: "blocked" });
		expect(refusal(later, admit("r2"))).toEqual({ ok: false, reason: "stale_lease" });
		const finished = ok(later, { type: "request_result", requestId: "r1", epoch: 1, outcome: "completed" });
		expect([finished.epoch, finished.owner, finished.lease]).toEqual([3, "agent", { epoch: 3, leaseId: "L3" }]);
		ok(finished, admit("r2", "a", { epoch: 3, leaseId: "L3" }));
	});

	it("blocks on an unknown outcome until explicit reconciliation, and a later result does not clear it", () => {
		const state = ok(agentOwned(), admit("r1"), { type: "request_result", requestId: "r1", epoch: 1, outcome: "unknown" });
		expect(state.requests[0]?.status).toBe("unknown");
		expect(refusal(state, admit("r2"))).toEqual({ ok: false, reason: "blocked" });
		expect(refusal(state, { type: "request_result", requestId: "r1", epoch: 1, outcome: "completed" })).toEqual({ ok: false, reason: "already_final" });
		expect(refusal(state, { type: "reconcile_request", requestId: "r1", resolution: "not_executed", evidence: "  " })).toEqual({ ok: false, reason: "empty_value" });
		const reconciled = ok(state, { type: "reconcile_request", requestId: "r1", resolution: "not_executed", evidence: "operator saw no effect" });
		expect(reconciled.requests[0]).toMatchObject({ status: "reconciled_not_executed", evidence: "operator saw no effect" });
		ok(reconciled, admit("r2"));
		// The ID stays used: reconciling never re-runs or re-admits anything.
		expect(refusal(reconciled, admit("r1"))).toEqual({ ok: false, reason: "duplicate_id" });
		expect(refusal(reconciled, { type: "reconcile_request", requestId: "r1", resolution: "completed", evidence: "later" })).toEqual({ ok: false, reason: "already_final" });
	});

	it("blocks resume's admissions until every viewer session of an earlier epoch is revoked", () => {
		const base = ok(agentOwned(), { type: "viewer_open_requested", sessionId: "v1" }, { type: "viewer_open_requested", sessionId: "v2" }, { type: "viewer_opened", sessionId: "v1" }, { type: "takeover" });
		const state = ok(base, { type: "resume", leaseId: "L3" });
		const lease3 = { epoch: 3, leaseId: "L3" };
		expect(refusal(state, admit("r1", "a", lease3))).toEqual({ ok: false, reason: "blocked" });
		const one = ok(state, { type: "viewer_revoked", sessionId: "v1" });
		expect(refusal(one, admit("r1", "a", lease3))).toEqual({ ok: false, reason: "blocked" });
		ok(one, { type: "viewer_revoked", sessionId: "v2" }, admit("r1", "a", lease3));
	});

	it("stays blocked when a viewer's revocation fails, until it is later revoked", () => {
		const lease3 = { epoch: 3, leaseId: "L3" };
		const state = ok(agentOwned(), { type: "viewer_open_requested", sessionId: "v1" }, { type: "viewer_opened", sessionId: "v1" }, { type: "takeover" }, { type: "resume", leaseId: "L3" }, { type: "viewer_revoke_failed", sessionId: "v1" });
		expect(refusal(state, admit("r1", "a", lease3))).toEqual({ ok: false, reason: "blocked" });
		ok(state, { type: "viewer_revoked", sessionId: "v1" }, admit("r1", "a", lease3));
	});

	it("treats a viewer that opens late, after its revocation, as open again and blocked", () => {
		const lease3 = { epoch: 3, leaseId: "L3" };
		const pending = ok(agentOwned(), { type: "viewer_open_requested", sessionId: "v1" }, { type: "takeover" }, { type: "resume", leaseId: "L3" });
		const revoked = ok(pending, { type: "viewer_revoked", sessionId: "v1" });
		ok(revoked, admit("r1", "a", lease3));
		const late = ok(revoked, { type: "viewer_opened", sessionId: "v1" });
		expect(late.viewers[0]?.status).toBe("open");
		expect(refusal(late, admit("r1", "a", lease3))).toEqual({ ok: false, reason: "blocked" });
		// A reconnect under a new session ID in the new epoch is a new session, and does not block.
		const fresh = ok(revoked, { type: "viewer_open_requested", sessionId: "v2" }, { type: "viewer_opened", sessionId: "v2" });
		ok(fresh, admit("r1", "a", lease3));
	});

	it("refuses acknowledgments for sessions it never saw, and reused session IDs", () => {
		const state = ok(agentOwned(), { type: "viewer_open_requested", sessionId: "v1" });
		expect(refusal(state, { type: "viewer_opened", sessionId: "ghost" })).toEqual({ ok: false, reason: "unknown_id" });
		expect(refusal(state, { type: "viewer_revoked", sessionId: "ghost" })).toEqual({ ok: false, reason: "unknown_id" });
		expect(refusal(state, { type: "viewer_open_requested", sessionId: "v1" })).toEqual({ ok: false, reason: "duplicate_id" });
	});

	it("refuses to resume when the agent already owns the application, and empty IDs", () => {
		expect(refusal(agentOwned(), { type: "resume", leaseId: "L2" })).toEqual({ ok: false, reason: "wrong_owner" });
		expect(refusal(initialControlState(), { type: "resume", leaseId: "" })).toEqual({ ok: false, reason: "empty_value" });
	});

	describe("restore", () => {
		const roundTrip = (state: ControlState) => restoreControlState(JSON.parse(JSON.stringify(state)));

		it("restores a settled state exactly", () => {
			const state = ok(agentOwned(), admit("r1"), { type: "request_result", requestId: "r1", epoch: 1, outcome: "completed" }, { type: "viewer_open_requested", sessionId: "v1" });
			expect(roundTrip(state)).toEqual({ ok: true, state });
		});

		it("restores a request caught mid-dispatch as unknown, blocked, and not replayed", () => {
			const state = ok(agentOwned(), admit("r1"));
			const restored = roundTrip(state);
			if (!restored.ok) throw new Error(restored.error);
			expect(restored.state.requests[0]?.status).toBe("unknown");
			expect(refusal(restored.state, admit("r2"))).toEqual({ ok: false, reason: "blocked" });
			expect(refusal(restored.state, admit("r1"))).toEqual({ ok: false, reason: "duplicate_id" });
		});

		it("restores mid-takeover as human-owned and mid-resume with viewers still unrevoked", () => {
			const taken = roundTrip(ok(agentOwned(), admit("r1"), { type: "takeover" }));
			if (!taken.ok) throw new Error(taken.error);
			expect(taken.state.owner).toBe("human");
			expect(taken.state.requests[0]?.status).toBe("unknown");
			const resuming = roundTrip(ok(agentOwned(), { type: "viewer_open_requested", sessionId: "v1" }, { type: "takeover" }, { type: "resume", leaseId: "L3" }));
			if (!resuming.ok) throw new Error(resuming.error);
			expect(refusal(resuming.state, admit("r1", "a", { epoch: 3, leaseId: "L3" }))).toEqual({ ok: false, reason: "blocked" });
		});

		it("refuses malformed, unversioned, future-versioned and inconsistent state", () => {
			const good = JSON.parse(JSON.stringify(ok(agentOwned(), admit("r1"), { type: "viewer_open_requested", sessionId: "v1" })));
			const bad: Record<string, unknown> = {
				"null": null,
				"array": [],
				"string": "agent",
				"no version": { ...good, version: undefined },
				"future version": { ...good, version: 2 },
				"negative epoch": { ...good, epoch: -1 },
				"fractional epoch": { ...good, epoch: 1.5 },
				"unknown owner": { ...good, owner: "both" },
				"quiescence claimed": { ...good, inputQuiescence: "proven" },
				"agent without lease": { ...good, lease: null },
				"lease of another epoch": { ...good, lease: { epoch: 0, leaseId: "L1" } },
				"human with lease": { ...good, owner: "human" },
				"requests not array": { ...good, requests: {} },
				"unknown request status": { ...good, requests: [{ ...good.requests[0], status: "running" }] },
				"request from the future": { ...good, requests: [{ ...good.requests[0], epoch: 9 }] },
				"duplicate request": { ...good, requests: [good.requests[0], good.requests[0]] },
				"empty agent": { ...good, requests: [{ ...good.requests[0], agentId: "" }] },
				"unknown viewer status": { ...good, viewers: [{ ...good.viewers[0], status: "closed" }] },
				"duplicate viewer": { ...good, viewers: [good.viewers[0], good.viewers[0]] },
			};
			for (const [name, raw] of Object.entries(bad)) expect(restoreControlState(raw), name).toMatchObject({ ok: false });
			expect(restoreControlState(good)).toMatchObject({ ok: true });
		});
	});
});
