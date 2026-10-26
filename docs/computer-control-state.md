# Computer control state (unwired)

`src/computer-control.ts` is a pure reducer that keeps Pim's **application-level** record of who controls a space's shared computer, and decides whether to admit an agent request. Nothing calls it: it exposes no API, tool or UI, and it touches neither Sprites, the paired computer, approvals nor auth.

## Full-computer takeover is UNPROVEN

This module cannot stop the machine, and its tests do not show that anything stops. A takeover here only closes Pim's own admissions and invalidates the agent's lease; a command already sent may still be running, and nothing observes or halts it. `inputQuiescence` is always `"unproven"`, and restore refuses state that says otherwise.

**Decision: this module must never by itself authorize real human input, or be presented as proof the agent has stopped.** A future integration needs enforcement and quiescence that are established independently, with their own evidence and tests.

## What it models

- **Epoch and lease.** An epoch counts ownership changes; takeover and resume each start one. An agent request is admitted only with the current epoch and lease ID, while the agent owns the application and nothing blocks admission. Two agents may hold requests in one epoch, under distinct request IDs.
- **Takeover.** Owner becomes `human`, the lease is dropped, and requests already admitted stay `in_flight`: pending, not stopped. Late results are recorded on their own request and never change the owner, epoch or lease.
- **Viewers.** Viewer sessions are treated as input-capable; there is no read-only kind. A viewer can be requested only while the human owns the application, and only for the current epoch. Any viewer not reported revoked, in any epoch, keeps admissions closed.
- **Revocation attempts.** `viewer_revoke_requested` starts a numbered attempt (`revokeAttempt`); only an acknowledgment, success or failure, naming the attempt in progress counts. A duplicate or delayed acknowledgment of an earlier attempt is refused as `stale_attempt`. An open acknowledged after a revocation, or during one, reopens the session and needs a new attempt. A late open can't be told from a duplicate one, so it is treated as the worse case.
- **Resume.** Starts a new epoch with a new lease, and is refused at the last safe integer epoch (takeover still closes admissions there, without a new epoch). Admissions reopen only when every viewer is revoked and no request from an earlier epoch is unresolved.
- **Outcomes.** A request ends `completed`, `rejected` (definitive), or `unknown`. Unknown blocks admissions until a `reconcile_request` event with evidence. There are no timers and nothing is deleted or replayed. A duplicate request ID is refused; that says nothing about whether the first ran, ran once, or ran at all. Deduplication here is not exactly-once execution.
- **Restore.** `restoreControlState` validates parsed JSON (version, shapes, epochs, lease consistency, unique IDs). Invalid input is refused and the caller must keep control closed; it never invents state. Reconciled requests must carry non-blank evidence, and an agent-owned state with a viewer of its own epoch is impossible and refused. Requests restored as `in_flight` become `unknown`, since the previous process may have died before or after sending them; a viewer `revoking` becomes `revoke_failed`, so a pre-restart acknowledgment can't certify it. The default state is human-owned.

## What it cannot prove

- That a viewer was revoked, a request finished, or an operator's evidence is true: all of these are mocked or caller-reported inputs.
- That the machine received, ran, or stopped anything.
- Who the caller is or whether they belong to the space. Epochs, leases and session IDs are bookkeeping names, not credentials; authentication and membership remain Pim's existing checks.
- Persistence, atomicity or ordering of stored state: the caller must store each new state before acting on it, and must reject concurrent writers.

## Next review steps

Decide where state is stored and how writes are serialized; define the real viewer revocation and request cancellation evidence; design and separately verify enforcement and quiescence before any integration.
