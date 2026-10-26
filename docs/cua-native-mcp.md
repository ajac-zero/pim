# The Cua native-app MCP client

`computer/cua-host/native-mcp.ts` is the host-side client through which Pim will, later, let agents use native apps on a space's Cua VM: list apps and windows, read a window's accessibility tree and screenshot, bring a window to the front, and click, type, press keys and scroll in it. It calls the cua-driver tools that spacesd 0.7.0 already serves at `/mcp`, not a second daemon, shell, DevTools or UI automation of its own. Only nine curated tools can be named, each with a tightened subset of its pinned arguments. Each call sends exactly one `tools/call` and reports what is known of it as a typed outcome, including **unknown**. The space sends a call to it only through `Computer.native`, with the identity of a request its control state admitted, and the host answers that call through `createNativeDispatcher` (see "The space's request"). **Nothing routes to either yet.** They add no agent tool, Worker route, setting, listener, installer step or credential file; pim-computer doesn't make a dispatcher, Pim's own `Computer` has native-app calls off, and nothing starts the client. See "Not wired yet".

## What is pinned

Everything comes from [trycua/cua at `fca2193`](https://github.com/trycua/cua/tree/fca21937bc4e1420a23d544d11dbdf987f0266e6), the cua-spacesd 0.7.0 release, whose spacesd links cua-driver 0.38.0 (`libs/cua-driver/rust/Cargo.toml`). Nothing is fetched at run time. `computer/cua-host/native-mcp-upstream.ts` holds the pins, read from these files (git blob ids at that commit):

| File | Blob | What it gives |
| --- | --- | --- |
| `libs/cua-spacesd/crates/cua-spacesd-server/src/http/mcp.rs` | `b1ba7fc870f9` | The `/mcp` transport: auth, sessions, agent sessions, `202`, batches, `DELETE` |
| `libs/cua-spacesd/crates/cua-spacesd-server/src/auth.rs` | `347e31aa5324` | The bearer check (`authorization` or `x-cua-env-authorization`) |
| `libs/cua-spacesd/crates/cua-spacesd-server/src/server.rs` | `bbfa9d8c74a7` | `/mcp` routed to `mcp::handle`, or `501` when MCP is off |
| `libs/cua-spacesd/crates/cua-spacesd-desktop/src/lib.rs`, `grpc/mod.rs` | `85ab80741b71`, `4a2bd1488d74` | On Linux, `/mcp` serves `platform_linux::register_tools_with_cursor`, wrapped so input tools hold the pointer lock |
| `libs/cua-driver/rust/crates/cua-driver-core/src/server.rs` | `09007a554039` | `tools/call` dispatch: checks, `session`, authorization, invoke |
| `libs/cua-driver/rust/crates/cua-driver-core/src/mcp_wire.rs` | `7b3d30db79ca` | Legacy and modern request eras |
| `libs/cua-driver/rust/crates/cua-driver-core/src/protocol.rs` | `63733f8950eb` | `initialize_result()`, JSON-RPC and content shapes |
| `libs/cua-driver/rust/crates/cua-driver-core/src/tool.rs` | `afef86dc4e54` | `tools/list` entries (`advertised_runtime_input_schema`) |
| `libs/cua-driver/rust/crates/cua-driver-core/src/tool_schema.rs`, `window_state_view.rs` | `e60d3e26c78d`, `8505c3d1c9a0` | Shared schema helpers |
| `libs/cua-driver/rust/crates/platform-linux/src/tools/impl_.rs` | `c67855ac30d6` | Each tool's `ToolDef` |
| `libs/cua-driver/rust/crates/platform-linux/src/input/delivery.rs` | `d5270cd4711d` | Linux's `delivery_mode` schema |

`UPSTREAM_TOOLS` copies each curated tool's `required` list and the schema of each property it allows, every keyword except `description`. Its SHA-256 as canonical JSON is `3a599e8c2dc90fda821d2c03d69d6bc758ed668e6b3cf133f66ad3c77305b19a` (`UPSTREAM_TOOLS_SHA256`). That hash covers the source line of each `ToolDef` too. The copy was checked against the source at the commit by expanding each `json!` block and its helpers. The check is a scratch script, not a committed test, because the tests don't have upstream's source. Setting up a run checks the copy again against what the daemon's `tools/list` actually advertises, so a daemon whose schemas differ gets no call.

## The protocol, as spacesd 0.7.0 serves it

- **Only `POST /mcp` carries requests.** A bearer token is checked first (`401`, plain text, otherwise). `GET` has no event stream (`405`). `DELETE` ends sessions (see "Lifecycle"). Answers are `application/json`; a notification gets `202` with no body.
- **spacesd keeps no MCP session state for calls.** It echoes the `Mcp-Session-Id` it is sent, or mints `mcp-` plus 16 URL-safe base64 characters. That id matters only as the driver session's fallback key and as the owner of envelope receivers, which this client never opens. A `tools/call` doesn't need an `initialize` first: over HTTP, cua-driver-core classifies each request alone (`handle_request_with_transport_session`, legacy era without `_meta`). So no answer can mean "session expired", and the client never re-initializes.
- **`X-Cua-Agent-Session` picks the driver session.** When it is 1 to 64 of `[A-Za-z0-9._:-]`, every call carrying it acts in driver session `agent-<value>`: one cursor, its snapshots and element tokens, its recording. It identifies a driver session. It doesn't authenticate anyone.
- **A `session` tool argument overrides it.** Dispatch uses a non-empty `session` argument as the driver session. So the client never sends `session`, and no `_`-prefixed field either. Dispatch strips those, but sending one would be misleading.

`openRun` sets a run up with exactly three requests, each bounded by `setupMs` (10 s) and `maxSetupBytes` (4 MiB), and nothing else:

1. `initialize` with protocol version `2025-06-18` and no session header. The client requires a minted `Mcp-Session-Id`, `protocolVersion: "2025-06-18"`, and `serverInfo` `cua-driver` `0.38.0`.
2. `notifications/initialized` in that session, which must get `202` and no body.
3. `tools/list` in that session. Each curated tool must be listed once, with a closed `inputSchema`, the pinned `required` list, and each allowed property exactly as pinned, apart from its description. Other properties and tools may be there.

Every request goes to `<origin>/mcp` with `authorization: Bearer <token>`, `content-type` and `accept` of `application/json`, the run's `x-cua-agent-session`, and, after `initialize`, its `mcp-session-id` and `mcp-protocol-version: 2025-06-18` (which spacesd ignores). Redirects are not followed (`redirect: "manual"`). The origin and token are the operator's, checked once: `https://host[:port]`, or `http://` only on a loopback host, with no path, query or credentials. Nothing a caller passes reaches the URL, method or headers. A setup that fails says only which step and why (`NativeMcpSetupError`), never what spacesd said. A malformed schema is a mismatch, and any other failure inside setup, such as a run or signal that throws when read, is a `NativeMcpSetupError` too, never a raw error. Because setup calls no tool, a run whose setup failed may be set up again. A run that was set up never is.

## The curated tools

These are names from the Linux registry that spacesd links. Each argument is one the pinned schema has, with the same type, and bounded more tightly. Any other argument, a missing required one, or a value out of bounds is refused before anything is sent. Pointer and key actions need a `pid`, so they always go to a window of a process.

| Tool | What | Arguments admitted | Left out of the upstream schema |
| --- | --- | --- | --- |
| `list_apps` | Running and installed apps | none | |
| `list_windows` | Top-level windows | `pid`, `app` (≤ 256), `on_screen_only` | |
| `get_window_state` | A window's accessibility tree and screenshot | `pid` (required), `window_id`, `include_accessibility_tree`, `include_screenshot`, `query` (≤ 256), `max_elements` (1–5000), `max_depth` (1–256), `timeout_ms` (100–30000), `tree_format`, `since` (`latest` or a snapshot id) | `session`, `capture_mode`, `screenshot_out_file` (writes a file), `max_dimension`, `max_image_dimension` (0 is native size), `verbose`, `full_output`, `display_only` |
| `bring_to_front` | Activates a window | `pid` (required), `window_id` | |
| `click` | A click, by pixel or element | `pid` (required), `window_id`, `x`, `y` (0–16384), `element_token`, `button`, `count` (1–3), `delivery_mode` | `session`, `cursor_id`, `capture_id`, `modifier`, `from_zoom`, `scope` and `coordinate_frame` (the desktop at large), `target` |
| `type_text` | Types text | `pid`, `text` (both required, ≤ 4096), `window_id`, `x`, `y`, `element_token`, `delivery_mode` | `session`, `scope`, `coordinate_frame`, `target` |
| `press_key` | One key | `pid`, `key` (both required, ≤ 32 printable ASCII), `modifiers` (≤ 4 of `ctrl`, `shift`, `alt`, `super`), `window_id`, `x`, `y`, `element_token`, `delivery_mode` | `session`, `scope`, `coordinate_frame`, `target` |
| `hotkey` | A chord | `pid`, `keys` (both required, 2–5 keys), `window_id`, `x`, `y`, `element_token`, `delivery_mode` | `session`, `scope`, `target` |
| `scroll` | Scrolls | `pid`, `direction` (both required), `by`, `amount` (1–50), `window_id`, `x`, `y`, `element_token`, `delivery_mode` | `session`, `cursor_id`, `scope`, `coordinate_frame`, `target` |

Arguments are copied before they are checked: plain JSON data only, at most 3 levels deep, 16 keys and 16 items, with no getters, symbols or class instances. The copy is serialized before anything is awaited, so changing the caller's object afterwards changes nothing sent. The caller's signal is read once and linked to a signal of the client's own, so nothing after that reads a caller's object.

Typing and keys go to whatever window they target. Typed into a terminal emulator, they are commands. Which apps an agent may act on is for Pim's approvals to decide, not this client.

### What isn't curated

Everything else the registry has is refused by name, including the JSON-RPC methods themselves (`initialize`, `tools/list`, `server/discover`, notifications, `cua/driver/v1/*`). The registry has lifecycle and management tools (`kill_app`, `set_window_frame`, the cursor, config, permission, health, recording and session tools), batches, replays and scripts (`run_steps` and its old name `run_actions`, `replay_trajectory`, and `run_script` where it is built in), the browser and DevTools tools (`page`, `browser_*`), the clipboard, `set_value`, `invoke_menu`, drags and raw mouse buttons, desktop-wide reads (`get_desktop_state`, `get_accessibility_tree`, `zoom`), and `double_click` and `right_click`, which `click` covers. Pim's shell, files and browser keep their existing paths.

### A design issue: `launch_app` can run any program

`launch_app` (`impl_.rs` line 2034) would be the way to start a native app, but it can't be curated without granting execution:

- `launch_path` and `name` are split on whitespace and run directly as a program with arguments (`spawn_launch_command`), as the desktop's user. Any program on the `PATH` runs, with any arguments.
- `additional_arguments` appends arbitrary arguments.
- `urls`, and a `name` that is a path or URL, go to `xdg-open`, which opens files and the default browser.

Restricting `name` to a pattern doesn't help, because `name` is tried as a command before it is matched against `.desktop` entries. So `launch_app` is left out, and an agent can use only apps that are already running. Two ways to resolve it, for a separate decision:

1. **The operator pins launchable apps:** a fixed table of `.desktop` ids to `launch_path`s, chosen when the VM is set up. The agent picks a table key and never supplies a string.
2. **The apps are started by the VM's session**, autostarted with the desktop, and agents never launch anything.

## Identity and runs

A run is `{ owner, agentId, runId }`, which must come from Pim's own records: the space, the agent and its run, never a model. The client is made for one owner, the space whose VM it is, and refuses runs of any other. The run's `X-Cua-Agent-Session` is `pim-` plus the first 40 hex digits of SHA-256 over the three values, each prefixed with its byte length. That is 44 characters spacesd accepts. It is stable for a run, and differs for any other owner, agent or run unless SHA-256 collides in 160 bits. The length prefixes keep `("a", "bc")` and `("ab", "c")` apart. No caller supplies it.

Each call names its run again plus its own `callId`, which must be unique within the run. A call naming another owner, agent or run is refused unsent. So is a `callId` used before (even one that was itself refused), a call while another of the run is in flight, and any call once the run is closed or uncertain. These are this client's own guards, kept in memory. Across restarts, `ControlCoordinator`'s stored request IDs stay the durable once-only guard, and its stored runs the durable latch (see "The space's request").

The driver session separates runs' cursors, snapshots and element tokens. It does not separate agents from each other. Every agent runs as the VM's one desktop user, and anything running as that user can read a Cua token stored in the desktop account and call spacesd directly, every gRPC service included. The curation is Pim's policy for its own agent tools, not a boundary against code on the VM. The bridge's token stays in the bridge's own account (`docs/cua-bridge.md`).

## Outcomes and the commit point

`invoke` never throws. Until the call is handed to `fetch`, it reads only the caller's objects, and anything that throws there, such as a getter or a proxy's trap on the call, its arguments or its signal, refuses the call unsent, by the stage it failed at (`identity`, `invalid_arguments` or `invalid_signal`). An unexpected error after the handoff is `unknown`. It returns a `NativeOutcome`:

| `status` | Means | Sent | Uncertain |
| --- | --- | --- | --- |
| `rejected` | Refused before sending (`aborted`, `closed`, `uncertain`, `busy`, `identity`, `call_reused`, `unknown_tool`, `invalid_arguments`, `invalid_signal`, and the dispatcher's `unavailable`) | no | no |
| `completed` | spacesd answered this call with a result. `isError` is the tool's own error or refusal, with `code` from its `structuredContent.code` when that is a plain identifier (for example `permission_denied`, `point_outside_window`). It is final, not a cue to retry. | yes | no |
| `rpc_error` | spacesd answered this call with a JSON-RPC error. At the pinned commit, `tools/call` gets one only from checks before the tool is invoked: `classify_request`, `validate_tool_call`, or unreadable params (`server.rs`, `handle_request_inner` and `dispatch_request`). An invocation's own failure becomes a result with `isError`. Only the numeric code is kept. | yes | no |
| `unknown` | The call may have reached spacesd and run, and nothing proves whether it did (`timeout`, `aborted`, `transport`, `http_status`, `content_type`, `session_mismatch`, `oversized`, `malformed`, `id_mismatch`) | yes | **yes** |

`dispatchEffect(outcome)` gives the `sent` and `uncertain` columns. They describe the native call: `sent` means a request went to spacesd. That is not `DispatchTrace.sent`, which means a message left the space for the computer, so the space takes only `uncertain` from an outcome (see "The wire contract").

**Calling `fetch` is the commit point.** From that call on, the request may have reached spacesd and the tool may have run, whatever `fetch` does next: throw, be aborted, time out, or return something unreadable. Only a valid answer to that call makes the outcome known. A valid answer is status `200`, `application/json`, the run's own `Mcp-Session-Id`, at most `maxResponseBytes` (16 MiB) of UTF-8, holding one JSON-RPC response object with `jsonrpc: "2.0"`, this call's id, and exactly one of `result` or `error`. Anything else is `unknown`. That includes a `401`: spacesd checks the token before dispatching, but a non-JSON-RPC answer proves nothing about this call here. It also includes a parse error's `null` id, a batch, a redirect, and a body cut off, oversized or still arriving at the bound (`callMs`, 60 s). When the bound or the caller's signal ends the wait, the client stops at once. A response that comes later is cancelled unread.

An `unknown` outcome latches the run as `uncertain`. It sends nothing more, and nothing here clears that, `close()` included. Nothing is ever retried, resumed or replayed, and there is no `initialize` after a failure.

## Results

A `completed` outcome's `content` keeps:

- **Text items**, all together at most `maxTextBytes` (256 KiB) of UTF-8, cut between characters.
- **Image items**, at most `maxImages` (4), each `image/png` or `image/jpeg` with strict base64 of at most `maxImageBytes` (8 MiB). The base64 is checked one character at a time (`isBase64`), never with a regular expression that repeats a group, because such an expression overflows the stack on a few megabytes. Before this change, that overflow turned a valid screenshot of about 6 MiB into `unknown`. The bytes must have that type's signature, and the header's size must be at most 4096 pixels a side and 16.7 megapixels. By default `get_window_state` delivers at most 1.15 megapixels, with a long edge of at most 1568.

Only the first `maxContentItems` (64) items of `content` are read. The rest are counted once, as `{ kind: "items_unread", count }`. So `presentation` has at most one issue per item read, plus that one and two about the result as a whole. What is kept also fits `maxOutputBytes` (16 MiB less 4 KiB, the wire's budget below) as JSON, with room set aside for every issue. A text item is cut to what fits even if its JSON grows sixfold (`\u0001`), and an image that doesn't fit is left out. A result of 10,000 `null` items (about 50 KiB) becomes 64 issues and one `items_unread`, about 2.5 KiB.

Anything else is left out: resources and resource links (their URLs are never fetched), other image types, malformed items, and `structuredContent` apart from an error's `code`. Each omission or cut is listed in `presentation`, with the item's index. The outcome stays `completed` regardless. An `isError` that isn't a boolean is taken as an error, not success, and listed too. The text of a tool's error is the tool's answer, so it is passed on, bounded. Transport errors, HTTP bodies, JSON-RPC messages and the token never are.

## Limits

The defaults above can be changed only by the operator through `limits`, and only to integers in `LIMIT_RANGES`. A value that is `NaN`, infinite, negative, fractional, `undefined`, not a number, beyond its ceiling, or for a key that isn't a limit throws when the client is made. So no setting can switch a bound off. The ceilings are 60 s for `setupMs`, 600 s for `callMs`, 16 MiB for `maxSetupBytes`, 64 MiB for `maxResponseBytes`, 16 MiB less 4 KiB for `maxOutputBytes` (the wire's outcome budget, which is also its default), 4 MiB for `maxTextBytes`, 16 images, 32 MiB for `maxImageBytes`, 16,384 pixels a side, and 1,024 for `maxContentItems`. `maxOutputBytes` must leave room for content beside the issues `maxContentItems` allows.

## Lifecycle: what the client doesn't do

- **No `DELETE /mcp`.** In `mcp.rs`, `DELETE` with the run's `X-Cua-Agent-Session` and no `Mcp-Session-Id` ends that whole driver session through `end_trusted_adapter_transport` and `end_session`. That takes the run's cursor out of presence, clears its held mouse buttons, and retires its screenshots, snapshots and element tokens. With an `Mcp-Session-Id`, `DELETE` only closes that session's envelope receivers. Ending a run's driver session is a lifecycle decision for the integration, so nothing here sends it, per call or otherwise.
- **`close()` sends nothing.** The run stops sending. A call already in flight goes on to its own outcome.
- **No process is signalled and no cleanup runs.** Asking anything to stop is not the same as seeing a transport closed, or the desktop quiet. Nothing here fences input: other agents, the person, and the apps themselves keep acting on the same desktop.

## The wire contract

`computer/native-outcome.ts` holds the one `NativeOutcome` type, with its reasons, presentation issues and `dispatchEffect`. `native-mcp.ts` imports it and re-exports the types and `dispatchEffect`, so its callers are unchanged. The Worker imports it too, and nothing else of the host's: the file imports nothing and uses only the language itself, so no `node:` module, `ws`, protobuf, MCP transport or startup code reaches the Worker. It isn't installed on a VM, and nothing starts it.

It also holds:

- **`NATIVE_TOOL_OP`, `"native_tool"`.** The pim-computer call op reserved for one native-app call. Only a call with this op, chosen by the Worker's own code when it sends the call, has its reply read as an outcome. Nothing in a reply, and no argument, chooses that.
- **`NativeRequest` and `readNativeRequest(value)`.** A `native_tool` call's args: exactly `owner`, `agentId`, `runId`, `callId`, `tool` and `arguments`. The four identities are 1 to 256 printable ASCII characters without spaces (`NATIVE_IDENTITY`, which the client uses too), `tool` is one of `NATIVE_TOOLS` (the nine curated names, which the host's tests check against `TOOLS`), and `arguments` is a plain object of at most `NATIVE_ARGUMENTS_CHARS` (32 KiB) as JSON. Anything else, or anything that throws when read, is null. The space checks what it built with it before sending, and the host reads every call with it.
- **`NATIVE_WIRE_LIMITS`.** The most an outcome may hold: 1,024 items, 1,028 issues, 16 images of at most 16,384 pixels a side, 4 MiB of UTF-8 text, and `maxOutcomeChars` of JSON. `maxOutcomeChars` is `BRIDGE_MESSAGE_CHARS` (16 MiB, the most one message carries through a Cua bridge, as `MAX_MESSAGE_CHARS` in `computer/cua-bridge.ts` and `src/cua.ts`, which the tests check) less `REPLY_RESERVE_CHARS` (4 KiB). That reserve is for pim-computer's reply envelope, `{"type":"reply","id":"<UUID>","result":…}`, which is about 60 characters. `LIMIT_RANGES` uses these constants as the ceilings of `maxContentItems`, `maxImages`, `maxTextBytes`, `maxImageSide` and `maxOutputBytes`. `maxOutputBytes` defaults to the budget too. It counts UTF-8 bytes, which are never fewer than JSON's UTF-16 characters, so whatever the client keeps under any limits fits one reply, and the space reads it unchanged. The default 8 MiB screenshot fits, as about 11 MiB of base64.
- **`readNativeOutcome(value)`.** It returns the outcome when `value` is exactly one the client could have made: one of the four kinds, with exactly its fields (no extra, missing or inherited-looking keys), known statuses and reasons, a `code` only on a tool's error and only a plain identifier, text and image items only, issues of known kinds with exactly their fields, and everything within `NATIVE_WIRE_LIMITS`. It returns a new object holding only those fields. Otherwise it returns null. Its work is bounded by the limits and needs constant stack: it uses no recursion, and checks base64 with `isBase64`. It checks an image's type, base64 and stated size, not its bytes, which the host already checked.

### The space's request

`Computer.call` refuses `native_tool` (a `400`, nothing sent), inside a request or not. Only `Computer.native(tool, arguments)` makes it, and it takes nothing else from its caller. Who calls is the request `ControlCoordinator.dispatch` is admitting, which it records in the request's trace (`DispatchTrace.request`, set only by `dispatch`):

| Field | From |
| --- | --- |
| `owner` | the coordinator's space: the Durable Object's own name, which `dispatch` already requires the request's `space` to be |
| `agentId` | the request's agent, which `#controlled` takes from the server's record of the conversation |
| `runId` | the request's `runId`, which the server names (`ControlRequest.runId`); see "Runs" below |
| `callId` | the request's ID, so a request makes at most one native-app call |
| `tool`, `arguments` | the caller |

Each of these refuses the call before anything is woken or sent, with a fixed message:

- native-app calls not turned on for this `Computer` (`nativeApps`, off unless given; Pim doesn't give it), a `409`;
- a computer that isn't the operator's Cua VM: a paired computer or a Sprite never gets one, and there is no fallback to another, a `409`;
- no trace, a trace `dispatch` didn't make, or a request that names no run, a `409`;
- a second native-app call in the same request, a `409`;
- a tool outside `NATIVE_TOOLS`, or arguments that aren't a plain object, can't be copied as JSON (a getter that throws, a cycle, a `bigint`), or are past `NATIVE_ARGUMENTS_CHARS`, a `400`.

The arguments are copied as JSON before anything is awaited, and the request built from the copy must pass `readNativeRequest`. Arguments that name an identity, a session, an endpoint or a token are only arguments: they never take an identity's place, and the host refuses them, as no curated schema admits them. A call refused here leaves the request `rejected`, since nothing left the space. Inside an admitted request, a call that waited for the computer to wake is checked again before it is sent: if its request was settled meanwhile, it is refused, as `Computer.call` refuses anything outside a request on an operator's computer.

`Computer.native` waits `NATIVE_CALL_MS` (120 s) for the reply, longer than the host's own bounds at their defaults: three setup requests of `setupMs` (10 s) and one call of `callMs` (60 s). An operator who raises those must keep their sum below it.

**Runs.** A request that names a run stores its `runId` with it in the control state. Once one of a run's requests is `unknown`, or in flight from an earlier epoch, the run admits no more requests (`run_uncertain`), whatever their request IDs or agents. Reconciling the request reopens admissions for other runs, never for that one, so the same run never gets another call after an uncertain one, also after a restart, which reads a request in flight as `unknown`, or across the computer's reconnections, which start a new pim-computer that remembers no runs. A new run ID is the server's to choose, and it can't be had while the space is blocked by the unknown request. Requests that name no run, which are all of Pim's requests today, are unaffected.

### The host's dispatcher

`createNativeDispatcher(options)` takes the client's own options (the operator's origin and token, and the space it is for) and makes no request until it is called. `dispatch(args)` never throws, and answers a `native_tool` call's args with an outcome:

- **Refused before any request to spacesd, setup included:** args that `readNativeRequest` refuses (`identity`, or `unknown_tool` when they name an uncurated tool such as `launch_app`, `run_steps` or a JSON-RPC method), another space's owner (`identity`), and arguments the tool's curated schema doesn't admit (`invalid_arguments`).
- **Each run is opened once** with its trusted owner, agent and run, on its first call, and kept for as long as the process lives, so the client never opens it twice. A run whose outcome was unknown refuses every later call (`uncertain`), whatever its call ID. The run's own guards apply: a call ID used before (`call_reused`) and a call while another is in flight (`busy`).
- **`unavailable`** when the run can't be set up, which calls no tool, so it may be set up on a later call; or when the dispatcher already holds `MAX_RUNS` (256) runs.

A pim-computer process lives as long as its connection, so its runs are kept in memory only. Across processes the space's control state is the guard, as above: it never sends a request ID twice, or a call of a run that was uncertain.

### What `Computer.call` does with a native reply

`Computer.native` sends `native_tool` as `Computer.call` sends any call: `{ type: "call", id, op: "native_tool", args }`, marking the request's `DispatchTrace.sent` when the message is handed to the socket. It also adds `native:<id>` to the trace's `awaiting`, as the browser's transport does for a DevTools message. Then:

| The reply, or its absence | The caller gets | The request's trace |
| --- | --- | --- |
| `result` is a known outcome: `completed` (`isError` or not), `rpc_error` or `rejected` | the checked outcome, resolved | the wait is cleared. `sent` and `uncertain` aren't changed. |
| `result` is an `unknown` outcome | the checked outcome, resolved | `uncertain` is set before the promise settles. The wait is cleared. |
| an `error` reply (any `error` key, even beside a result) | a `502` with a fixed message, rejected | `uncertain` is set before the promise settles |
| `result` that `readNativeOutcome` refuses, or none | the same `502`, rejected | `uncertain` is set before the promise settles |
| checking the reply throws, which no reply is known to make it do | the same `502`, rejected. The exception is neither passed on nor logged. | `uncertain` is set before the promise settles |
| no reply: the call times out, or the computer disconnects | `504` or `503`, rejected, as before | `uncertain` is set, as before, and the wait stays |
| a reply after that, or after the request was settled | nothing: no one waits for it | nothing changes |

The treatment is conservative:

- **An `error` reply is uncertain.** pim-computer answers a call it doesn't know with an error (`ENOSYS`), and it has no `native_tool` handler yet. But a generic error can't show whether the downstream action ran. So for this op it is never `answered`. Its message and code are not passed on, and neither is anything else the computer said.
- **`uncertain` is monotonic.** It is only ever raised. A `rejected` outcome means nothing reached spacesd for that call, but the call did reach the computer, and the request's other calls may have run, so it lowers neither `sent` nor `uncertain`. A request whose only call was refused by the host settles `completed` (a reply is a receipt), not `rejected`.
- **A reply always settles its call.** The reply removes the call from those waiting, and clears its timer, before it is checked. So the check runs behind an exception boundary, and whatever happens in it, the call is settled once.
- **A request settled before its native reply is unknown.** The wait in `awaiting` keeps it unknown, as for an unanswered DevTools message. So code that doesn't await its native call can't settle the request `completed`.
- **Nothing is retried or sent elsewhere.** There is no new call ID or run ID to escape an uncertain request. The coordinator's stored request IDs and its `unknown` status block successors and replays until a `reconcile_request` event, also across a restart, and the uncertain request's run stays latched after that.

Every other op is answered exactly as before, whatever its result holds. An `exec` result of `{ status: "unknown" }` is just a result, and an error reply is still `answered`, with its code. Outside an admitted request (paired computers and Sprites, or a space that never opted in), no native-app call is sent at all.

### What this is, and isn't

This is a reviewed module-level seam: the request and outcome both sides share, the space's request built from its trusted control context, the host's dispatcher, and the space's completion semantics for one reserved op, tested through `Computer`'s real call and reply path, the `ControlCoordinator` with in-memory storage, and the dispatcher against the stand-in. **It is not a working native integration.** No code calls `Computer.native`, Pim's `Computer` has it off, pim-computer has no handler that makes a dispatcher, and no agent tool, approval, route, setting, credential or installer step refers to either. **Nothing here has been qualified against the real binary or a VM.**

## Not wired yet

Wiring the client in is a separate, reviewed change. It needs at least:

1. **Where it runs, and its credential.** It would run on the VM beside spacesd, most simply inside `pim-computer` (`computer/pim-computer.ts`), which `computer/cua-host/desktop.ts` starts as the desktop user. The operator sets spacesd's loopback origin and a token file. That token is desktop-resident and not isolated from same-user agents (see "Identity and runs"). The bridge only carries the protocol and needs no change.
2. **pim-computer's handler.** The space's request and the host's dispatcher are done (see "The wire contract"). pim-computer would answer `native_tool` with `dispatch(args)`, only where the operator has explicitly set a dispatcher up for the Cua VM, never on a Sprite or a paired computer, and only as `result`, never as `error`, since an error reply is taken as unknown. pim-computer is served whole to Sprites, so it can't import the host's modules; how it gets a dispatcher without changing what Sprites run is part of that change. Until then it answers `native_tool` with `ENOSYS`, which the space reads as unknown, so `Computer.native` must stay off.
3. **The run ID, and turning the space's side on.** `#controlled` in `src/pim.ts` passes no `runId` yet, so no request Pim makes can carry a native-app call. The permission and tool layer must choose a run ID Pim keeps per agent run (for example one per conversation and lease, replaced once its run is latched), pass it through `#controlled` and the approval that runs an input tool (`decideApproval`), and construct Pim's `Computer` with `nativeApps` for an operator's Cua VM. Nothing the model writes may reach the run ID.
4. **Agent tools and approvals.** The Worker would define the agent-facing tools and route them through `#controlled` and the existing approvals, input tools as gated actions, each calling `Computer.native` once per request. That includes how results and `presentation` reach the model and the person. Nothing here defines that catalog. The client admits only `TOOLS`, whatever is wired above it.
5. **`launch_app`**, decided as above, if at all.
6. **Qualifying the real binary.** Run setup against spacesd 0.7.0 with cua-driver 0.38.0 on a disposable VM, and confirm that `tools/list` matches the pins (setup checks this), that the agent session is used, and the outcomes of real calls, before anything depends on it.

Until then nothing here is reachable, and passing tests here doesn't qualify a live boundary.

## Tests

`test/computer-control-runtime.test.ts` ("a native-app call, through Computer.call and the coordinator") drives the space's side through a real `Computer`, whose link is the test's own, and a `ControlCoordinator` on in-memory storage. It shows that an `unknown` outcome is resolved as a value with the request already uncertain, settles it `unknown`, and blocks a successor and a replay, also after the coordinator is rebuilt from storage. Known outcomes (`completed`, a tool's refusal with its code, `rpc_error`, `rejected`) resolve as they came and settle the request `completed`, with `sent` kept. An error reply, an error beside a result, a missing or null result, unknown statuses, reasons and issues, extra or missing fields, a code without an error, a resource link, an SVG, a fractional JSON-RPC code, 1,025 items, or text past 4 MiB each reject with a fixed message, without the computer's text, and leave the request uncertain and `unknown`. An unknown outcome followed by a refusal and a result in the same request stays uncertain. Other ops keep their results (an `exec` returning `{ status: "unknown" }`) and their answered errors. A timed-out, disconnected or unawaited native call is `unknown`, a late reply changes nothing, and nothing is sent again. A settlement that can't be stored latches the coordinator, and a restart reads the request as unknown. Replies with images of about 8 MB of base64 are read through `Computer.receive` in workerd: a 6 MiB PNG and 8,000,000 `A`s are known; a stray character, padding in the middle, or a cut-off group makes the request unknown. None overflows the stack. A validator replaced, for one reply, by one that throws settles the call with the fixed `502`, without the exception's text, leaves the request uncertain and `unknown`, and leaves no call waiting. The same file shows the space's request: a native call's args are exactly the admitted request's space, agent, run and request ID with the caller's tool and arguments, even when the arguments name another owner, agent, run, call, session, endpoint or token, and changing the arguments after the call changes nothing sent; another agent's request is that agent's. Nothing is sent outside a request, through `Computer.call` (in a request or not), in a trace made by hand, in a request with no run, for a second call in a request, for eleven uncurated or malformed tool names, or for arguments that are a list, null, a string, a date, a map, an object without a prototype, a getter that throws, a cycle, a `bigint` or past the bound; the request is then `rejected`. With native-app calls off, or on a Sprite, nothing is sent either, and a Sprite's other calls are answered outside any request as before; the space's own `Computer` has them off. A run whose request was unknown is refused `run_uncertain` after reconciliation, for a new request ID and another agent alike, as is a run whose request was in flight at a restart, while another run is admitted and carries its own run ID. `test/computer-control.test.ts` shows the same in the reducer: a run in flight in its epoch or settled known isn't latched, an empty run ID is refused, one in flight from an earlier epoch latches until its result, and a stored empty run ID isn't restored. Under deliberate mutations, these tests failed for: reconciliation reopening a run, an identity taken from the arguments, and no once-per-request guard. Earlier, they failed for: generic reply handling for `native_tool`, no wait in `awaiting`, a `rejected` outcome lowering `sent` or a known one lowering `uncertain`, any op's `{ status: "unknown" }` making a request uncertain, extra fields accepted, no text bound, the old base64 pattern (a `RangeError` escaping `Computer.receive`), and no exception boundary around the check.

`computer/cua-host/test/native-mcp.test.ts` also checks that every outcome the client returns in its tests, rejections included, reads back the same through `readNativeOutcome` after a JSON round trip. That includes an outcome kept at the client's highest limits. It also checks the wire's bounds from both sides (items, issues, images, text bytes, image size, the JSON budget from escapes or images, issue fields and indexes, and a `__proto__` key). An outcome exactly at the budget is read, one group of base64 past it isn't, and its reply envelope fits one bridge message. `isBase64` agrees with the old pattern on every text of up to five characters from a mixed alphabet, and decides texts of 8,000,000 characters where the pattern throws `RangeError`. Under Node, a 6 MiB screenshot from the stand-in stays a known result. With the old pattern, these tests fail.

Its last part shows the dispatcher: `NATIVE_TOOLS` and `TOOLS` name the same tools. Requests as the space sends them are called once each, in their own run's driver session, with each run set up once, and a request ID sent again is `call_reused`. Another space, a missing identity, a session, endpoint, token or agent session beside the call, an identity that isn't a string, has a space or newline, or is too long, arguments that aren't an object, `launch_app`, `run_steps`, a JSON-RPC method, `__proto__`, and arguments naming `session`, `owner`, `_meta`, the desktop, a file or no `pid` are each refused with no request to the stand-in at all, setup included, and read back the same over the wire. After an unknown outcome, every later call of the run is `uncertain`, with no new setup or call, while another run goes on. A run that can't be set up is `unavailable` with no tool called, and is set up on a later call. Past `MAX_RUNS` runs a new one is refused unsent. Without the dispatcher's own argument check, setup requests reached the stand-in for refused arguments, and the test failed.

`computer/cua-host/test/native-mcp.test.ts` runs with `pnpm --filter pim-cua-host test`. It needs only Node. Behind the client is a stand-in for spacesd's `/mcp`, written in the test from the source above. It is a `fetch` in the same process that checks the bearer, mints sessions, uses `X-Cua-Agent-Session` as the driver session, answers `202` to notifications, and answers `initialize`, `tools/list` and `tools/call`. It records each request and each call it "executes". It is not spacesd, and nothing here shows the real binary behaving as described. Those statements come from reading its source.

What the tests show, against the stand-in:

- The pins hash to `UPSTREAM_TOOLS_SHA256`. Every curated field has its upstream type, enums within upstream's, bounds within upstream's, and upstream's required fields. The exports can't be changed by an importer. Bad origins and tokens are refused.
- Setup sends `initialize`, `notifications/initialized` and `tools/list`, and no call. The token goes only to `<origin>/mcp`, with no redirects followed. The minted session and the derived agent session are carried, and calls act in `agent-<session>`. Agent sessions are unique across owners, agents, runs and ambiguous concatenations. Another owner, a bad identity, or a reopened run sends nothing. A daemon of another version or protocol, with no session, a missing tool, a retyped field or an open schema is refused with no call, and the error carries neither the token nor upstream text. A failed setup may be retried. An abort stops setup.
- Raw methods and every uncurated tool, `session`, `_`-fields, `_meta`, `scope`, `cursor_id`, `screenshot_out_file`, out-of-range values, batches as arguments, deep nesting, getters, class instances and symbols are refused with no `tools/call`. Changing the caller's object after `invoke` doesn't change what is sent. Other owners, agents and runs, and reused call IDs, are refused unsent.
- Exactly one `tools/call` reaches the stand-in for a result, a tool error, an authorization refusal, a JSON-RPC error, a timeout, the caller aborting after sending, `fetch` throwing after the stand-in executed the call, HTTP `500`, a redirect, an event stream, another session's answer, a malformed body, a batch answer, both `result` and `error`, another request's id, a parse error's `null` id, a body cut off, an oversized body, and a body that stops mid-way. Each gets the outcome in the table above, with neither the token nor upstream text in it. After an unknown outcome the run sends nothing more, `close()` included. A late answer is ignored and replays nothing. A call aborted before sending, or made while another is in flight, is refused unsent. `close()` sends nothing, and no `DELETE` is ever sent. An unknown outcome is a returned value whose `dispatchEffect` is uncertain.
- Results of 10,000 items (nulls, tiny or empty texts, valid and invalid images, resource links, a mix) keep at most 64 items and 66 issues, one of them `items_unread` with the right count, in under 64 KiB of JSON. The outcome stays known, with exactly one call. Text whose JSON grows sixfold is cut, and an image past `maxOutputBytes` is left out, within the bound.
- Calls, arguments and signals that throw when read refuse the call unsent: getters, and `getPrototypeOf`, `ownKeys`, `getOwnPropertyDescriptor` and `get` traps, on the call, its arguments, a nested array and its signal. They don't throw, don't leak the error, and leave the run usable. A response that throws after the stand-in executed the call is `unknown`. Limits that are `NaN`, infinite, negative, fractional, `undefined`, `null`, strings, bigints, out of range or unknown are refused. Malformed schemas (non-array or non-iterable `required`, null `properties`, non-array `tools`) and throwing responses, runs and signals during setup become a plain `NativeMcpSetupError`.
- Text is bounded and cut between characters. PNG and JPEG images are checked by signature and header size. Oversized, mislabelled, wrongly encoded and SVG images, resource links and resources are left out and listed, and the outcome stays `completed`. A malformed `isError` isn't success.

These tests found a wrong implementation when tried with deliberate mutations: a retry on a transport failure, no latch after an unknown outcome, a `fetch` exception counted as refused, extra fields admitted, no length prefix in the agent session, a cancelled read taken as a body's end, no checks of id, session, status or redirect, the caller's object serialized late, no call-ID, owner, busy or abort-before-send guard, no `tools/list` check, a malformed `isError` taken as success, no PNG signature check, no item cap, no output budget for text or images, a pre-send exception thrown or counted as unknown, `undefined` or out-of-range limits accepted, no `required` array check, raw setup errors, and the caller's signal ignored.
