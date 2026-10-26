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

	const open = (sessionId: string, epoch: number): ControlEvent[] => [{ type: "viewer_open_requested", sessionId, epoch }, { type: "viewer_opened", sessionId }];
	const revoke = (sessionId: string): ControlEvent => ({ type: "viewer_revoke_requested", sessionId });
	const acked = (sessionId: string, attempt: number): ControlEvent => ({ type: "viewer_revoked", sessionId, attempt });
	const failed = (sessionId: string, attempt: number): ControlEvent => ({ type: "viewer_revoke_failed", sessionId, attempt });
	const BLOCKED = { ok: false, reason: "blocked" };

	it("blocks admissions after resume until every viewer session is revoked by its own attempt", () => {
		const state = ok(initialControlState(), ...open("v1", 0), { type: "viewer_open_requested", sessionId: "v2", epoch: 0 }, { type: "resume", leaseId: "L1" });
		expect(refusal(state, admit("r1"))).toEqual(BLOCKED);
		// An acknowledgment with no attempt in progress, or of the wrong one, is refused.
		expect(refusal(state, acked("v1", 1))).toEqual({ ok: false, reason: "stale_attempt" });
		const one = ok(state, revoke("v1"), acked("v1", 1));
		expect(refusal(one, admit("r1"))).toEqual(BLOCKED);
		ok(one, revoke("v2"), acked("v2", 1), admit("r1"));
	});

	it("admits viewer requests only while the human owns the application, in the current epoch", () => {
		const agent = agentOwned();
		expect(refusal(agent, { type: "viewer_open_requested", sessionId: "v1", epoch: 1 })).toEqual({ ok: false, reason: "wrong_owner" });
		const human = ok(agent, { type: "takeover" });
		expect(refusal(human, { type: "viewer_open_requested", sessionId: "v1", epoch: 1 })).toEqual({ ok: false, reason: "epoch_mismatch" });
		expect(refusal(initialControlState(), { type: "viewer_open_requested", sessionId: "", epoch: 0 })).toEqual({ ok: false, reason: "empty_value" });
		// The viewer opened under the old human epoch can't be minted again under the agent's.
		const resumedAgain = ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" }, revoke("v1"), acked("v1", 1));
		expect(refusal(resumedAgain, { type: "viewer_open_requested", sessionId: "v2", epoch: 0 })).toEqual({ ok: false, reason: "wrong_owner" });
		ok(resumedAgain, admit("r1"));
	});

	it("keeps a pending or open viewer fencing admissions in the same epoch too", () => {
		const state = ok(initialControlState(), { type: "viewer_open_requested", sessionId: "v1", epoch: 0 });
		expect(admissionBlockers(state)).toContain("human owns the application");
		expect(admissionBlockers(state)).toContain("viewer v1 not revoked");
		const opened = ok(state, { type: "viewer_opened", sessionId: "v1" });
		expect(admissionBlockers(opened)).toContain("viewer v1 not revoked");
	});

	it("stays blocked when a revocation fails, until a new attempt is acknowledged", () => {
		const state = ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" }, revoke("v1"), failed("v1", 1));
		expect(state.viewers[0]?.status).toBe("revoke_failed");
		expect(refusal(state, admit("r1"))).toEqual(BLOCKED);
		// The failed attempt's own acknowledgment can't be reused, nor can it be repeated.
		expect(refusal(state, acked("v1", 1))).toEqual({ ok: false, reason: "stale_attempt" });
		const retry = ok(state, revoke("v1"));
		expect(retry.viewers[0]?.revokeAttempt).toBe(2);
		expect(refusal(retry, acked("v1", 1))).toEqual({ ok: false, reason: "stale_attempt" });
		ok(retry, acked("v1", 2), admit("r1"));
	});

	it("does not let a duplicate or delayed acknowledgment certify a later open", () => {
		const revoked = ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" }, revoke("v1"), acked("v1", 1));
		ok(revoked, admit("r1"));
		// The open arrives late: the session is open again and admissions close.
		const late = ok(revoked, { type: "viewer_opened", sessionId: "v1" });
		expect(refusal(late, admit("r2"))).toEqual(BLOCKED);
		// A repeat of the earlier acknowledgment clears nothing.
		expect(refusal(late, acked("v1", 1))).toEqual({ ok: false, reason: "stale_attempt" });
		expect(refusal(late, admit("r2"))).toEqual(BLOCKED);
		// An open landing during a revocation voids that attempt.
		const mid = ok(late, revoke("v1"), { type: "viewer_opened", sessionId: "v1" });
		expect(refusal(mid, acked("v1", 2))).toEqual({ ok: false, reason: "stale_attempt" });
		const fresh = ok(mid, revoke("v1"), acked("v1", 3));
		ok(fresh, admit("r2"));
		// A delayed acknowledgment of attempt 1 or 2 after attempt 3 still changes nothing.
		expect(refusal(fresh, acked("v1", 1))).toEqual({ ok: false, reason: "stale_attempt" });
		expect(refusal(fresh, revoke("v1"))).toEqual({ ok: false, reason: "already_final" });
	});

	it("refuses acknowledgments for sessions it never saw, and reused session IDs", () => {
		const state = ok(initialControlState(), { type: "viewer_open_requested", sessionId: "v1", epoch: 0 });
		expect(refusal(state, { type: "viewer_opened", sessionId: "ghost" })).toEqual({ ok: false, reason: "unknown_id" });
		expect(refusal(state, revoke("ghost"))).toEqual({ ok: false, reason: "unknown_id" });
		expect(refusal(state, acked("ghost", 1))).toEqual({ ok: false, reason: "unknown_id" });
		expect(refusal(state, { type: "viewer_open_requested", sessionId: "v1", epoch: 0 })).toEqual({ ok: false, reason: "duplicate_id" });
	});

	it("fails closed rather than reuse a revocation attempt number at the last safe integer", () => {
		const base = JSON.parse(JSON.stringify(ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" })));
		const at = (revokeAttempt: number, status = "open") => {
			const restored = restoreControlState({ ...base, viewers: [{ ...base.viewers[0], status, revokeAttempt }] });
			if (!restored.ok) throw new Error(restored.error);
			return restored.state;
		};
		const max = Number.MAX_SAFE_INTEGER;
		const last = ok(at(max - 1), revoke("v1"));
		expect(last.viewers[0]).toMatchObject({ status: "revoking", revokeAttempt: max });
		expect(refusal(last, acked("v1", max - 1))).toEqual({ ok: false, reason: "stale_attempt" });
		const exhausted = ok(last, failed("v1", max));
		expect(refusal(exhausted, revoke("v1"))).toEqual({ ok: false, reason: "attempt_exhausted" });
		expect(refusal(at(max), revoke("v1"))).toEqual({ ok: false, reason: "attempt_exhausted" });
		// A stale acknowledgment can't clear it either, and admissions stay closed.
		expect(refusal(exhausted, acked("v1", max))).toEqual({ ok: false, reason: "stale_attempt" });
		expect(refusal(exhausted, admit("r1"))).toEqual(BLOCKED);
		ok(last, acked("v1", max), admit("r1"));
	});

	it("takes over without a new epoch at the last safe one, and refuses to resume there", () => {
		const restored = restoreControlState({ ...JSON.parse(JSON.stringify(agentOwned())), epoch: Number.MAX_SAFE_INTEGER, lease: { epoch: Number.MAX_SAFE_INTEGER, leaseId: "L" } });
		if (!restored.ok) throw new Error(restored.error);
		const taken = ok(restored.state, { type: "takeover" });
		expect([taken.owner, taken.lease, taken.epoch]).toEqual(["human", null, Number.MAX_SAFE_INTEGER]);
		expect(refusal(taken, { type: "resume", leaseId: "L2" })).toEqual({ ok: false, reason: "epoch_exhausted" });
	});

	it("refuses to resume when the agent already owns the application, and empty IDs", () => {
		expect(refusal(agentOwned(), { type: "resume", leaseId: "L2" })).toEqual({ ok: false, reason: "wrong_owner" });
		expect(refusal(initialControlState(), { type: "resume", leaseId: "" })).toEqual({ ok: false, reason: "empty_value" });
	});

	describe("restore", () => {
		const roundTrip = (state: ControlState) => restoreControlState(JSON.parse(JSON.stringify(state)));

		it("restores a settled state exactly", () => {
			const state = ok(agentOwned(), admit("r1"), { type: "request_result", requestId: "r1", epoch: 1, outcome: "completed" }, { type: "takeover" }, { type: "viewer_open_requested", sessionId: "v1", epoch: 2 });
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
			const resuming = roundTrip(ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" }));
			if (!resuming.ok) throw new Error(resuming.error);
			expect(refusal(resuming.state, admit("r1"))).toEqual(BLOCKED);
		});

		it("restores a revocation in progress as failed, so an acknowledgment from before the restart is refused", () => {
			const restored = roundTrip(ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" }, revoke("v1")));
			if (!restored.ok) throw new Error(restored.error);
			expect(restored.state.viewers[0]?.status).toBe("revoke_failed");
			expect(refusal(restored.state, acked("v1", 1))).toEqual({ ok: false, reason: "stale_attempt" });
			expect(refusal(restored.state, admit("r1"))).toEqual(BLOCKED);
			ok(restored.state, revoke("v1"), acked("v1", 2), admit("r1"));
		});

		it("refuses malformed, unversioned, future-versioned and inconsistent state", () => {
			const good = JSON.parse(JSON.stringify(ok(initialControlState(), ...open("v1", 0), { type: "resume", leaseId: "L1" }, revoke("v1"), acked("v1", 1), admit("r1"))));
			const reconciled = JSON.parse(JSON.stringify(ok(agentOwned(), admit("r1"), { type: "request_result", requestId: "r1", epoch: 1, outcome: "unknown" }, { type: "reconcile_request", requestId: "r1", resolution: "completed", evidence: "seen" })));
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
				"unrevoked viewer of the agent's epoch": { ...good, viewers: [{ ...good.viewers[0], epoch: 1 }] },
				"missing revoke attempt": { ...good, viewers: [{ ...good.viewers[0], revokeAttempt: undefined }] },
				"revoked without an attempt": { ...good, viewers: [{ ...good.viewers[0], status: "revoked", revokeAttempt: 0 }] },
				"revoke_failed without an attempt": { ...good, viewers: [{ ...good.viewers[0], status: "revoke_failed", revokeAttempt: 0 }] },
				"pending_open after an attempt": { ...good, viewers: [{ ...good.viewers[0], status: "pending_open", revokeAttempt: 1 }] },
				"fractional attempt": { ...good, viewers: [{ ...good.viewers[0], revokeAttempt: 1.5 }] },
				"revoking without an attempt": { ...good, viewers: [{ ...good.viewers[0], status: "revoking", revokeAttempt: 0 }] },
				"reconciled without evidence": { ...reconciled, requests: [{ ...reconciled.requests[0], evidence: undefined }] },
				"reconciled with blank evidence": { ...reconciled, requests: [{ ...reconciled.requests[0], evidence: "  " }] },
				"reconciled with non-string evidence": { ...reconciled, requests: [{ ...reconciled.requests[0], evidence: 3 }] },
				"duplicate viewer": { ...good, viewers: [good.viewers[0], good.viewers[0]] },
			};
			for (const [name, raw] of Object.entries(bad)) expect(restoreControlState(raw), name).toMatchObject({ ok: false });
			expect(restoreControlState(good)).toMatchObject({ ok: true });
			expect(restoreControlState(reconciled)).toMatchObject({ ok: true });
		});
	});
});
