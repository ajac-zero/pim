# Cua computers through an operator's bridge

`src/cua.ts` connects a space to pim-computer on a Cua VM through a bridge the operator runs. A space uses it only when its operator chose it for that space (see "Choosing Cua for a space"), and then uses no other computer. Spaces without that choice keep paired computers and Sprites exactly as before. Nothing here turns on, takes over or resumes the control state (`docs/computer-control-state.md`), so an operator's computer receives agents' requests only in a space whose control state some other, operator-side step has already enabled and leased to the agent; no code in Pim does either. Its tests use a `fetch` they give it, answered in the same process; none reaches the network.

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

## Choosing Cua for a space

The choice is the operator's, and is kept in two places, neither of which anything in Pim writes:

- **The space's marker.** The space's own metadata (`pim_meta`), key `computer_provider` (`PROVIDER_KEY`), holds exactly `{"provider":"cua","space":"<owner>"}`, where `<owner>` is that space's owner ID. No route, tool or setting creates, changes or removes it; Pim only reads it, on every use. Anything else stored under that key (not JSON, another provider, another space's ID, any other field) is **unreadable**: the space then uses no computer at all, not the default. Pim never infers the marker from anything else, such as a Sprite's machine name or a bridge in the secret below.
- **The bridge, in a Worker secret.** `CUA_BRIDGES` (`wrangler secret put CUA_BRIDGES`, or the dashboard) holds every Cua space's bridge, by owner: `{"o_…":{"url":"https://bridge.example/…","token":"…"}}`, each entry with exactly `url` and `token`. Pim takes the entry for the space asking, and only that one, binds it to that space, and checks it further when it connects (HTTPS, no credentials, query or fragment; a well-formed token). The secret is never stored in the space, the marker never holds it, and neither its address nor its token appears in an answer, a status, a tool's text, an error or a log: a missing or unreadable entry is refused with one fixed message and logged as `cua.unconfigured`. A bridge in the secret chooses nothing: a space without the marker ignores it.

The operator writes the marker before the space first runs, or restarts the space after, since the space sets up its agents' tools when it starts (file, shell and browser tools while it has a computer; no `generate_image`, which saves to files, on an operator's computer). Pim reads the marker on every use, so refusals follow it at once.

A space with the marker keeps it, whatever the secret holds: with no usable entry, every request that would reach the computer is refused before anything is sent, and nothing falls back to a paired computer, a Sprite, or another space's bridge.

## What reaches an operator's computer

- **Agents' requests, only as the control state admits them.** Every agent path that reaches the computer goes through `#controlled` (`src/pim.ts`): approved `shell`, `file_delete`, `browser_click` and `browser_type`, the file tools and the browser tools. On an operator's computer it refuses unless the space's control state is enabled and admits the request under the agent's current lease (see `docs/computer-control-state.md`): with no control state, a damaged or blocked one, the person in control, or an approval not filed under the current lease, nothing is sent. The approval gates are unchanged: an approved action is dispatched once, after its decision.
- **`Computer.call` refuses everything else.** On an operator's computer, a call outside an admitted request is refused before anything is woken or sent, unless it is one of the person's reads below. That covers Pim's other uses of the person's files, which aren't admitted requests: an agent's icon or skill read from files, an artifact made from a file, an app tool's `save_to`, and moving files a space kept before files moved to the computer (which an operator's computer never does). They fail with that refusal.
- **Waking.** A call that finds the computer asleep connects through the bridge (`Cua.connect`), once, and the space lets go of it after five idle minutes, as for a Sprite. A connection that fails, is refused or times out sends nothing, so an admitted request is settled `rejected`; a call sent and unanswered when the connection ends is `unknown`, blocks the control state, and is never sent again.
- **Nothing of a paired computer or a Sprite.** A paired computer's connection is never used in place of the operator's computer, and a paired computer can't connect (`/api/computer/connect` answers `409`); one connected from before is closed (`4409`) on its next message, and nothing it says is taken. While a paired computer's token, or a Sprite Pim started, is still on record beside the marker, every call is refused (`409`) and neither is touched: Pim doesn't forget the token or remove the Sprite to resolve it. The operator does.

## The person's direct routes

No person's input reaches an operator's computer. These are what the person's own routes do there:

| Route | On an operator's computer |
| --- | --- |
| `GET /computer` | `{ state, managed: false, pairedAt: null, computer, provider: "cua", startable: false }`: `computer` is what the operator's pim-computer said when it last connected, never a paired computer's; `provider` is `"unreadable"`, with `computer: null`, when the marker can't be read |
| `POST /computer` (pairing or starting), `DELETE /computer` | `409` before anything changes: Pim doesn't start, pair, replace or remove the operator's computer |
| `GET /files`, `GET /files/content` | **Allowed**, as the person's reads (`asPersonRead` in `src/computer.ts`), which may wake the computer through the bridge. A person's read may make only `stat`, `read`, `readdir` and `browser_status` calls, which change nothing there; a large file's later parts are read as part of the same read |
| `PUT /files/content`, `DELETE /files` | `409`, nothing written or deleted |
| `GET /browser` | `takeOver: false`. Reading the page, or `GET /browser/screenshot`, is **allowed** only while the browser's DevTools connection is already open from an agent's admitted request; puppeteer's own messages to read the page or take its picture are sent then. Otherwise it is refused (`409`) without starting or connecting the browser |
| `DELETE /browser` | `409`: closing a window is input, and nothing is sent |
| `GET /browser/live` | Refused before it watches: an `error`, then `4005`, whether or not the control state is enabled, damaged or missing; one open from before is ended on its next message |

These are application paths. Refusing them doesn't show that nothing else drives the VM or its browser: the bridge, the operator, and whatever runs as the desktop user there are outside Pim.

## Lifecycle is the operator's

Pim doesn't create, start, stop, replace or delete an operator's VM, and never calls Sprites for a space with the marker. Erasing such a space lets go of the bridge's connection and sends nothing to the VM, nor to any Sprite still on record; it logs `{"event":"cua.erased","owner":…,"sprite":…}` (the Sprite's name, or null) so the operator can clean up. **The operator must remove the VM, its bridge, the space's `CUA_BRIDGES` entry, and any such Sprite, when a space is erased or stops using Cua.** Nothing switches a space between providers.

## What is not done

- **The operator's tooling.** Writing the marker, enabling the control state and giving the agent a lease are outside this repository; only tests do them here. Human takeover stays unavailable.
- **Settings → Computer** shows an operator's computer as a paired one that is offline or online; its pairing and removing buttons are there, and the server refuses them.
- **The bridge itself** is not in this repository, and nothing here has run against a real one or a real Cua VM: every test answers `fetch` in the same process, with a `WebSocketPair` and pim-computer's own `Link`. How a deployed Worker's `fetch` upgrades, times out and aborts against a real bridge is untested. That Workers expose the `101` response's `x-pim-space` header to `fetch` is assumed from the platform, not tested against it; if they don't, every connection is refused.
- **Versions.** A Sprite fetches pim-computer from its Pim each time it starts; the bridge's operator must keep its copy in step.
- **Control and takeover.** A Cua VM is a whole desktop. Nothing here shows that a person's input there is quiescent or exclusive, so human takeover stays unavailable, as in `docs/computer-control-state.md`. Local transport tests say nothing about what else drives the VM.
