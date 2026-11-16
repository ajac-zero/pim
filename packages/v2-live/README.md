# @pim/v2-live

Live event delivery for Pim v2: rebuildable PostgreSQL projections of committed runtime truth, a replayable live event log, and a stateless `Live` WebSocket service that bridges NATS `Pulse` hints to gap-free cursor replay. The web app's side of the same design is in `web/src/lib/` (`live-client.ts`, `saved-queries.ts`, `transcript-window.ts`).

The package imports only `@pim/shared` (besides npm packages). It reads one table it does not own, `pim_runtime.runtime_outbox`, and the identity tables through the `Authorizer`; its own schema is `pim_projection`, migrations `0300–0399` (`migrations/`, applied by `migrate()`).

## Why the app shows "Connecting…" and feels slow when five or more threads run

Read from the code at `30818438` (`main`). These are mechanisms visible in the code, not a measurement; no load test was run against the real Worker, so the relative weight of each is unknown.

**On the server (`src/space/sockets.ts`, `src/pim.ts`):**

1. **One Durable Object serves everything for a person.** Chat sockets, notes (Yjs), the computer's connection, the desktop and browser streams, file watches, every REST route (`/api/*`) and every running agent's model loop share one `Pim` object's single-threaded event loop and one SQLite storage. A socket's `onConnect` (`sockets.ts:onConnect` → `watch`) has to wait its turn behind whatever that loop is doing. "Connecting…" is the client waiting for that turn.
2. **Streaming is a storage transaction.** pi-durable commits each partial of a streaming message and each tool output chunk (`partialIntervalMs: 250`, `src/pim.ts:717`), about four transactions a second per streaming conversation, each handled on that same loop. Five running threads are about twenty commits a second, plus tool and result commits, before any request is served.
3. **A new socket's first frame is a whole snapshot.** `watch()` (`sockets.ts:468`) opens a pi event stream (`harness.session(id).events()`) and sends `stream.snapshot`, the chat's entire state, before any event. Every reconnect (a dropped socket, a switch of chat, `WATCH_LOST` 4010) repeats it for the open chat, while the loop is at its busiest.
4. **The page can't show a chat before that snapshot.** `chat.$sessionId.tsx:429` draws the thread only when `ready && (loaded || pending.length > 0)`, and `loaded` comes only from the socket's snapshot (`pim-client.ts`, `#receive` case `events`). A reconnect sets `synced: false` (`pim-client.ts:302`), so a chat not remembered from before is blank, with "Connecting…", until the busy loop answers. There is no HTTP read of a chat's transcript to fall back on.
5. **Run changes fan out to full-list reads.** Each run starting or ending (and each held-run change) calls `onActivity`, which invalidates `sessions`, `agents`, `files`, `browser`, `skills` and three trigger queries (`web/src/routes/__root.tsx:258`). `GET /sessions` (`src/space/routes.ts:263`) then calls `harness.sessions.list()` (a scan of every conversation), `heldSessions()` (an `inspect()` of live tasks) and per-session lookups, for the whole list, on the same loop. Five threads starting and finishing means this happens many times over, and each is also a broadcast: `broadcastMessage({type:"sessions"})` goes to every open tab (`sockets.ts:625`).

**In the web app:**

6. **Whole-transcript rendering.** `Thread` mapped every row of the chat on each render (`thread.tsx`, `rows.map`); a streaming token re-rendered a transcript of any length, for each tab following a running thread.
7. **A device cache shared by accounts.** The persisted query cache used one key for everyone, so lists could outlive a sign-out race or be shown to the next account.

## What v2 does about each

| Mechanism | v2 |
|---|---|
| 1, 2: one loop for everything, a transaction per token | `Live` is a separate, stateless process. It owns no Harness and needs no sticky routing; any replica serves any reconnect from a cursor. Streaming partials are replaceable events, not state the service must hold. |
| 3, 4: snapshot on the loop; blank until the socket answers | Every page loads from a **bounded, paginated HTTP snapshot** (`projections/snapshots.ts`, served at `/snapshot/...`), read from projections, never from the runtime. The snapshot carries `liveCursor`, read in the same repeatable-read transaction, so a subscription from it neither repeats nor misses an event. `LiveClient` loads the snapshot first and the socket second. A reconnecting `Live` is a small "syncing" status; reads and navigation never wait on it. |
| 5: fan-out of full lists | The sidebar is one compact stream (`sidebar`). Each event is a single chat's summary with `replaceable_key = chat:<id>`, so a slow reader gets the latest per chat, not every change. Pages are cursor-paginated. |
| Every running agent's tokens | A connection follows only streams the person is looking at: the open chat or coding thread plus the sidebar. The server caps this (`maxStreams`, default 8); the client's `follow()` takes the visible set and drops the rest. |
| 6: whole-transcript renders | `transcript-window.ts` draws the newest 60 rows and steps upward 60 at a time (scrolling to the top row or its button); a jump to a row that isn't drawn (task cards, `[Task update]` links) draws all rows first. Scroll-to-bottom pinning is unchanged. |
| 7: shared cache | `saved-queries.ts` keeps lists per account (`pim-queries:<username>`), shows a different account none of them, and wipes everything when access ends. |

## Projections (`src/projections/`)

`Projector` consumes `runtime_outbox` rows (one commit of one partition: `{events: [...]}`, shapes in `src/contracts.ts`) and writes `chat_transcript_projection`, `sidebar_session_projection`, `coding_thread_projection`, `live_event_log`, `projection_watermarks`, plus `live_stream_heads` (the per-stream seq allocator) and `projection_applied` (the idempotency key).

- **Idempotent.** A commit is applied in one transaction guarded by `(partition_id, commit_seq, projection_version)`. Two projectors, or the same commit twice, change nothing the second time; the partition's watermark row is the lock.
- **Rebuildable.** `rebuild()` truncates every `pim_projection` view and the log and replays the outbox. The projector has no handle on tools, models or billing; it only reads the outbox. The test proves the views are identical after a rebuild and that the outbox and an effects ledger are untouched. Clients with cursors into the old log get `snapshot_required`.
- **Fidelity.** Messages are produced by `projectEntries` from `@pim/shared/transcript`, so user, assistant and tool parts, `pi.compaction` summaries (`compaction: true`) and reset notices are the same as today's. Rich blocks (`cards`, `gallery`, `videos`, `mermaid`, `ui`), inline images and videos (`/api/images/...`) and task lines stay in the message text and parts untouched; the client renders them as before. `ui` block state is `chat.ui_state` → `ui_state` on the message row and a `ui_state` event. Busy/stalled badges are `chat.meta`.
- **Lag.** `lag()` returns per partition `max(commit_seq) − projected_seq` and the age in ms of the oldest unprojected commit.
- **Stream seq.** Allocated per `(tenant, stream)` from `live_stream_heads` under its row lock, held until the projection transaction commits. Rows therefore become visible in seq order: a reader that sees seq N sees every seq below it.

The outbox shapes are an assumption of what `v2-runtime` and Forge commit (`origin/pim/v2-canonical` was not available); aligning with `@pim/v2-contracts` is a change to `contracts.ts`. `runtime_outbox` is expected as `(partition_id, commit_seq, tenant_id, payload jsonb {events}, created_at)` and the identity tables as in `authorizer.ts`.

## Live (`src/server/`)

`LiveHub` (`hub.ts`) is the core, independent of the socket library; `ws-server.ts` is the `ws` edge. Protocol: `subscribe {stream, cursor}` → `subscribed`, replayed and live `event` frames, `snapshot_required`, `unsubscribe`, `ping`.

**Authorization.** Each socket is authenticated by the `Authorizer` (`authorizer.ts`; `PgAuthorizer` checks the session and the account in PostgreSQL), and each subscription is checked again. Every log read is bound to the connection's tenant, whatever the stream key or NATS subject says; NATS subjects and hints are never trusted, and a hint for another stream is ignored. Access is revalidated every `revalidateMs` and on a revocation announced on Pulse (`publishRevocation`), so a suspended account or revoked session closes with **4003** and nothing more is sent. With NATS down, the bound is `revalidateMs`.

**The bridge (per subscription, cursor C).** Subscribe to Pulse and buffer its hints; read the stream's head H and replay `(C, H]` from `live_event_log`; drain the buffer: a hint at or below the last delivered seq is a duplicate and is dropped, the next seq is delivered from the hint itself, and anything else (a gap, a hint without its event) is repaired by reading the rows from PostgreSQL. A heartbeat per connection (`heartbeatMs`, one query for all its streams) compares heads with what was delivered, so with Pulse 100% down or lossy, a client is at most one heartbeat behind. A cursor that is ahead of the head, behind retention, beyond `maxReplay`, or across a pruned hole gets `snapshot_required` with a reason.

**Slow clients.** Each socket has a bounded queue (`outbound-queue.ts`) and writes only while the socket's own buffer is under `highWaterBytes`. Replaceable events with the same `replaceable_key` replace the queued one (the replacement goes to the tail, so seqs only increase, and the next frame is marked `coalesced` so the client can tell a skip from loss). Canonical events are never dropped to make room; if the queue still exceeds `maxQueueBytes`, it empties and the client gets `snapshot_required: slow_client`, then fetches the HTTP page and subscribes again. A socket that moves nothing for `stallCloseMs` is closed (4009).

## Web (`web/src/lib/`)

- `live-client.ts`: cursor per stream; HTTP snapshot first; applies only the next seq or a `coalesced` skip, drops duplicates, resubscribes from its cursor on a hole, re-fetches on `snapshot_required`; reconnects with backoff, reporting `syncing` rather than blocking; on 4003, or a snapshot refused with 401/403/410, stops and calls `onUnauthorized`.
- `saved-queries.ts`: per-account cache; wiped on sign-out, session expiry and `410`. (`403` is not a wipe in the REST client, since it also means an ordinary refusal; the Live client does wipe on it.)
- `transcript-window.ts`: described above.

The v1 chat view still reads pi events over the existing `/api/ws`; wiring `LiveClient` into the chat and sidebar views, and mapping a snapshot's `TranscriptMessage`s onto `SessionView`, is the step that moves a page from v1 to this service, and was not done here because the v2 backend it reads from does not exist yet.

## Tests

`pnpm --filter @pim/v2-live test` starts a private PostgreSQL (`initdb`; found on `PATH` or in `/usr/lib/postgresql/*/bin`) and, for the WebSocket tests, `nats-server` (on `PATH` or `$NATS_SERVER`); each skips when its binary is missing. They cover: zero gaps and duplicates with commits racing subscribes under 30% hint loss and duplication; total NATS outage (in-process fault injection and a killed `nats-server`); a 500-chunk flood to a reader that stopped (real WebSocket, coalescing within the byte cap, canonical final intact) and an overflow that becomes `snapshot_required`; projection rebuild idempotency with no effect repeated; revocation mid-stream by periodic check and by bus; tenant isolation. The web app's tests cover the client, the cache and the window.
