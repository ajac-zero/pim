# The one-use launch evaluator for the preview's Cua evaluation

**Status: under review, not accepted. Nothing here has run against a live preview, a real browser or a real host.** It qualifies exactly one new viewer observation for the evaluation's existing owner and space: one Watch, one view-only viewer load, one End. It is a separate grant, credential, route pair and command from automation sign-in (`docs/preview-automation.md`) and the read-only diagnosis (`docs/agent-preview.md`), which are unchanged and gain nothing from it. The Worker's half is `preview/launch-evaluator.ts` (with its Directory methods in `preview/cua-eval.ts` and the space's two RPC methods in `preview/worker.ts`); the runner's is `computer/cua-host/launch-evaluator.ts` and `launch-evaluator-cli.ts`.

```diagram
 operator dir (0700)            fresh headless Chromium, isolated context
 └─ evaluator.json (0600) ─────▶ context.request ── 1. POST /auth/launch-evaluator/launch ──▶ Pim (exact origin)
                                   │                   ◀── fresh ID, viewer address, run token     │ Directory: run "launching"→"open"
                                   │                                                               │ space (RPC): fresh observation only
                                   ├─ page ── 2. GET viewer, 7 view-only calls, 1 media socket ──▶ bridge host (the new launch only)
                                   └─ context.request ── 3. POST /auth/launch-evaluator/end ─────▶ Pim: run "ending"→"ended"
                                 4. browser closed; the grant is spent for good
```

## Off unless granted, and never in a deployment

Only the evaluation mounts it (`evaluation` in `preview/worker.ts`, through `serve`'s `launchEvaluator` mount). A deployment's entry point (`src/index.ts`) passes no mount, so copying every variable into a deployment opens nothing: its routes answer `401 Sign in to Pim`, as any unknown `/auth` route does there. In the evaluation it is off unless both are set in the private environment:

- `PREVIEW_LAUNCH_EVALUATOR=on`. Any other value means off.
- `PREVIEW_LAUNCH_EVALUATOR_GRANT`, exactly:

```json
{
  "kind": "launch-evaluator",
  "owner": "o_…",
  "evaluation": "cua-eval-…",
  "deployment": "cua-eval@cloudflare",
  "origin": "https://pim-cua-eval.ajac-zero.com",
  "credentialSha256": "<64 lowercase hex digits>",
  "notAfter": "2026-10-29T12:00:00Z",
  "existingUnconfirmed": "<the earlier unconfirmed observation's ID, or null>"
}
```

The rules are automation's (the claimed, active owner; `cua-eval@<PIM_RUNTIME>`; exactly `PIM_PUBLIC_URL`; a digest, never the credential), plus: `kind` must be `launch-evaluator`, so neither grant is accepted in the other's variable; the credential's digest must differ from `PREVIEW_AUTOMATION_GRANT`'s; `notAfter`, the last moment a run may begin, is at most 24 hours ahead; and `existingUnconfirmed` is `null` or an observation ID (below). Off, its routes aren't there, and the space's RPC methods refuse too. Turning automation on or off changes nothing here, and the reverse.

The operator makes the credential and the runner's input with `scripts/preview-launch-evaluator-grant.mjs <evaluator file> <origin> <viewer origin> <owner> <evaluation> <deployment> <existing unconfirmed ID | none> <notAfter>`. It writes `{version: 1, kind: "launch-evaluator", origin, viewerOrigin, owner, evaluation, deployment, credential}` to a new `0600` file (never over anything) and prints only the grant. The viewer origin is the bridge's public HTTPS origin, which must be another host than Pim's. Nothing here has run that script.

## The interface: two routes, no session

Both are `POST` at Pim's exact origin, with `Origin: <origin>`, `Authorization: Pim-Launch-Evaluator <credential>` and a JSON body naming exactly the grant's owner, evaluation and deployment. Any other method is `405`; any other path under `/auth/launch-evaluator`, a query or an `Upgrade` header is `404`; another `Origin` is `403`; a wrong credential, scheme, field or value is `401 That launch evaluator credential isn't valid for this preview.` and records nothing. Neither route sets a cookie or makes a session or token: the credential means nothing on `/api`, a page or a socket, and the automation session's read-only limits are untouched (it still can't `POST /api/observations` or read or end `/api/observations/<id>`). Both count against the evaluation's `/auth` rate limit. Answers are `no-store` and `no-referrer`.

**Launch: `POST /auth/launch-evaluator/launch`**, body `{owner, evaluation, deployment}`.

1. The Directory inserts the grant's one run as `launching`, keyed by the credential's digest, for the claimed active owner only. A grant that has a run, whatever its phase, is spent: `409 This launch evaluator grant has run already; it runs once.`, and nothing is asked.
2. The Worker calls the owner's space over Durable Object RPC (`launchForEvaluator`), never over HTTP, so no request a client builds can reach it. The space refuses unless the evaluator is on in its own environment, it is the fixture's seeded space, active, not erased, its ledger readable, and either **nothing in its ledger is unresolved** or the isolated-preview exception below applies. The desk never replays an open record for the evaluator, so nothing is asked of the host about any earlier observation. Nothing waits between that check and the desk recording its intent. The answer names the one record the launch added, and only if every earlier record is exactly as it was.
3. The run moves once: to `open` with the fresh ID, `launch_refused` (nothing started: `409`, with `reason` such as `unresolved` or `not-opened`) or `launch_uncertain` (`502`). An uncertain run never ends from here. Each `open` or `launch_uncertain` answer, and its log line, carries one fixed `classification` and nothing else about the cause: `certain_open`; `owner_space_rpc_failure` (looking up the owner's space or its RPC threw before it answered); `space_answer_malformed`; `space_launch_uncertain` (the space itself answered uncertain); or `post_rpc_recording_failure` (the space answered a certain open observation, but the Directory couldn't record it for the run, so nothing may end it from here). No exception text, ID, token, address or record state is in the answer or the log. The runner reports the classification as `launch.classification` when it is one of these words, and `null` otherwise.

A `201` is `{run: {phase: "open", deadline, observation: {id, status: "open", notAfter}, alongside}, viewer, runToken}`, where `alongside` is the earlier unconfirmed record the fresh one started beside, or `null`. `deadline` is at most 10 minutes after the launch and never past the grant's `notAfter`. `viewer` is the host's address for this launch (`https://<bridge host>/<launch>/viewer/#ticket=…&clipboard=0`), and `runToken` is 32 random bytes the Directory keeps only as a digest. Both are in this answer only and never logged.

**End: `POST /auth/launch-evaluator/end`**, body `{owner, evaluation, deployment, observation}`, with `x-pim-launch-evaluator-run: <run token>`.

The Directory moves the run from `open` to `ending` only if the run token's digest matches, the run is `open`, its deadline hasn't come, the owner is still the claimed active one, and `observation` is exactly the ID it recorded. The earlier observation, any other ID, a second End, an End after an uncertain launch, or one past the deadline is refused before the space is asked (`409 This run can't end that observation now.`, or `401` without the run token); past the deadline the run becomes `expired`. The Worker then calls the space's `endForEvaluator` with the recorded ID, which asks the desk for its ordinary End only while that record is `open`. The run moves once more, to `ended` (`202`, a request, not closure), `end_refused` or `end_uncertain` (`502`), and is over for good.

```diagram
 launching ──▶ open ──▶ ending ──▶ ended | end_refused | end_uncertain
     │           │
     │           └──▶ expired
     └──▶ launch_refused | launch_uncertain
```

Nothing here reads an observation's status, reconciles, resets, enrolls, changes an identity or a fixture, or retries. Logs are `preview.launch-evaluator` with an action, an outcome, the owner and the fresh ID, never a credential, token or address.

## The runner: `launch-evaluator-cli.ts`

```sh
node computer/cua-host/launch-evaluator-cli.ts --origin https://pim-cua-eval.ajac-zero.com \
  --viewer-origin https://<bridge host> --config-file ~/.config/pim-launch-evaluator/evaluator.json \
  --deadline <the evaluation's ISO deadline> --playwright-dir ~/.local/share/pim-agent-preview [--browser-channel chrome]
```

It needs the same Playwright install and protected directory as the diagnosis (`docs/agent-preview.md`), and the same rules for `--browser-channel chrome`. Every option is given at most once; there is no option for an observation ID, an executable path, a launch argument, a profile, storage state or a CDP endpoint, and none for a retry. `--origin` and `--viewer-origin` must equal the file's. It refuses to begin with under two minutes left. It prints one JSON line, `launch-evaluator.result`, and exits 0 only for `qualified`; 1 for any other outcome or a failure before the launch (one fixed line on standard error); 2 for wrong arguments. The order is fixed:

1. Launch a fresh headless browser (bundled Chromium, or exactly the system Chrome), make a new context with no downloads, service workers, permissions, stored state or recording, add a script that refuses microphone and screen capture, the clipboard and file pickers, and install the WebSocket and request routes. All of this before anything is sent: a failure here launches nothing.
2. The launch, once, through the context's request object. A thrown request, a redirect, a `5xx`, a `409 launch_uncertain`, or a `201` lacking any of an open status, a well-formed fresh ID, a run token and a deadline within 10 minutes is `launch-uncertain`; a `401`, `403`, `404`, `405`, `429` or other `409` is `launch-refused`. Either stops the run with no viewer and no End.
3. The viewer, for the new launch only. The address must be exactly the adapter's for one launch at `--viewer-origin`. While this step runs, the page may make only `GET`/`HEAD` of the launch's six viewer files and `POST` of its seven view-only calls (`GetCapabilities`, `ListTargets`, `OpenMedia`, `SetPreferences`, `RequestKeyframe`, `CloseMedia`, `Join`) on the viewer's origin, with no query; everything else, every Pim URL included, is aborted. Every WebSocket is answered by the context and closed (`1008`), but `wss://<viewer host>/<launch>/media?ticket=<token>`, at most 4 of them, which is connected. Up it go only `request_keyframe` and `frame_ack` text messages; anything else (input, actions, geometry, a binary microphone packet) is dropped and closes it. Down it, a `session_opened` that isn't `view_only` with observe-only geometry closes it. The viewer qualifies on a view-only `session_opened` and one frame, within 30 s and always leaving 20 s before the run's deadline for the End. The harness itself only loads, reads the page's URL and closes; its page type has no other method. Before and after this step, every request and socket is refused. The context must hold no cookie afterwards.
4. The End, once, of the launch's own ID, whether the viewer qualified or failed, while the run's deadline (the earliest of the Worker's, `--deadline` and 10 minutes after starting) hasn't come; otherwise `expired`, with no End. A thrown End or a `5xx` is `end-uncertain`, a refusal `end-refused`; neither is retried.
5. The browser closes, always, and a timer closes it at the run's deadline whatever is running.

The report holds fixed words, counts, HTTP statuses, the run's phases and the fresh ID: never the credential, run token, viewer address, ticket or attach token, and it is checked for each before it is printed. No screenshot, trace or HAR is taken.

## The isolated-preview exception: one fresh observation beside one unconfirmed record

The space admits one unresolved observation at a time, and the earlier Watch in this evaluation left one record `unconfirmed`. That record stays as it is, permanently and visibly: nothing here reads its detail, ends, reconciles, resets, reclassifies or rewrites it, and no owner, space, fixture or identity is made to get past it. As an explicit exception, isolated to this evaluator in `PREVIEW_MODE=cua-eval`, the grant may name that record in `existingUnconfirmed`. Then, and only then, the space starts the run's one fresh observation beside it, if at that moment:

- the ledger holds exactly one unresolved record;
- it is the named one; and
- it is `unconfirmed` (not `pending_open`, `open` or `revoking`).

`evaluatorAdmission` (`preview/launch-evaluator.ts`) decides this from the space's own copy of the grant, not from anything the caller sends, and the desk checks it again (`ObservationDesk.launch`'s `alongsideUnconfirmed`, which only this RPC passes). Otherwise the launch is `launch_refused`, with `reason` `unresolved` (another unresolved record, two of them, or none named), `named-not-unconfirmed` or `named-not-found`, nothing is recorded or asked, and the grant is spent. The run records which record it started beside (`alongside_id`), and its End can't name that record. Once the fresh record exists the ledger holds two unresolved, so no grant can start a third. The person's Watch and every other route keep the one-unresolved rule unchanged, and a deployment has neither the routes nor the policy. With `existingUnconfirmed: null` the evaluator starts only in a ledger with nothing unresolved, as before.

Before making the grant, read the earlier record's ID and status with the read-only diagnosis, and name it only if it is the one unresolved record and `unconfirmed`.

## Tests

- `computer/cua-host/test/launch-evaluator.test.ts` (49 tests, `node --test`): fake Playwright objects whose page, context, browser, routes and sockets are proxies that throw on any member the harness isn't meant to use. They cover the input file; the one-use order; a qualified run's exact sequence, headers, bodies and closing; every page request and socket refused but the new launch's, before, during and after the viewer step; twelve launch failures that stop with no viewer or End; ten viewer failures that each still send exactly one End; six End failures with no retry; the deadline (no start under two minutes, no End past it, the hard stop, the viewer's shortened window); the request, socket and message allowlists; the hardening script; type stripping, imports and a scan for input, clipboard, file, permission, profile, CDP and executable APIs; the bundled and `chrome` launches against a fake Playwright module; and the entry point's options.
- `test/cua-observation.test.ts`: the desk starts one observation beside exactly the named unconfirmed record only when asked by name, leaves it byte-for-byte unchanged, refuses a third, and refuses beside an open record, two unresolved ones or none, asking nothing; the person's Watch is refused as before.
- `test/preview-automation.test.ts`, "the launch evaluator" (16 tests, workerd, the real preview Worker and seeded space, a bridge written in `fetch`): a full run and its spent grant, with the earlier record unchanged and no secret logged; refusals that record and ask nothing (origin, credential, scheme, owner, evaluation, deployment, route, method, query, upgrade, the automation session and credential); off for each grant fault and in a deployment's entry point; an unresolved or open earlier record refusing the launch with nothing asked of the host; End only of the recorded ID with the run token, and `expired` past the deadline; uncertain and refused launches that can't be ended; a lost End that isn't retried; the exception end to end (the earlier record unchanged through launch and End, the person's Watch and the automation session refused, the old ID never ended, the grant spent, a new grant refused a third, a deployment refused); the exception refused beside an open record, two unresolved ones, another than the named one or none, each spending the grant; `evaluatorAdmission` against `pending_open`, `open` and `revoking`; each fixed classification; and, across the real Durable Object RPC, a flush that failed before the host was asked and an acknowledged launch the space couldn't record, each `space_launch_uncertain` with no ID on the run, though the space holds a second record that a restart restores `unconfirmed` beside the original.
- `test/preview-automation.test.ts`, "the owner's Watch through the evaluation's Worker" (5 tests): the ordinary route the evaluator doesn't take, `POST /api/observations` from the owner's passkey session through the gateway, the space's own storage and `storage.sync()`, and the real viewer client with its production bound (`MANAGE_MS`, shortened only where the client sets it), against a host written in `fetch`. The intent is written and flushed before the host is asked once, and the viewer is answered only then; a failed write or flush asks nothing, and a failed flush leaves a record that a restart restores `unconfirmed`; a thrown request, a proxy's `502` or `520`, a `503`, a redirect, HTML, cut-off JSON, an extra field, another viewer path, another key or a host's `unconfirmed` is `502` with the record `unconfirmed`, and no later Watch, status read, End or restart asks the host again; an acknowledged launch that can't be recorded hands out no viewer and blocks; a host that never answers is `lost (timeout)` and its late answer changes nothing; a deadline during the flush asks nothing (`not_opened`), and one during the host's answer hands out no viewer.
- The read-only diagnosis's 61 tests and the automation file's 8 are unchanged and pass.

## Not covered

Nothing here has run against the live evaluation, Cloudflare's runtime, a real bridge or host, or a real browser. In particular: whether Playwright 1.59.1's `routeWebSocket`/`connectToServer` carries the viewer's `rcdp.v2` subprotocol and binary frames through unchanged; whether the pinned viewer renders and qualifies in headless Chromium or Chrome 156 (WebCodecs, the worklets, the hardening script); whether the viewer makes requests outside the allowlist that it needs; the bridge's certificate and ingress for the media socket; real timings against the 30 s and 20 s windows; and Durable Object RPC between the Worker and the space on Cloudflare. The tests' hosts, storage faults and clocks are local stand-ins: they show what Pim does with each outcome, not which outcome a live launch met. A live `launch_uncertain` with nothing in the host's journal fits several of them (the space's RPC failing before the desk, a failed flush, or a request that never reached the host's launch manager), and none is shown to be the one. Setting the variables, making the credential and running the command are separate, approved steps.
