# C — Cutover fence: every entrypoint of the old system, and how to stop it deterministically

Scope: the deployed Cloudflare Worker `pim` (`wrangler.jsonc:3`) with its nine Durable Object classes, the Cloudflare Containers and the external daemons it drives. Goal: after the fence, the old system can cause no new side effect, so a snapshot is final and the new system is the only writer.

Labels: **[V]** verified by reading the cited lines in this tree (application source equals audited SHA `30818438`); **[U]** unverified, with the open question; **EXISTS** a control present in the old code or in Cloudflare; **PROPOSED** a control that does not exist, not implemented here.

Platform facts used below come from Cloudflare's documentation as read on 2026-11-16 (links in §8); they are not facts about this repository.

## 0. Findings that decide the procedure

1. **Account suspension is not a fence.** It stops new HTTP/WebSocket traffic and aborts the space's chat runs once, at the moment it is applied. It does not stop the `Pim` object's alarm (`Pim.alarm()` checks only the erasure mark), and most callbacks it fires check only the erasure mark, not suspension. It does not touch coding threads, the coding scheduler, sandboxes, remote Amp sessions, the Directory, HostOps, the personal computer or hosted-app processes. [V] §2.
2. **The erasure fence is destructive and cannot be used as a pause.** `#closed()` is true only while a deletion runs or after `pim_erased` is written, and writing it requires `deleteAll()` plus R2 deletion. [V] §7.
3. **An HTTP-ingress hard stop EXISTS and needs no code change:** any `PIM_RUNTIME` value other than `cloudflare`/`celld` makes `admitIngress` refuse every request with 503 before any routing (`src/runtime.ts:17-18,58,133-138`; first line of `serve`, `src/gateway.ts:523-524`). It covers every Worker route in §1. It covers nothing else: not alarms, not Durable Object-to-Durable Object calls, not `ContainerEgress`, not the Worker's outbound calls. [V]
4. **Alarms are the real residual.** Four classes can alarm (Pim, CodingThread via `Lifecycle`; CodingScheduler, Directory, HostOps directly); Auth, Gallery, WorkspaceContainer, WorkspaceCatalog have no alarm code. The Directory's alarm erases accounts' spaces (destructive). The CodingScheduler's alarm admits queued threads to slots (starts new execution). [V] §3.
5. **Deploying a new version does not stop active Durable Objects at once.** By default an active object keeps running its old code for up to 300 s (best effort) unless the deploy uses `immediate`, and a report from 2026-10 says `immediate` also waited 300 s before the rollout finished on 2026-10-30. A fence that relies on a deploy must verify, per object class, that old code is no longer running. [V docs, U in practice] §8.
6. **Some effects live outside Cloudflare and cannot be stopped by any Worker-side control:** remote Amp sessions (run in Amp's cloud), detached sandbox execs (up to 10 min), the personal computer's hosted-app backends and trigger observers, host operations already running on the host, containers until their inactivity timeout. [V] §4-§6.

## 1. HTTP and WebSocket entrypoints (the Worker has one handler)

`src/index.ts:16-20` exports only `fetch`. There is no `scheduled`, `queue`, `email` or `tail` handler [V: whole file read, 22 lines]. `wrangler.jsonc` has no `triggers`/cron, no `routes`, no queue or workflow binding [V: whole file read]. Custom domains/routes are set outside the repository (`docs/deployments/` is private, `AGENTS.md`); `workers_dev: true` (`wrangler.jsonc:8`) means a `*.workers.dev` address exists unless the deployment turned it off [U for production: ask the Cloudflare dashboard, see step 1 of §10]. The second public export is `ContainerEgress` (`src/index.ts:22`), a `WorkerEntrypoint` called by containers, not by the internet (§4).

Order inside `serve` (`src/gateway.ts:522-656`), each branch with its account gate:

| # | Route | Lines | Who may call; account gate | What it can cause |
|---|---|---|---|---|
| 1 | Ingress admission (runtime profile) | `gateway.ts:523-525`, `runtime.ts:133-149` | every request; refuses all if `PIM_RUNTIME` is invalid | the existing hard stop |
| 2 | Public artifact origin (`PIM_CONTENT_ORIGIN`) `GET /p/pa_…` | `gateway.ts:527-531`, `accounts.ts:89-98` | anyone; **no account gate** (reads Gallery + R2) | read only |
| 3 | App origin `<label>.<PIM_APPS_ORIGIN>` | `gateway.ts:532-534,366-396` | cookie/token of the app; `closed()` at 370-371 (suspended → 403, deleted → 410) | runs the app's backend, which lives on the person's computer (§5) |
| 4 | `/health`, `/api/themes*`, `/api/diagram`, `/install.sh` | `gateway.ts:535-553` | anyone | static |
| 5 | `PIM_PUBLIC_URL` unset → 503; other origin → 421 | `gateway.ts:541-547` | all later branches | an existing partial stop: not for rows 2, 3, 4 |
| 6 | `/mcp`, `/oauth/*`, `/.well-known/*` | `gateway.ts:563-565`, `mcpAccess` 170-185 | OAuth token or API token; `closed()`, guests refused, rate limited | MCP clients drive the space: start runs, call tools |
| 7 | `/auth/authorize`, `/auth/connections` | `gateway.ts:567-575` | signed-in browser; `closed()` via `signedIn` 143-153 | grants MCP clients |
| 8 | `/auth/*` registration, sign-in, token minting | `gateway.ts:577`, `accounts.ts` `handleRegistration`, `auth/index.ts` | anyone with passkey/code; suspended refused (`auth/index.ts:322,347,353,386,447,570,589`) | creates accounts (Directory), sessions, tokens: **state writes** |
| 9 | `/images/<owner>/<id>` (model providers fetch) | `gateway.ts:445-454,589` | signed URL; `closed()` at 451 | reads |
| 10 | `/app-pages/*`, `/shared/*` (SPA), `/api/shared/*`, `/api/bots/*` | `gateway.ts:313-331,462-476,590,594-603`; `accounts.ts:195-205` | anyone; shared chat uses `closed()` at 469; bot card checks the admin's account | reads |
| 11 | `/hosted/enter`, `/hosted/<owner>/<id>/<token>/…` | `gateway.ts:414-439,339-348,591-592` | app token; `closed()` at 345, 430 | runs the app's backend |
| 12 | `/mcp/callback/*`, `/mcp/client/*`, `/mcp/events/<owner>/<key>` (connector OAuth return; **webhook ingress**) | `gateway.ts:221-304,605-608` | public; events are checked by the subscription's secret inside the space; `closed()` at 245, 297 | a connector event can fire a trigger → run |
| 13 | `/api/computer/connect` (WebSocket, `pimc_` token) | `gateway.ts:483-494,614` | computer token; `closed()` + rate limit at 488; Pim checks token (`pim.ts:1947-1953`) | opens the person's computer to the space |
| 14 | `/api/computer-host/sync` (`pimh_` token) | `gateway.ts:497-504,615`; `directory.ts:773-804` | host token checked by the Directory; **no account gate** | hands the host "create/delete this space's computer" requests |
| 15 | `/api/coding/git/*` (git broker, `pimgit_` token) | `gateway.ts:617`; `git-broker/worker.ts:77-79`; `packages/coding/src/git-broker/routes.ts:124-133` | stateless HMAC token, ≤12 h (`broker.ts:139-140,172-181`); **no account gate, no revocation** | clone/fetch/push to the git host; a push is reported to the thread (`worker.ts:78`) |
| 16 | `/api/coding/gateway/*` (model gateway, `pimgw_` token) | `gateway.ts:619`; `model-gateway.ts:121-130,671-681`; `thread-do.ts:1963-1970` | HMAC token + thread nonce (revoked by abort/archive, `thread-do.ts:1354,1440`); **no account gate**; the space key is read with only the erasure check (`space/coding.ts:69-72`) | calls Anthropic/OpenAI with the space's key |
| 17 | `/api/hostops/agent/*` (host daemon, `pimhostops_` token) | `gateway.ts:621`; `hostops.ts:792-837` | daemon token; **no account gate** | hands queued host operations to the daemon |
| 18 | `/api/*` for a person (session cookie or `pim_<owner>_<secret>` token): `admit` → accountApi, adminApi, socialApi, codingApi, codingVaultApi, giteaApi, then the space; `/api/hostops/*` for the admin | `gateway.ts:129-167,622-655` | `closed()` (403 suspended / 410 deleted) at 133, 147; rate limit `API_LIMITER` | everything a person can do, including `/api/ws` (WebSocket), `/api/browser/live`, `/api/computer/screen`, `/api/notes/live` (`gateway.ts:644-655`) |

Consequences [V]:

- A suspended account is refused at rows 3, 6, 7, 9 (via `closed()`), 10, 11, 12, 13, 18 and inside the `Pim` object (`pim.ts:1945-1946`). It is **not** refused at rows 2, 14, 15, 16, 17.
- Rows 15-17 are the sandbox/host channels. A suspended space's sandbox can still clone, push (within a token's validity) and call its model until its gateway nonce is revoked, which only `abort()`/`archive()` on the thread do.
- `resolveAccount` caches an account for `ACCOUNT_CACHE_MS = 30 000` ms per isolate (`accounts.ts:33,42-49`); suspension calls `forget` only in the isolate that handled it (`accounts.ts:1000`) and relies on the space's own check for the rest ("the space stops at once, whatever other Workers still have cached", `accounts.ts:998`).
- Sign-in and registration (row 8) write to the Directory and Auth objects; any write after the snapshot is lost or diverges, so row 8 must be blocked, not just rate limited.
- The one existing front-door switch for row 8 alone is `PIM_REGISTRATION=closed` (`deployment.ts:108`, `accounts.ts` registration policy); it does not stop sign-in or tokens.

## 2. Account suspension: exactly what it does

Trigger: `POST /api/admin/accounts/<username>/suspend` by the admin (`accounts.ts:992-1002`). It refuses to suspend the admin themself (993) and any account that is not `active`/`suspended` (994), including `pending`, `deleting`, `deleted`. Steps: `Directory.setStatus` writes `status='suspended'` (`directory.ts:510-519`); then `Pim.setStatus('suspended')` (`pim.ts:1996-2004`) writes `STATUS_KEY` into the space's meta, aborts every session `harness.sessions.list()` via `#conversations.abort` (`conversations.ts:937-939`, bounded by `STOP_WAIT_MS = 5 000`, `conversations.ts:37`) and closes every connection with code **4003** "Suspended" (`pim.ts:2002`).

What the status stops [V]:

| Effect | Evidence |
|---|---|
| New requests at the Worker (403) and at the object (403) | `gateway.ts:123,133,147`; `pim.ts:1946` |
| New runs from any source (user, trigger, task, room, MCP, coding wake-ups, approvals): `submitTo` throws 403 | `conversations.ts:131`; `#hear` skips wake-up `conversations.ts:747` |
| Utility-model side calls | `models.ts:579` |
| Trigger firing: engine `state()` returns `suspended`, host returns retryable/suspended | `space/triggers.ts:605`; `packages/triggers/src/host.ts:193-195,220-222,280-282,323` |
| Sign-in, new passkeys, setup/recovery codes | `auth/index.ts:322,347,353,386,447,570,589` |
| Guest approvals, hosted-app entry | `sharing.ts:157,645`; `pim.ts:2157-2158,2169` |
| Sockets: closed with 4003 once, at suspension | `pim.ts:2002`; new upgrades are refused by `#fetch` |

What it does **not** stop [V unless marked]:

| Item | Why | Evidence |
|---|---|---|
| Runs in flight when applied | `abort` is a 5 s-bounded race (`within`); the underlying abort continues but its durable completion is not proven by the 5 s wait | `conversations.ts:937-939`. **[U]** whether `PiSession.abort` durably ends every task, including generation tasks held for a retry; search: `agents/dist/harness/pi/index.js:634-640`, `conversations.ts:1011,1036`; pi-durable internals not read |
| `PiHarness` wake jobs (`cf_agents_jobs`, fn `wake`, `recoveryLoop`) | created at start for every session that has any task row, re-created while tasks are live; nothing in `setStatus` removes them; opening pi resumes durable tasks | `agents/dist/harness/pi/index.js:348-364,486-493`; `pim.ts:624` |
| The physical alarm | `Pim.alarm()` returns early only when `#closed()` (erased), not when suspended | `pim.ts:1964-1967` |
| `agents` schedule callbacks (jobs in `cf_agents_jobs`) | dispatched by name by the scheduler capability with no status check | `agents/dist/scheduler-DZ3xQfeK.js:178-232`; table of callbacks below |
| MCP reconnects | every wake runs `MCPClientManager.onStart` → `restoreConnectionsFromStorage` → reconnect each saved connector (outbound HTTP, token refresh) | `agents/dist/client-1tEQ1Oqz.js:1304-1311,1619-1665`; registered via `this.lifecycle.use(...).use(this.mcp)` at `agents/dist/src-DgCbZtIR.js:1957` |
| `Pim.onStart` work on every wake | `resumeTasks`, `resumeDecided`, `armWatchdog`, `ensureTriggerEngine`, `computer.call('unwatch_all')`, restores socket watches | `pim.ts:1162-1197`; `conversations.ts:600-612,1032-1048` |
| Coding threads, scheduler, sandboxes, remote orbs | no suspension code anywhere under `src/coding` (`rg -i suspend src/coding` finds only workspace "suspend") | §4 |
| Directory alarm, HostOps alarm | separate objects | §3 |
| Personal computer, hosted-app backends, displayd, host operations in progress | outside the Worker | §5 |
| Admin's own space | cannot be suspended through the API | `accounts.ts:993` |

Callbacks fired from the `Pim` alarm (all registered through `this.schedule(...)`, stored in `cf_agents_jobs`; in agents 0.27.0 the legacy `cf_agents_schedules` table is migrated into `cf_agents_jobs` and dropped, `scheduler-DZ3xQfeK.js:361-403`):

| Callback | Source | Guard | Side effect while the space is suspended |
|---|---|---|---|
| `runTriggerTick` | `pim.ts:1349`; `space/triggers.ts:556-571` | engine's own `suspended` state for firings. **`subscriptions.tick()`, `computerTriggers().renew()`, usage rollup and re-arm are not guarded** | connector subscription renew/subscribe calls to providers; frames to the computer; re-arming the schedule |
| `pushReply` | `pim.ts:1429-1446`; scheduled at `pim.ts:1077,1436` | `#closed()` only | Web Push to the person's devices (`sendPush`, `pim.ts:1485`) |
| `expireApproval` / `expireGuestApproval` | `approvals.ts:500-505`; `sharing.ts:391-393`; scheduled `approvals.ts:130`, `sharing.ts:362,858` | `closed()` / `assertOpen()` only (`approvals.ts:178`) | with `onTimeout: "approve"` (auto policy, `extensions/approvals.ts:131`, 30 s `approvals.ts:28`) it runs the approved action (`approvals.ts:198-211`) **only if its tool call is still waiting**: `waitingCall` returns null once an abort ended the call, and the approval is then denied without running (`approvals.ts:189-194`). Safe only if the abort in `setStatus` completed. Guest/coding approvals use `onTimeout: "deny"` (`sharing.ts:357,855`, `space/coding.ts:168`) |
| `expireReview` | `approvals.ts:617-619` → `#escalate` `approvals.ts:600-614` | `closed()` | creates a notification and delivers it (push) |
| `watchRuns` | `conversations.ts:995-1021`; scheduled `984` | `closed()` | may `stop()` a stalled run; re-queues events through `submitTo` (blocked by status) |
| `retryAfterCooldown` | `models.ts:120-131` | `closed()` only | `resumeHeld` calls `resumeTask` directly (`models.ts:183-190`), not `submitTo`, so a held model run resumes (model call) if its hold survived the abort. **[U]** whether abort ends held generation tasks |
| `PiHarness` `wake` | pi (above) | none | resumes/continues durable runs on the alarm |
| `cf:keep-alive` host job | `agents/dist/src-DgCbZtIR.js:1365,2858-2879` | in-memory refcount, 30 s interval (`:1361`) | keeps the instance and alarm alive while `keepAliveWhile` work runs (`pim.ts:337,1060`, `space/conversations.ts:165,192,257`, `approvals.ts:112,203`) |

Other outbound effects reachable from a suspended space's wake [V]:
- **Notifications and push:** `deliverNotification` checks `#closed()` only (`pim.ts:1400-1406`); `#pushNotification` `pim.ts:1466-1485`.
- **Email:** only through the `send_email` tool (`extensions/messaging.ts:282`, `pim.ts:1112`) using the `EMAIL` binding, which is commented out in `wrangler.jsonc:97` [U whether production enabled it: dashboard]. No alarm sends email by itself; a model run is needed, and runs are blocked by status.
- **Memory nap:** started only by tools or API calls (`pim.ts:1046-1060`, `space/routes.ts:1511-1567`), as a durable pi task with `keepAliveWhile`; not alarm-initiated, but a nap task in flight is resumed by the pi wake like any task [V for starts; U for suspension timing].
- **Connector/MCP tool calls:** `call` asserts open (`pim.ts:405-407`) but not status; reached only from runs or triggers, both status-gated.

## 3. Durable Object alarms and timers, class by class

Search: `rg 'setAlarm|getAlarm|deleteAlarm|async alarm\(|alarm\(\)' src cloudflare-container.ts cloudflare-egress.ts packages` (tests excluded) and the `agents` Lifecycle files. Findings [V]:

| Class (binding) | Alarm mechanism | Lines | What a firing does | Destructive? |
|---|---|---|---|---|
| `Pim` (one per owner) | `agents` `Lifecycle` job queue → one physical alarm (`rearmAlarm`, `lifecycle-CFu6OV03.js:1114-1127`); `alarm()` override | `pim.ts:1964-1967` → `agents/dist/src-DgCbZtIR.js:3883-3889` → `lifecycle-CFu6OV03.js:1156-1161` | runs due jobs: pi `wake`, scheduled callbacks (table in §2), keep-alive; deadman re-arm each drive (`lifecycle-CFu6OV03.js:567`) | no |
| `CodingThread` (one per thread) | same `Lifecycle` (`thread-do.ts:303-307`), job `advance` (`thread-do.ts:4889`), `onJob` | `thread-do.ts:785-815,2276-2280`; `onStart` re-arms for any non-archived thread `781` | `#enforceCompute`, `#failIfStuck`, `#keepSessionAlive`, `#advance`: admits slots, creates/starts workspaces, starts turns, polls remote orbs, ends turns, recovers CLI runs, stalls notices to Pim | no (but starts execution) |
| `CodingScheduler` (`CodingSchedulerDO`, one per space) | native `setAlarm`/`alarm()` | `scheduler-do.ts:500-509,564-574` (30 s tick, `TICK_MS`) | `#reconcileLogins` (ends compute stretches in Gallery), `tick()` admits queued threads / expires idle slots, `#deliver` notifies each thread's DO (`admitted` starts that thread's workspace) | no (but starts execution) |
| `Directory` (singleton `"directory"`; also a rate-limit object) | native | `directory.ts:653-674` | `#releaseLapsed` (pending registrations older than 24 h, `PENDING_MS`, `directory.ts:96,405-408`) and cleanup jobs: **calls `Pim.deleteEverything()` then `Auth.deleteEverything()` and Gallery forgets** (`directory.ts:607-633`) | **Yes: erases spaces** |
| `HostOps` (singleton) | native | `hostops.ts:374-404` | expires queued ops after 10 min, fails running ops past their deadline; DB writes only | no external effect |
| `Auth` | none found | `src/auth/store.ts:128` class; no alarm API in `src/auth/` | — | — |
| `Gallery` | none found | `gallery.ts:489`; no alarm API | — | — |
| `WorkspaceContainer` | none in the DO; the container has a platform inactivity timer `setInactivityTimeout(30 min)` | `cloudflare-container.ts:10,50,88,248-289`; constructor cleans up a container that outlived the isolate `:43-58` | — | — |
| `WorkspaceCatalog` | none | `cloudflare-container.ts:290-299` | — | — |

Notes:
- Pim's and CodingThread's alarms are re-armed on every start (`_syncHostJobs` after `onStart`, `agents/dist/src-DgCbZtIR.js:2175`; `thread-do.ts:781`), so a snapshot taken without freezing them can be stale immediately.
- A job whose callback is missing is **dropped as done** (`scheduler-DZ3xQfeK.js:222-226`). A maintenance class that extends `Agent`/uses `Lifecycle` without the callback methods would **destroy** schedule rows. A maintenance class must not run `Lifecycle` at all (§10, PROPOSED).
- `deleteAll()` also deletes the alarm for compatibility date ≥ 2026-02-24 (`wrangler.jsonc:5` is 2026-09-24), which `deleteEverything` relies on.

## 4. Coding: threads, scheduler, sandboxes, remote Amp, vault, broker

**Nothing in `src/coding` consults the account's suspension state.** [V: `rg -i suspend src/coding src/hostops.ts src/mcp-server.ts` finds only workspace-suspend code.] What each part does while the old Worker or Durable Objects run:

- **Thread turns (CodingThreadDO).** `onStart` re-arms `advance` for every non-archived thread (`thread-do.ts:779-782`); `#step` returns only for archived/failed/waiting_input (`:2304`), so an idle thread with an inbox starts a turn, and a thread with `currentOperation` is recovered (`#endCliTurn(…#recoverCliRun)`, `:2312-2316`). Stopping one thread: `abort()` (`:1346-1362`: clears inbox, **revokes the gateway nonce** `:1354`, stops the turn and commands) and `archive()` (`:1436-1451`: also stops the remote orb, gives back the slot, deletes the workspace, cancels the job `:1449`). Both are reachable only through `/api/coding/threads/...` (`src/coding/routes.ts`), which needs the owner's own session or token; a suspended owner is refused at `gateway.ts:123,133,147`. **There is therefore no existing admin path to stop a suspended person's coding threads.**
- **Scheduler.** Admits queued threads and expires idle slots on its alarm (`scheduler-do.ts:500-509`); thread DOs are told through `threadNotifier` (`:111-113`, `#deliver` 533-557). The alarm self-deletes only when nothing is queued or pending and every slot is `running` (`:564-569`), i.e. with an idle or queued thread it keeps ticking every 30 s.
- **Cloudflare Containers.** `WorkspaceContainer` is a plain `DurableObject` with `ctx.container` (`cloudflare-container.ts:248-289`), one per workspace; `WorkspaceCatalog` (`:290-299`, instance `"workspaces"`, `packages/coding/src/workspace/cloudflare.ts:195`) lists every session id (`add` at `cloudflare.ts:52`, `remove` `:119`, `list` `:122`) and is the enumeration of live containers. A container outlives the isolate and a deploy (`cloudflare-container.ts:43-58`); the platform stops it after 30 min of inactivity **without a snapshot** (`:6-10,50,88`) [U whether a CLI process doing outbound-only work counts as activity]. Its outbound HTTP/S is intercepted by `ContainerEgress` (`:301-307`, `interceptAllOutboundHttp`/`interceptOutboundHttps`, `:68-81`), which reads the policy from `WorkspaceContainer.egressPolicy()`; the interception is installed in the container and re-pointed at the current handler when the DO restarts (`:43-58`).
- **Model and git from a sandbox.** Rows 15 and 16 of §1 are the only paths a CLI harness has to a model or the git host; the keys never enter the sandbox (`space/coding.ts:55-72`: "kept in memory for the one request only"). With ingress refused, new model/git calls fail; calls already streaming complete or break with the isolate. [V design; U observed]
- **CLI harness processes.** On Compose sandboxes the exec has an id and survives a client disconnect for `AGENTD_DETACH_GRACE_MS` = 600 000 ms (`workspace-agentd/README.md:18,31`; id sent as `x-exec-id`, `packages/coding/src/workspace/compose.ts:344-393`); the sandbox manager's reaper removes sessions idle > `IDLE_MIN` = 30 (`sandbox-manager/README.md:65,319`). So a CLI turn can keep running up to 10 min after the old Worker stops, and the box stays up ≤ 30 min idle. For the Cloudflare provider the same agentd runs in the container [U whether execs there are detached; search `packages/coding/src/workspace/cloudflare.ts`, not opened beyond 40-52, 119-137, 195].
- **Remote Amp sessions (`providerKind: "agent-hosted"`).** The run is in Amp's cloud: Pim only starts (`client.start`, idempotent by `threadId:operationId`, `thread-do.ts:2748`), steers, polls (`#pollOrb` `:2802-2850`, `orbPollMs`), mirrors messages and reads cost. No slot, workspace or container (`:2308`). Stopping the old system stops all of that polling (alarms gone) and **does not stop the remote agent**: nothing local keeps it alive and nothing local halts it. The only halts are `client.cancel` (real stop, WebSocket `client_cancel`, `amp-http.ts:157-158,225-270`; used by `abort()` `thread-do.ts:1346-1351` via `#cancelOrb` `:3040-3054`) and `client.stop` = `archiveThread`, which "may not halt a running agent" (`amp-http.ts:14`; `#stopOrb` `:3063-3085`). Both need the thread DO to run and the person's Amp login from the vault. Residual external effect: the agent can keep editing and pushing on Amp's side with Amp's own credentials; Pim's tokens are not involved. The new system must adopt the thread (`orb.threadId`) before polling, and must not steer it while the old system might. [V]
- **Vault.** Login workspaces and credentials: `src/coding/vault/*`; the scheduler holds `pim_coding_harness_login` workspaces (`scheduler-do.ts:434-455`) and ends their compute in the Gallery. Credential reads happen in the Worker/DOs only (`vault/worker.ts:15-28`). No alarm other than the scheduler's. [V for what was read; the vault package's own timers not searched: `rg setTimeout packages/coding/src/vault` not run → U]

## 5. Personal computer, hosts, displayd, hosted apps

- **Computer WebSocket** (`gateway.ts:483-494`; `pim.ts:1947-1953`; `space/sockets.ts:256-262,288-291,394-405`). Suspension closes it (`pim.ts:2002` iterates all connections). Commands run on the computer only when the space sends them, so with the socket closed nothing new arrives; `pim-computer` reconnects and is refused (403/410 at `gateway.ts:488`).
- **What keeps running on the computer** [V]: hosted-app backends "kept running when the space disconnects, since they belong to this process and not to a connection" (`computer/pim-computer.ts:1115-1121`); the triggers runtime keeps its observers until the space's lease runs out, at most 120 s (`computer/triggers-host.ts:224-228`, `computer/triggers-runtime.ts:33-34`), then stops them. A poll/process/stream source's command runs as the user, so up to 120 s of local effects after disconnect; an app backend's effects (outbound requests it makes itself) continue indefinitely. The Worker cannot stop these.
- **Computer host and host operations** (`gateway.ts:497-504,621`; `directory.ts:773-804`; `hostops.ts:792-837`). Both are polled by daemons that need no inbound port. Fencing the Worker stops new requests being handed out (create/delete computer requests live in the Directory `computer_requests`; HostOps ops live in its `ops` table) but not an operation the daemon already took: it runs to completion and its result report is refused. `RETAKE_MS` = 20 min (`computer-host.ts:26`) means unreported requests are handed again after the host reaches a Worker again; a new system must not inherit stale `delete` requests blindly [V for mechanism; policy is the new system's].
- **displayd** is a loopback-only host service (`displayd/README.md:1-5`) reached through `pim-computer`; it stays up independent of the Worker. No external effect without a driver [U: not read beyond the README header].

## 6. Model provider calls in flight, outbound effects

- A turn's model call runs inside the `Pim` (or `CodingThread`) object with an abort signal; `abort` cancels it, an isolate reset drops the connection. The provider may still bill or finish the request [U: provider-side behavior]. Workers AI calls use the `AI` binding with `remote: true` (`wrangler.jsonc:21`).
- Tool calls with external effects (HTTP, connectors/MCP, email, git push, browser, files on the computer) are gated actions (`AGENTS.md`, `src/extensions/approvals.ts`) or run inside a run; they all need a run or an approved action, both of which §2 bounds; none starts by itself except the unguarded items in §2 (push, subscription ticks, MCP restore).
- Git push: a sandbox push goes through the broker row 15 with an approved push token; a coding thread's own push request is an approval with `onTimeout: "deny"` (`space/coding.ts:168`).
- Telemetry export (OTLP) is optional and outbound only (`pim.ts:1219-1222`).

## 7. The erasure fence (`pim_erased`, `#closed()`): destructive, not a pause

- `#closed()` is `#erasing || store.erasedAt() !== null` (`pim.ts:1901-1903`; `store.ts:150,358-370`). It makes `fetch` return 410 (`pim.ts:1945`), `onRequest` 410 (`2092`), `alarm()` a no-op (`1964-1967`), and most callbacks return early.
- The only way to set it is `deleteEverything` (`space/reports.ts:431-461`): sets `erasing`, closes sockets with 4010, aborts runs and removes connectors' subscriptions as a "courtesy" with a timeout, **deletes images and app files in R2** (`:453-454`), quits the browser, **removes the person's computer machine** (`:456`, `pim.ts:2274`), **`ctx.storage.deleteAll()`** (alarms included), writes the mark, `ctx.abort`. Irreversible. Directory then also erases the Auth object and Gallery rows (`directory.ts:607-633`) and marks the account `deleted`.
- Running it as a fence would destroy exactly the data being migrated. **Do not use it.** Reading `pim_erased` is useful only as a check that a space was *not* erased.

## 8. Cloudflare platform facts relied on (from Cloudflare docs; not from this repository)

1. **Code updates are deferred by default:** active Durable Objects keep running their old code up to `max_delay` = 300 s (≤ 86 400) or until they hibernate; `immediate` / `max_delay: 0` resets them at once; best effort ("Durable Objects code updates", https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/). A workers-sdk issue (https://github.com/cloudflare/workers-sdk/issues/16235) reported `immediate` still waiting 300 s until the 2026-10-30 rollout; it was closed on 2026-11-09 as fixed. An object that keeps a 1 s alarm never hibernates, so Pim and thread objects with live work are exactly the ones that defer. WebSockets of a forced reset are terminated (https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/). **[U]** whether `immediate` takes effect for this account: verify by observation, not by trusting the flag.
2. **Removing a binding does not delete data;** deleting a class (`deleted_classes` migration or `exports` tombstone) deletes the namespace and all its data permanently, requires the class to be absent from code and from other Workers' bindings (https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/, `.../durable-objects-migrations`). Rollbacks cannot cross a lifecycle change. This repo uses `migrations` (`wrangler.jsonc:44-53`), not `exports`.
3. **An alarm fires in whichever deployed code the object runs**; a class stays reachable as long as the Worker exports it. Alarm semantics: one per object, at-least-once, retried with backoff up to 6 times on throw; `deleteAlarm()` inside the handler may not stop retries (https://developers.cloudflare.com/durable-objects/api/alarms). **[U]** what happens to a pending alarm of a class whose binding was removed but whose class export remains, or whose export was removed without a delete migration: I found no documentation; do not rely on it.
4. In-flight HTTP/RPC requests on a shutting-down object finish unless they touch storage; WebSockets terminate (lifecycle page above).

## 9. Controls that exist, and those that do not

EXISTS:

| Control | Effect | Limit | Cite |
|---|---|---|---|
| `PIM_RUNTIME=<invalid>` (a Worker variable; `keep_vars: true`, `wrangler.jsonc:86`) | every Worker request refused 503 at the first line of `serve`; also refused for rows 2, 3, 14-17 | nothing below the Worker; takes effect per new Worker version (deploy), not instantly across in-flight requests | `runtime.ts:17-18,58,133-138`; `gateway.ts:523-524` |
| Unset `PIM_PUBLIC_URL` | 503 for rows 5-18 | not rows 2, 3, 4; and it is a variable that also leaves `/health` | `gateway.ts:541-545` |
| `PIM_REGISTRATION=closed`, `PIM_MAX_ACCOUNTS` | stops new accounts | not sign-in | `deployment.ts:108`; `accounts.ts` registration |
| Admin suspend/unsuspend per account | §2 | not the admin; not alarms; not coding | `accounts.ts:992-1002` |
| Per-thread `abort`/`archive` (owner only) | stops a thread, revokes its gateway nonce, cancels/archives the remote orb | needs the owner's session; refused for suspended owners | `thread-do.ts:1346,1436`; `coding/routes.ts` |
| Admin delete account | erases the account (destructive) | §7 | `accounts.ts:1027-1030` |
| `Directory.stats()` cleanups `queued`/`failing`, accounts by status | read-only readiness check | — | `directory.ts:689-701`; `accounts.ts:990` shows `cleanup` per account |
| `WorkspaceCatalog.list()` | enumerates all Cloudflare workspace ids | Worker-internal RPC, no HTTP route | `cloudflare-container.ts:293-296` |
| Cloudflare: deploying a version, rolling back, `--durable-objects-code-update-mode`, disabling `workers.dev`, removing routes/custom domains (dashboard) | see §8 and §10 | — | docs above |

DO NOT EXIST in the old code (searched: `rg -i 'maintenance|freeze|drain|read-only|kill.?switch' src packages` (tests excluded) matches only unrelated text, such as a read-only git token and diagnostics, not a handler, flag or route):

1. A deployment-wide maintenance or read-only mode inside the Durable Objects (only the front-door switch above).
2. A bulk "suspend everyone including the admin".
3. A way to stop an account's coding threads, scheduler or sandboxes except the owner's own API call (and suspension blocks that call).
4. A way to cancel `cf_agents_jobs` for a space, or to disable `PiHarness` wake, short of `deleteEverything`.
5. A revocation of git-broker tokens (only expiry ≤ 12 h, `broker.ts:139-140`) or of gateway tokens by space/deployment rather than per thread nonce. Rotating the Directory `cookie_key` would invalidate broker, gateway and session/auth tokens at once (`directory.ts:237-241`, `git-broker/worker.ts:16-27`, `model-gateway.ts:100-113`, `auth/index.ts:143-167`) but there is **no rotation function**; the key is created once and never reset (`directory.ts:237-241`).
6. An object-version probe: no route or RPC reports which code an object runs. `CF_VERSION_METADATA` is bound (`wrangler.jsonc:100`) but is read only for the claim window (`runtime.ts:172-176`).

## 10. PROPOSED procedure (ordered; each step with its check)

Nothing below is implemented. Steps 1-4 use only controls that EXIST. Steps 5-8 need either a small, separately reviewed old-side change or a Cloudflare-level maintenance version.

Assumptions: the admin can sign in; the new system takes its snapshot after step 9; the old deployment can be rolled back until step 10.

**Step 1 — Inventory the ingress surface (read-only).**
Record, from the Cloudflare dashboard: all routes and custom domains bound to `pim`, whether `workers.dev` is on, the current version id, which variables are set (`PIM_PUBLIC_URL`, `PIM_CONTENT_ORIGIN`, `PIM_APPS_ORIGIN`, `PIM_RUNTIME`, `PIM_CODING_MANAGER_URL`, `PIM_EMAIL_FROM`), whether the `EMAIL` binding exists, and the container application. Check: a list of every hostname that reaches the Worker; each will be probed in step 4.

**Step 2 — Readiness of the destructive paths (EXISTS).**
Via the admin API read `Directory.stats` (`directory.ts:689-701`) and each account's `cleanup` (`accounts.ts:990`). Require: `cleanups.queued == 0`, no `deleting` accounts, and no `pending` account within a few minutes of its 24 h lapse (`directory.ts:96,405-408`); otherwise wait for the Directory alarm to finish them **before** the fence, because after the fence nothing will, and a snapshot taken mid-erase is inconsistent. Check: counts are zero.

**Step 3 — Close the doors that create state; announce (EXISTS).**
Set `PIM_REGISTRATION=closed` (variable change = new version). Stop creating coding threads and approvals by telling people; there is no switch. Check: `POST /auth/register` refused with the closed-registration error.

**Step 4 — Quiesce what suspension can quiesce (EXISTS), before ingress is fenced, because the admin API goes down with it.**
For each `active` non-admin account, `POST /api/admin/accounts/<u>/suspend` (`accounts.ts:992-1002`), paced under `API_LIMITER` (600/min per person, `runtime.ts:39-47`). Check per account: `GET /api/admin/accounts/<u>` returns `status: suspended` (`accounts.ts:987-990`) and a probe with the person's API token returns 403 "This account is suspended" from the Worker. Understand what remains (§2): alarms, coding, push, subscription ticks. The admin's own space cannot be suspended (`accounts.ts:993`); it is covered only by steps 5-7.

**Step 5 — Fence HTTP ingress (EXISTS).**
Deploy with `PIM_RUNTIME` set to an invalid value (for example `maintenance`) as a variable. Check: every hostname from step 1, for every route family in §1 (`/health`, `/api/health`, `/api/themes`, a `/p/…` link on the content origin, an app origin, `/mcp`, `/oauth/token`, `/api/computer/connect` with a bogus token, `/api/computer-host/sync`, `/api/coding/git/…`, `/api/coding/gateway/anthropic/v1/messages`, `/api/hostops/agent/poll`, `/auth/register`) returns **503 `This Pim isn't set up to answer requests yet.`** (`runtime.ts:138`); and `wrangler tail` shows no `pim.*` event except `pim.runtime_misconfigured` (`runtime.ts:137`). Also remove or disable `workers.dev` and any route not needed for the maintenance page. Residual after this step: everything below the Worker.

**Step 6 — Stop the alarms. Needs PROPOSED control A or B.** The old code offers none. Two options, in order of preference; use B as the sound fallback and verification for A.

*A (old-side change, PROPOSED, small): a durable freeze flag read before any work.* A shared guard `deployment frozen` (read from a Worker variable or a Directory meta key) checked at: `Pim.alarm()` next to `#closed()` (`pim.ts:1964`), `Pim.onStart` (`pim.ts:1162`), `CodingThreadDO.onJob`/`onStart` (`thread-do.ts:781,785`), `CodingSchedulerDO.alarm` (`scheduler-do.ts:500`), `Directory.alarm` (`directory.ts:653`), `HostOps.alarm` (`hostops.ts:402`) and `ContainerEgress.fetch` (`cloudflare-container.ts:302`), each returning without running jobs **and without re-arming**, plus `abort`+`archive` of every coding thread and revocation of its nonce in a bulk admin RPC. Rollout caveat: it only takes effect in objects that adopt the new code (§8.1); verify with step 7.

*B (Cloudflare-level hard stop, PROPOSED): a maintenance version of the Worker that exports every Durable Object class name as an inert shell.* Each class (`Pim`, `Auth`, `Directory`, `Gallery`, `CodingSchedulerDO`, `CodingThreadDO`, `HostOps`, `WorkspaceContainer`, `WorkspaceCatalog`) is a plain `DurableObject` whose `fetch` and RPC methods return 503 and whose `alarm()` returns without calling `setAlarm`, and which **never touches storage and never uses `Lifecycle`/`agents`** (missing callbacks drop jobs, §3). `ContainerEgress` denies every request. The bindings, `migrations` array, `containers` block and class names in `wrangler.jsonc` stay as they are, so no namespace is deleted and no storage is touched (§8.2). Effect on alarms: a due physical alarm invokes the shell, which returns, so the alarm is consumed and never re-armed; the SQLite rows (`cf_agents_jobs`, `cf_agents_state`, trigger tables, `pim_*`) remain intact for the snapshot. A pending alarm is not deleted by the deploy; it is neutralised when it fires. Deploy with `--durable-objects-code-update-mode immediate` (or `max_delay: 0`) because active objects otherwise run old code up to 300 s (§8.1). Rollback is redeploying the old version, which re-arms alarms on start for Pim and CodingThread (`src-DgCbZtIR.js:2175`, `thread-do.ts:781`) but not for the Scheduler/Directory/HostOps alarms, whose rows are recomputed only when something calls them [U: whether their next alarm is recomputed on first request; `directory.ts:664-674` recomputes on mutation, `scheduler-do.ts:564-574` on mutation]. Do **not** remove the class exports, the bindings or `migrations`, and do **not** add `deleted_classes`/`exports` tombstones: that deletes data permanently (§8.2); and do not remove the `containers` entry [U: effect on running containers].

**Step 7 — Verify that old code is no longer running, per class (deterministic observation).**
Because no probe exists (§9.6), use two observations: (a) `wrangler tail` after the deploy for ≥ 6 minutes (> 300 s default delay) shows no `pim.do_start` (`pim.ts:1196`), `pim.coding.*` or `pim.cleanup_failed`/`pim.deleted` events, and no `Lifecycle` jobs run; (b) for B, call one RPC per class (the Worker is the shell, so a probe route in the maintenance Worker returns `X-Version` from `CF_VERSION_METADATA`) for the Directory, the Gallery, a sample of `Pim` and `CodingThread` ids (from `Directory.list`, `listThreads`) and the `WorkspaceCatalog` instance; each must answer from the shell. If an object does not, redeploy with `immediate`, or wait out the delay, then repeat. Check: every probed object reports the maintenance version.

**Step 8 — Stop what is outside the Worker.**
- *Cloudflare containers:* enumerate `WorkspaceCatalog.list()` (`cloudflare-container.ts:293-296`) through the maintenance Worker, and have the shell's `WorkspaceContainer` call `ctx.container.destroy()` for each; otherwise they stop at their own 30 min inactivity timeout (`cloudflare-container.ts:10`) without a snapshot. With `ContainerEgress` denying, a running container cannot reach a model or the git host. Check: `ctx.container.running` is false for every catalog id, or the container list in the Cloudflare dashboard is empty.
- *Compose sandboxes (sandbox-manager):* stop the manager or `DELETE` its sessions on the host; execs run ≤ 10 min after disconnect (`workspace-agentd/README.md:18`). Check: manager `GET /sessions` empty.
- *Remote Amp sessions:* **cannot be stopped from the Worker after the fence.** Before step 5-6, for each agent-hosted thread (`listThreads` filtered by `providerKind`), have the owner or a PROPOSED admin RPC call `abort()` (real cancel `thread-do.ts:1346-1351`) and record `orb.threadId`. After the fence the agent may keep working on Amp's side; record each `orb.threadId`, `lastEventAt` and state at the fence time, and let the new system decide to adopt, cancel or leave it. Check: the Amp thread list shows no `working` thread for the cancelled ids, accepting that `archiveThread` alone may not halt (`amp-http.ts:14`).
- *Personal computers:* nothing to do on the Worker side after the fence; the app backends and any process the person started keep running (`pim-computer.ts:1115-1121`); observers stop ≤ 120 s. Tell computer owners.
- *Host daemons (`pim-host`, `hostopsd`, `displayd`):* stop their services if the old system's tasks must end; otherwise they keep polling a refusing Worker. Check: no 200 from `/api/hostops/agent/poll`, `/api/computer-host/sync` in step 5 probes.

**Step 9 — Snapshot, then compare.**
Take the new system's snapshot only after steps 5-8 verified. Check that the Directory cleanup counts equal those of step 2, that `cf_agents_jobs` row counts per `Pim` are unchanged between two reads separated by > 2 minutes (no jobs consumed), and that coding thread `updated_at` values do not advance.

**Step 10 — Hold the fence until the new system is authoritative.** Keep the maintenance version deployed. If cutover is abandoned: deploy the previous version, set `PIM_RUNTIME` and `PIM_REGISTRATION` back, unsuspend each suspended account (`/unsuspend`, `accounts.ts:992-1002`), and expect alarms to resume from stored rows; trigger firings missed during the window follow their catch-up rules (`packages/triggers`; B3).

Never `deleteEverything`, never a `deleted_classes` migration, never `wrangler delete` of the Worker before the snapshot is verified and old access is no longer needed: they destroy storage (§7, §8.2).

## 11. Checklist

Columns: *Stopped by suspension* covers an account that is suspended and an old Worker still running (step 4). *Stopped by maintenance Worker* means PROPOSED B plus step 5; "ingress" means the `PIM_RUNTIME` switch alone.

| Entrypoint | Exists? (cite) | Stopped by suspension? | Stopped by maintenance Worker? | Residual external effect | Verification |
|---|---|---|---|---|---|
| Person API + `/api/ws`, browser/screen/notes sockets (row 18) | yes, `gateway.ts:622-655` | yes, 403 (`gateway.ts:133,147`; `pim.ts:1946`); sockets closed 4003 | ingress: yes | none after ingress | step 5 probe returns 503 |
| API tokens `pim_…`, OAuth/MCP `/mcp` (rows 6, 18) | yes, `gateway.ts:129-140,170-185,563` | yes, `closed()` | ingress: yes | none | step 5 probes `/mcp`, `/oauth/token` |
| Registration, sign-in, passkeys (row 8) | yes, `gateway.ts:577` | sign-in refused for suspended (`auth/index.ts:322`) but **new accounts are not** | ingress: yes | none | `/auth/register` 503 |
| Webhooks / connector ingress `/mcp/events/…`, `/mcp/callback/*` (row 12) | yes, `gateway.ts:221-248,605-608`; `triggers.ts:402-419` | yes, `closed()` at 245, 297 and in the space | ingress: yes | provider keeps retrying deliveries until its own limit; providers' subscriptions stay registered | 503 on both paths; provider dashboards |
| Public artifacts / content origin (row 2) | yes, `gateway.ts:527-531`; `accounts.ts:89-98` | **no** (no account gate) | ingress: yes (503) | none (read only) | probe a `/p/…` link |
| Hosted app origin and `/hosted/*` (rows 3, 11) | yes, `gateway.ts:366-396,339-348` | yes, `closed()` | ingress: yes | app backend processes on the computer keep running (`pim-computer.ts:1115-1121`) | 503; person stops app |
| Computer WebSocket (row 13) | yes, `gateway.ts:483-494`; `pim.ts:1947-1953` | yes, closed + refused | ingress: yes | `pim-computer` runs local observers ≤ 120 s, apps indefinitely | 503 on connect; computer logs |
| Computer host sync (row 14) | yes, `gateway.ts:497-504` | **no** | ingress: yes | request already taken still runs on host | 503; host logs |
| Git broker (row 15) | yes, `gateway.ts:617` | **no** | ingress: yes | tokens valid ≤ 12 h but unusable without the Worker; a push in flight may finish at the git host | 503 on `/api/coding/git/…` |
| Model gateway (row 16) | yes, `gateway.ts:619` | **no** (key read checks only erasure, `space/coding.ts:69-72`); nonce revoked only by thread abort | ingress: yes | in-flight provider stream may finish and bill | 503 |
| HostOps agent poll and admin API (row 17, 18) | yes, `gateway.ts:621-626` | agent poll **no**; admin API yes | ingress: yes | op already on the host completes | 503 |
| `Pim` alarm: `PiHarness` wake, scheduled callbacks, trigger tick, push, approval/review expiry, watchdog, cooldown retry, keep-alive | yes, `pim.ts:1964-1967` | **no** (only `closed()`); some callbacks stop at `submitTo`/trigger state | shell (B): yes, alarm consumed; old-side flag (A): yes | push/subscription ticks/MCP restore before the fence; in-flight model request | step 7 tail + RPC probe; `cf_agents_jobs` unchanged (step 9) |
| `Pim.onStart` resume work, MCP restore on wake | yes, `pim.ts:1162-1197`; `client-1tEQ1Oqz.js:1304-1311` | **no** | B: yes (no wake reaches old code); A: yes | connector reconnect before the fence | tail shows no `pim.do_start` |
| `CodingThread` `advance` job (`onStart`, `onJob`) | yes, `thread-do.ts:781,785,2276` | **no** | B: yes; A: yes | remote Amp turn, detached execs, containers (below) | tail; `updated_at` stable |
| `CodingScheduler` alarm (admit slots, notices) | yes, `scheduler-do.ts:500-509,564-574` | **no** | B: yes; A: yes | none new after the fence | alarm consumed: no `pim.coding.*` logs |
| Directory alarm (cleanups/erasure, lapsed registrations) | yes, `directory.ts:653-674` | **no** | B: yes (prevents erasure); A: yes | none | step 2 zero queued; step 9 counts equal |
| HostOps alarm (sweep) | yes, `hostops.ts:402-404` | **no** | B: yes | none (DB only) | unchanged `ops` rows |
| Auth, Gallery, WorkspaceCatalog, WorkspaceContainer alarms | **no alarm code** | n/a | n/a | container inactivity timer (30 min) | `ctx.container.running` false |
| Cloudflare containers (CLI harness inside) | yes, `cloudflare-container.ts:248-289` | **no** | B stops egress (`ContainerEgress` deny); destroy needs shell RPC (step 8) | running container ≤ 30 min | catalog enumeration; dashboard |
| `ContainerEgress` entrypoint | yes, `cloudflare-container.ts:301-307` | **no** | B: denies all | none | probe from a container (PROPOSED) |
| Compose sandboxes, agentd detached execs | yes, `workspace-agentd/README.md:18,31`; `compose.ts:344-393` | **no** | **no** (outside Cloudflare) | CLI turns ≤ 10 min, box ≤ 30 min | manager session list |
| Remote Amp sessions (agent-hosted) | yes, `thread-do.ts:2711-2850` | **no** | **no** | agent keeps running in Amp's cloud | Amp thread list; recorded `lastEventAt` |
| Vault / login workspaces | yes, `scheduler-do.ts:434-455` | **no** | B: yes (no alarm) | login workspace until timeout [U] | catalog |
| Host daemons: `pim-host`, `hostopsd`, `displayd` | yes (`computer-host.ts`, `hostops.ts`, `displayd/`) | **no** | ingress cuts polling | work already taken | stop the services |
| Email (`EMAIL` binding) | commented out, `wrangler.jsonc:97` [U prod] | blocked indirectly (needs a run) | yes | none | dashboard shows no `send_email` binding |
| Model provider call in flight | yes, in `Pim`/`CodingThread` | aborted once at suspension | isolate reset drops it | provider may bill | n/a |
| Erasure fence `pim_erased` | yes, `store.ts:150`; `reports.ts:431-461` | n/a | n/a | **destroys data** | never run |

## 12. Open questions (not resolved here)

1. Whether `PiSession.abort` durably ends every task kind (running, parked, held for retry), so that §2's "approval denied" and "held run not resumed" mitigations hold. Searched `agents/dist/harness/pi/index.js:634-640`, `conversations.ts`; pi-durable's `abort` implementation was not read.
2. Whether `--durable-objects-code-update-mode immediate` takes effect for this account (§8.1).
3. What a pending alarm does when its class export or binding is removed (§8.3): no documentation found; the procedure avoids it.
4. Whether Cloudflare container execs are detached like Compose ones, and whether outbound-only CLI activity renews the 30 min inactivity timer.
5. Whether production has the `EMAIL` binding, `workers.dev`, extra routes, `PIM_CODING_MANAGER_URL`.
6. Whether the Scheduler/Directory/HostOps alarms are recomputed on the first request after a rollback from a shell version (their `#schedule` functions run on mutation).
7. Vault package timers (`packages/coding/src/vault`) were not searched.

## 13. Corrections to the earlier inventory fragments

- `cf_agents_schedules` is not a live table in agents 0.27.0: schedule rows are `cf_agents_jobs` rows (`scheduler-DZ3xQfeK.js:361-403`). B2 §"Scheduled callbacks" and B3 "Space alarm" name the old table.
- `audit` assumption "suspension is pushed to `Pim` and closes sockets" is right, but it stops **neither** the `PiHarness` wake job, nor `agents` jobs, nor the coding subsystem (§2, §4). The audit's UNVERIFIED item is now answered: it does not.
- The audit's "alarms due during the window are exported as data and do not fire in the old one" holds only if the alarms are neutralised (§10 step 6): today they fire.
