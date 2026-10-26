# Computer control state (unwired)

`src/computer-control.ts` is a pure reducer that keeps Pim's **application-level** record of who controls a space's shared computer, and decides whether to admit an agent request. Nothing calls it: it exposes no API, tool or UI, and it touches neither Sprites, the paired computer, approvals nor auth.

## Full-computer takeover is UNPROVEN

This module cannot stop the machine, and its tests do not show that anything stops. A takeover here only closes Pim's own admissions and invalidates the agent's lease; a command already sent may still be running, and nothing observes or halts it. `inputQuiescence` is always `"unproven"`, and restore refuses state that says otherwise.

**Decision: this module must never by itself authorize real human input, or be presented as proof the agent has stopped.** A future integration needs enforcement and quiescence that are established independently, with their own evidence and tests.

## What it models

- **Epoch and lease.** An epoch counts ownership changes; takeover and resume each start one. An agent request is admitted only with the current epoch and lease ID, while the agent owns the application and nothing blocks admission. Two agents may hold requests in one epoch, under distinct request IDs.
- **Takeover.** Owner becomes `human`, the lease is dropped, and requests already admitted stay `in_flight`: pending, not stopped. Late results are recorded on their own request and never change the owner, epoch or lease.
- **Viewers.** Viewer sessions are treated as input-capable; there is no read-only kind. A viewer can be requested only while the human owns the application, and only for the current epoch. Any viewer not reported revoked, in any epoch, keeps admissions closed.
- **Revocation attempts.** `viewer_revoke_requested` starts a numbered attempt (`revokeAttempt`); only an acknowledgment, success or failure, naming the attempt in progress counts. Correlation is per revocation: every attempt number is distinct, and the counter fails closed (`attempt_exhausted`, session stays unrevoked and admissions closed) rather than pass the last safe integer; the epoch counter does the same. A duplicate or delayed acknowledgment of an earlier attempt is refused as `stale_attempt`. An open acknowledged after a revocation, or during one, reopens the session and needs a new attempt. A late open can't be told from a duplicate one, so it is treated as the worse case.
- **Resume.** Starts a new epoch with a new lease, and is refused at the last safe integer epoch (takeover still closes admissions there, without a new epoch). Admissions reopen only when every viewer is revoked and no request from an earlier epoch is unresolved.
- **Outcomes.** A request ends `completed`, `rejected` (definitive), or `unknown`. Unknown blocks admissions until a `reconcile_request` event with evidence. There are no timers and nothing is deleted or replayed. A duplicate request ID is refused; that says nothing about whether the first ran, ran once, or ran at all. Deduplication here is not exactly-once execution.
- **Restore.** `restoreControlState` validates parsed JSON (version, shapes, epochs, lease consistency, unique IDs). Invalid input is refused and the caller must keep control closed; it never invents state. Reconciled requests must carry non-blank evidence, and an agent-owned state with a viewer of its own epoch is impossible and refused. Requests restored as `in_flight` become `unknown`, since the previous process may have died before or after sending them; restore also refuses impossible status and attempt pairs (`revoked` or `revoke_failed` with no attempt, `pending_open` after one); a viewer `revoking` becomes `revoke_failed`, so a pre-restart acknowledgment can't certify it. The default state is human-owned.

## What it cannot prove

- That a viewer was revoked, a request finished, or an operator's evidence is true: all of these are mocked or caller-reported inputs.
- That the machine received, ran, or stopped anything.
- Who the caller is or whether they belong to the space. Epochs, leases and session IDs are bookkeeping names, not credentials; authentication and membership remain Pim's existing checks.
- Persistence, atomicity or ordering of stored state: the caller must store each new state before acting on it, and must reject concurrent writers.

## Next review steps

Decide where state is stored and how writes are serialized; define the real viewer revocation and request cancellation evidence; design and separately verify enforcement and quiescence before any integration.

## Runtime wiring (opt-in, no public control)

`src/computer-control-runtime.ts` stores the state per space and gates the agent paths that reach the computer. It is wired into `src/pim.ts`, `src/computer.ts`, `src/extensions/files.ts` and `src/extensions/browser.ts`, and it changes nothing for a space that has not opted in: paired computers, Sprites and approvals behave as before.

- **Opt-in.** A space is opted in when it has a stored control document (`pim_meta` key `computer_control`). `Pim.control.enable()` writes one, with the human in control. No route, tool or setting calls it, so today only in-process code (the tests) can. There is no deployment-wide switch.
- **No takeover or resume is exposed.** `control.apply(event)` is the only transition and nothing public reaches it. **Human takeover remains unavailable while input quiescence is unproven**: a takeover event closes Pim's admissions, and does not stop the machine.
- **Serialized, durable.** Each transition reads, applies the reducer, and writes the whole document synchronously in the Durable Object's storage, so transitions never interleave. A request is stored as admitted before it is sent; if storing fails, nothing is sent.
- **Identity.** The request carries the space (the Durable Object's own name) and the agent the server knows the chat talks as (`#roleOf(session)`); the session comes from the approval or tool call, never from a client. A request naming another space is refused, and a stored document belonging to another space blocks.
- **Agent paths gated.** Approved `shell`, `file_delete`, `browser_click` and `browser_type` (checked when the approval is executed, after the decision), the file tools (`file_read`, `file_write`, ...) and the browser tools (`browser_open`, `browser_read`, `browser_screenshot`, `browser_close`, and the step of `browser_click` and `browser_type` that names the element before filing the approval). Each reaches the computer through `Computer.call` or the browser's DevTools connection, both of which report to the request's trace (see Browser below). Request IDs are `approval:<id>` and `call:<conversation>:<callId>`, so a replay of the same call is refused rather than sent again. A click or type call woken by its decision looks at the page again before returning, as a request of its own, `call:<conversation>:<callId>:resumed`.
- **Screenshots.** Taking the picture and writing it to the person's files are one request: a write sent and not answered leaves it `unknown`, even though the picture was taken.
- **Approvals keep their lease.** When an approval for a computer action is filed, the lease then held is remembered. At execution the lease must still be the current one, so a takeover, or a takeover and resume, before the decision refuses it. An approval filed while the human had control, or whose record is gone, is refused. Approval and permission checks still apply independently.
- **Settling.** What the request's calls did decides it: replied to (including a machine error reply) is `completed`; nothing left this process is `rejected`; sent and then timed out or disconnected is `unknown` and blocks until a `reconcile_request` event. A reply is a transport receipt, not proof of what the machine did or can still do.

### Browser: DevTools bookkeeping

The browser is driven by puppeteer over one DevTools connection per space (`Computer.connectBrowser`), which every agent and the person's live view share. `connectBrowser`'s transport keeps, per connection, which request waits for the answer to each message it sent:

- **Attribution at send time.** A message sent while an admitted request runs (the request's `AsyncLocalStorage` trace, not settled) is keyed by its DevTools `sessionId` and `id` and recorded in that request's trace as awaited. Only an incoming message with that key on that connection clears it; an answer with another ID or session, an event, or anything arriving after the connection ended clears nothing, and an answer arriving after the request was settled changes nothing. Two agents' requests on one connection are kept apart by their keys, not by which callback is running when an answer arrives.
- **Definitely unsent.** A request's message on a connection that was replaced or closed, or with the computer offline, throws before anything leaves, and is recorded for nobody. A request's message reusing a key still awaited also throws unsent, so its answer can't be confused with the first's. Without an admitted request (not opted in, or the person's own routes) these drop silently or are sent as before.
- **Ambiguous.** A message handed to the socket is awaited. If it is unanswered when the request ends (the connection closed, the computer disconnected, puppeteer's own timeout fired, or the request gave up), the request is `unknown`, even if other messages of it were answered: a partial answer settles nothing. A socket send that throws leaves the message awaited too.
- **Setup is not evidence.** The `browser_connect` call's answer and the DevTools handshake's answers count only for themselves; an action sent after them still needs its own answer.
- **Unattributed messages.** Puppeteer sends some messages on its own, from what it hears from the browser (attaching new targets), and the person's live view sends theirs; neither runs inside an admitted request. Such a message is awaited by every unsettled request that has already sent on the connection, so a request can be made `unknown` by one of them going unanswered, never `completed` by it. A message without a numeric ID, or an unattributed one reusing an awaited key, makes those requests uncertain. While no admitted request is using the connection (as always in a space that hasn't opted in), nothing is recorded and messages are not parsed.
- **Replies are receipts.** A DevTools answer, protocol errors included, says the browser processed the message. It says nothing about what the page did after (navigations, form submissions), or that nothing else is driving it.
- **Limits.** The trace follows `AsyncLocalStorage` through puppeteer's promise chains; code puppeteer runs from timers or listeners registered by an earlier request, after that request settled, is treated as unattributed. Puppeteer's protocol timeout is 180 s, so an action whose message goes unanswered on a connection that stays open holds its tool call that long before it settles `unknown`. Messages are counted, not interpreted: the state does not know which were input.
- **Storage failure latches.** If any change can't be stored (an admission, a settlement, a transition), the coordinator refuses everything for the rest of its life, even if storage returns: what is stored and what is remembered may disagree. A restart reads the stored state, where a request still in flight is `unknown`.
- **Restart.** The coordinator restores conservatively on load (in flight becomes unknown, revoking becomes failed) and writes that back; if that write fails, it is latched too. Stored lease bindings that repeat, have negative, fractional or future epochs, contradict the current lease, or exceed the cap block the document. A damaged, unknown-version or other-space document blocks all requests and is left untouched; nothing resets it.
- **No fallback.** An opted-in space whose control refuses does not use another computer.

### Interfaces for the next stages

- **Viewer stage:** feeds `control.apply({ type: "viewer_open_requested" | "viewer_opened" | "viewer_revoke_requested" | "viewer_revoked" | "viewer_revoke_failed", ... })` from real revocation evidence, with the attempt number from the state. No acknowledgment may be invented.
- **Provider stage:** decides when a space is opted in and what computer it uses, and is the only caller of `enable`, `resume` and `takeover`, which it may expose only once enforcement and quiescence are independently established.

### Open issues

- **Person's paths:** the person's own `/files` routes, the browser routes (`/browser`, its screenshot and close) and the live browser view do not pass the gate: they are the person's requests, not an agent's. **The live view ("Take over") is not a coordinated takeover**: it is not admitted, it sends input to the browser while the state may say the agent holds the lease, and its messages only ever make agent requests more uncertain. For an opted-in space, agents' browser tools no longer tell them to ask the person to take over; this is fixed when the tools are installed (pairing a computer, a permission or approval policy change, a restart), so whatever calls `enable` must reinstall them. The app still shows Take over; the viewer stage owns that.
- **Re-describing on resume:** a click or type call woken by its decision names the element again (as before for spaces that haven't opted in). Under control state that is a request of its own, and if it is refused (the person took over since) the call returns the refusal rather than the approval's result, which stays on the approval.
- A damaged document has no repair path; that needs an operator procedure.
- Approvals keep at most 256 lease bindings; older ones fail closed.
- A latched coordinator stays blocked until the process restarts; there is no in-process recovery by design.
- Full-computer takeover is unproven.
