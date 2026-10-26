# Cua computers through an operator's bridge (unwired)

`src/cua.ts` connects a space to pim-computer on a Cua VM through a bridge the operator runs. **Nothing in Pim calls it yet**: no route, tool, setting or wake path selects it, and it never turns on, takes over or resumes the control state (`docs/computer-control-state.md`). Paired computers and Sprites behave as before, and so do the UI, approvals and file permissions. Its tests use a `fetch` they give it, answered in the same process; none reaches the network.

## What the space talks to

A space's computer is reached through a `ComputerLink` (`src/computer.ts`): one of pim-computer's JSON messages at a time, both ways, which `Computer` reads and writes as it does for a paired computer or a Sprite. `Sprites.connect` makes one over the Sprites exec API, with each message a line of `pim-computer --stdio`'s input or output; `Cua.connect` makes one over the bridge's WebSocket, with each message a text message. `Computer` keeps its tracing as it was: a call is settled by its reply, a DevTools message by its answer, and anything sent and not answered when the link ends is unknown and never sent again.

The model is one persistent VM per space, where pim-computer runs as one non-root desktop user that every agent of the space shares. Agents are not isolated from each other on it, and Pim makes no claim that they are. `/workspace` is where the space's files are kept, which file calls stay inside; it is not a sandbox. A command runs as the desktop user and reaches whatever that user can.

## The bridge's contract

Pim does not assume Cua's own services speak pim-computer's protocol. The operator runs something that does, in front of the VM, and gives Pim, for one space, a `CuaBridge`: the space's owner ID, the bridge's address, and its bearer token. The bridge must:

1. **Serve HTTPS** at an address with no credentials, query or fragment (no `?` or `#` at all), and take a WebSocket upgrade there (`GET`, `Upgrade: websocket`).
2. **Authenticate the request** by `Authorization: Bearer <token>`, comparing in constant time, and refuse anything else before upgrading. The token is printable ASCII without spaces, 32 to 4096 characters.
3. **Bind to one space.** Pim sends the space in `x-pim-space`. The bridge must refuse a space that isn't the one its VM belongs to, and name the space back in `x-pim-space` on its `101` response; Pim closes a connection that doesn't.
4. **Not redirect.** Pim follows no redirect, so its token never goes to another address; a `3xx` is a failure.
5. **Carry pim-computer's messages unchanged**, one JSON message per text message, both ways: first the `hello` pim-computer sends, then `call` and `reply`, `cdp` and `cdp_closed`. Binary messages and messages over 16 Mi characters (`MAX_MESSAGE_CHARS`) end the connection; text that isn't JSON is ignored. One way to do it is to start `pim-computer --stdio --root <folder>` as the desktop user for each connection and relay each message as a line.
6. **Hold nothing back for later.** The bridge must not queue messages across connections or replay them on a new one, or answer for pim-computer: a reply must be pim-computer's own. When Pim closes the connection, the bridge ends pim-computer's input, so it quits the browser (saving what's signed in there) and exits, as on a Sprite. If the connection drops, what was in flight may or may not have run; Pim treats it so.
7. **Take one connection at a time per space.** A new connection replaces the old one, which the bridge closes.

Pim's side keeps to its own part: it checks the space, address and token before it reaches the network; puts the token only in the `Authorization` header and never in errors, logs or the space's storage; logs only fixed event names and statuses, never what a failing `fetch` threw; makes one request per connection, aborts it after 30 seconds (`CONNECT_MS`) and closes any socket answered after that unused, and retries nothing, neither the connection nor a message; refuses a message it can't send whole, and anything after the connection ends, by throwing before it leaves; ends the link and tries to close its socket on a socket error, taking nothing from it after, even if the close throws; and calls `closed` once, however the connection ends. A closed socket, like a socket error, says nothing of what the computer did or stopped doing. A message the bridge took is a transport receipt, not a result.

## What is not done

- **Selecting a provider.** Which spaces use a Cua bridge, where the operator's `CuaBridge` comes from (a Worker secret per space, or a binding to an operator service), and wiring `Cua.connect` into `Computer`'s wake in `src/pim.ts` are the next stage. A space that selects Cua must not fall back to Sprites or a paired computer when it fails. Today `Computer.started` forgets any paired computer's token, which keeps one out, and the caller must keep it so.
- **Lifecycle.** Starting, stopping, sleeping and deleting the VM are the operator's; this link only connects and lets go. Removing a space's computer does not remove a Cua VM.
- **The bridge itself** is not in this repository, and nothing here has run against a real one or a real Cua VM. That Workers expose the `101` response's `x-pim-space` header to `fetch` is assumed from the platform, not tested against it; if they don't, every connection is refused.
- **Versions.** A Sprite fetches pim-computer from its Pim each time it starts; the bridge's operator must keep its copy in step.
- **Control and takeover.** A Cua VM is a whole desktop. Nothing here shows that a person's input there is quiescent or exclusive, so human takeover stays unavailable, as in `docs/computer-control-state.md`. Local transport tests say nothing about what else drives the VM.
