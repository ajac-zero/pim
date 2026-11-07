# Triggers

> **Not active.** This is a review-only foundation. Nothing in Pim imports `src/triggers/`: no tool, route, prompt, UI, computer call or schedule uses it, and no space's database has its tables. Schedules (`schedule_task`) and connector watches (`watch_connector_event`) work exactly as before. Turning triggers on, and moving schedules and watches to them, are later changes.

A trigger is work an agent does when something happens: at a time, on a connector's event, or when something it watches on the person's computer changes. Triggers are meant to replace schedules and watches with one thing people see and manage. Each space's Durable Object stays the authority for its triggers; the person's computer runs the observations (polls, streams, processes, files), and Pim keeps the record and decides what is an occurrence.

The code is in three modules, with tests in `test/triggers.test.ts`:

| Module | What it is |
| --- | --- |
| [`src/triggers/spec.ts`](../src/triggers/spec.ts) | The spec: the typed, versioned definition, read from untrusted JSON with its defaults written in |
| [`src/triggers/condition.ts`](../src/triggers/condition.ts) | Conditions: a restricted expression, its bounded state, and a pure evaluator |
| [`src/triggers/store.ts`](../src/triggers/store.ts) | `TriggerStore`: the tables and the transactions that change them |

## What a trigger is

A trigger has an opaque `id`, and a **spec** that is kept as immutable numbered **revisions**:

- `version`: the spec's shape, `1`.
- `owningAgentId` and `originChatId`: the agent whose work it is and the chat it was made in. Neither changes for the trigger's life.
- `label` (up to 120 characters) and `instruction` (up to 10,000).
- `source`: what it watches (below).
- `condition`: optional for events, required for states, refused for time.
- `destination`: `{ "type": "existing_chat", "chatId" }` or `{ "type": "new_chat" }` (a new chat with the owning agent each time). Continuing one trigger conversation is the intended default: integration makes that chat once and names it here.
- `delivery`: `rawSamples` and `maxPendingEvents` (below).
- `authorizationRef`: the approval or grant that lets the source run, such as an approval's id, or null.

Beside the spec, and not part of any revision:

- **Lifecycle**, what the person wants: `draft`, `enabled`, `paused`, `ended`, or `deleted` (a tombstone).
- **Health**, how the source is doing: `unknown`, `healthy`, `waiting_computer`, `reconnecting`, `gap`, `auth_required`, `budget_blocked` or `configuration_error`. Health never changes the lifecycle.
- **Generation**, which run of the source's observers is current.
- Each **occurrence**'s own state, and its delivery's (below).

**The space is never a field.** A trigger belongs to the space whose Durable Object stores it. Nothing in a spec, an event or an observation names an owner, so nothing an event carries can move a trigger to another space.

Reading a spec refuses unknown fields, unknown source kinds and operators, forms this version doesn't support, non-finite numbers, and anything past its bounds. The error, `TriggerValidationError`, names the field. The defaults are written into the stored spec, so changing a default later never changes an existing trigger.

## Sources

| Kind | Fields | Mode |
| --- | --- | --- |
| `time`, `schedule: "once"` | `at` (ms), `maxLatenessMs` (default 1 h) | none |
| `time`, `schedule: "cron"` | `expression` (5 fields), `timeZone` (IANA or `UTC`), `catchUpMs` (default 1 h) | none |
| `time`, `schedule: "interval"` | `everyMs` (at least 1 min), `anchorAt` (ms), `catchUpMs` (default 1 h) | none |
| `connector_event` | `connectorId`, `event`, `arguments` (JSON, up to 4 KB) | filter |
| `poll` | `command`, `cwd`, `intervalMs` (1 min to 1 day, default 5 min), `deadlineMs` (1 to 30 s, default 30 s) | edge |
| `stream` | `command`, `cwd`: each line it prints is an event | filter |
| `process` | `name` (not a path), `intervalMs` (as a poll's): observes `{ running, count }` | edge |
| `file` | `path` (absolute), `events` (`created`, `modified`, `deleted`), `recursive` | filter |

**Computer sources are not sandboxed.** `poll`, `stream`, `process` and `file` run on the person's computer as the user who runs pim-computer, with that user's access, not inside `/workspace`. A trigger with one of them can be enabled only with an `authorizationRef`. When its source changes, the old reference no longer counts: the update must carry a new one, or none, and with none the trigger can't be enabled.

**Cron** takes `*`, numbers, ranges `a-b`, steps `/n` and lists. Names (`MON`), `?`, `L`, `W`, `#`, a seconds field and macros such as `@daily` are refused, as is an expression that names no day that exists, such as `0 0 31 2 *`. Time zones are IANA names or `UTC`; offsets such as `+01:00` are refused, because they ignore daylight saving time.

## Defaults for when triggers are turned on

These are decided now, so integration doesn't have to guess. The store enforces the lateness rules; computing due times is the scheduler's job, which isn't built yet.

- **One-time** triggers run up to `maxLatenessMs` (1 h) late; later than that, the firing is recorded as `missed` and nothing runs. Either way the trigger ends.
- **Recurring** triggers run their latest due firing if it is at most `catchUpMs` (1 h) late, and record older ones as missed. The store refuses a firing that is no later than one it already took.
- **New local cron**, in the person's time zone: a time that doesn't exist on a daylight-saving day (it falls in the skipped hour) is skipped, and a time that happens twice (in the repeated hour) runs once, at its first instant. The scheduler applies this.
- **Migrated schedules** keep their cron in `UTC`, unchanged.
- **Polls** run every 5 minutes by default, at most once a minute, and each poll has 30 seconds.
- A state goes **stale** after two intervals unless the condition sets `staleAfterMs`.
- **Delivery**: one run at a time per trigger. A state, or a time trigger, holds one pending snapshot. Events queue, up to 20 by default (`maxPendingEvents`, up to 100).
- **Raw samples** are off: an occurrence of a state keeps only the fields its condition read, and when.
- **Moving schedules and watches** to triggers is deferred. Their data and behavior stay as they are.

## Conditions

A condition is `{ "when": <expression>, "staleAfterMs": <ms> }`. An expression is JSON, never code: there is no eval, script, SQL, network or model in a condition.

| Operator | Form | True when |
| --- | --- | --- |
| `compare` | `{ "op": "compare", "path": ["price"], "cmp": "lt", "value": 500 }` | The field compares so. `lt`, `lte`, `gt` and `gte` take numbers; text and true/false take only `eq` and `ne` |
| `exists` | `{ "op": "exists", "path": ["price"] }` | The field is there and not null |
| `all`, `any` | `{ "op": "all", "of": [ ... ] }` (1 to 16) | Every one / at least one is true |
| `not` | `{ "op": "not", "of": ... }` | It is false |
| `changed` | `{ "op": "changed", "path": ["status"] }` | The field's value differs from the last one seen |
| `stable_for` | `{ "op": "stable_for", "ms": 600000, "of": ... }` | It has been seen true, without a break, for at least `ms` |
| `hysteresis` | `{ "op": "hysteresis", "path": ["price"], "direction": "falling", "enter": 500, "exit": 520 }` | Once the value reaches `enter`, until it passes `exit` |

A `path` lists the keys of nested objects; arrays are not indexed, and lookups never reach an object's inherited properties. Bounds: 8 levels, 64 operators, 16 stateful operators, paths of 8 keys of up to 64 characters, text values of up to 256 characters, durations from 1 second to 7 days.

### Unknown is not false

Every expression is `true`, `false` or `unknown`.

- A missing or null field makes `compare` **unknown**, never false. That includes `ne`: a missing status is not "not ok".
- A value of another type is **unknown**: `"400"` is not the number 400, and nothing is converted.
- `not unknown` is unknown. **Only `exists` tells missing from present.**
- `all` is false if any operand is false, otherwise unknown if any is unknown. `any` is true if any operand is true, otherwise unknown if any is unknown.
- Every operand is evaluated, with no short-circuiting, so each stateful operator sees every observation.

### Edge conditions (polls and processes)

A state becomes an occurrence when the condition goes from false to true:

- **The baseline is silent.** The first known result fires nothing, even when it is true. A price already below $500 when the trigger starts is not news. Unknown results before it set no baseline.
- A false result **arms** the condition. A true result while armed **fires** and disarms.
- **Unknown never rearms**, and never disarms. True, unknown, true is one stretch of truth. False, unknown, true fires.
- A true `changed`, outside any `not`, fires even when the condition is disarmed, because each change seen between two observations is its own occurrence.
- `stable_for` counts from the first observation seen true, so it can't say the condition was true longer than seen. False or unknown starts the count again.
- `hysteresis` starts unknown inside its band and keeps its latch while the value is in the band or isn't a number. A rising band needs `exit` below `enter`; a falling band needs it above.

**Freshness and gaps are explicit.** An observation older than `staleAfterMs` when it is taken in is not evidence: its result is unknown, nothing it says is remembered, and it counts as a gap. A **gap** comes from an observation flagged `gap`, from `recordGap` (such as while the computer was away), or from a stale observation. It resets what the stateful operators remember, so `stable_for` continuity, the value `changed` compares with, and a hysteresis latch all start again. The armed state stays.

### Filter conditions (events)

Each event the condition is true for is an occurrence; unknown or false ones are not. Stateful operators and `staleAfterMs` are refused, because an event is never a baseline and never stale. Without a condition, every event is an occurrence.

## The store

`new TriggerStore(sql, { transaction, now, newId?, retention? })` makes its own tables, prefixed `pim_trigger`, in the database it is given. `transaction` is the Durable Object's `transactionSync`, and `now` is the clock. Only the tests construct one; `PimStore` and the `Pim` constructor are unchanged.

| Table | Holds |
| --- | --- |
| `pim_triggers` | Current revision, lifecycle, health, generation |
| `pim_trigger_revisions` | Each revision's spec. A SQLite trigger refuses any update |
| `pim_trigger_sources` | The source's revision, checkpoint (`position`, `cursor`), last observation time, pending gap, condition state |
| `pim_trigger_inbox` | Each event taken in, unique by (source identity, event id), with what came of it but not its data |
| `pim_trigger_occurrences` | Occurrences, unique by (trigger, occurrence key). A SQLite trigger keeps each one's revision and evidence fixed |
| `pim_trigger_outbox` | One delivery per occurrence (unique), with a stable unique `operationId` |
| `pim_trigger_tombstones` | Deleted triggers' ids |

Every method that writes does all its writes in one transaction. A refusal writes nothing, so the source may send the same thing again.

- **Revisions** (`create`, `update`). `update` takes `expectedRevision` and is refused on a mismatch (compare-and-swap). The same spec again changes nothing. A new source starts a new generation and a new source identity, and clears the checkpoint and condition state. A new condition alone clears only the condition state. An ended trigger can't be edited.
- **Lifecycle** (`setLifecycle`, `remove`). Draft or paused to enabled; enabled to paused; anything but ended to ended. Every change starts a new generation. **Enabling must name the revision it means**; pausing, ending and deleting are always safe and may leave it out. A paused trigger keeps its undelivered occurrences until it is enabled again. An ended one still delivers what it already took in. `remove` deletes everything the trigger recorded and leaves a tombstone, so its id is never reused, and anything sent for it later is refused.
- **Admission** (`admit`, `admitTimeFiring`). An observer passes the generation it was started for. Both methods first check, in order, that the trigger isn't deleted (`deleted`), exists (`not_found`), is at that generation (`stale_generation`), is enabled (`not_enabled`), and has the right kind of source (`wrong_source`). An event id already taken in is a `duplicate`. Then, in one transaction, the store writes the inbox entry, advances the checkpoint, updates the condition state, and writes the occurrence with its outbox item when the condition fires.
  - The **source identity** is the trigger's id and the revision its source was set in (`<id>#<revision>`). An event id is taken once per identity, and a new source may reuse old ids.
  - The **checkpoint** moves only to a higher `position`.
  - A state **no newer** than the last observation is refused (`out_of_order`). Events are taken in any order.
  - **Events are bounded, not merged.** Past `maxPendingEvents` undelivered occurrences, an event is refused (`backpressure`) and its source retries; no event is dropped or coalesced silently. A new snapshot of a state, or a time firing, supersedes an older undelivered one, which is marked `superseded`. A delivery already under way is left to finish.
  - Occurrence keys are `event:<eventId>` and `time:<scheduledFor>`. A one-time firing must be at `at`, and an interval firing on its grid, or it is refused (`schedule_mismatch`). A firing before its time is `not_due`.
- **Delivery** (`claim`, `complete`, `fail`). `claim` leases the next delivery: the oldest undelivered item of an enabled or ended trigger, when no older item of that trigger is waiting. So each trigger has **one run at a time, in order**. Each claim is a new attempt with the **same operation id**, and an expired lease is claimed again. `complete` and `fail` take the attempt and do nothing if a later claim, or a deletion, superseded it. `fail` retries from `retryAt`, up to 5 attempts.
- **Revision snapshots.** An occurrence records the revision it happened under, and `claim` returns the spec of that revision, so an edit after the event doesn't change what the run is told.
- **Retention.** Each trigger keeps its newest 1,000 inbox entries and 200 finished occurrences. An event id older than that could be taken again.

**No exactly-once outside.** The store's guarantees are about this database. A deliverer that passes `operationId` to `submitTo` (which takes an operation id) makes a retried delivery one run. Anything outside Pim (a connector, a command on the computer) may still see a request twice.

Inputs are bounded: event ids up to 256 characters, cursors up to 1 KB, payloads up to 16 KB and 8 levels as JSON, observation times no more than 5 minutes ahead of the clock, leases up to 1 hour, errors up to 1,000 characters.

## Turning it on later

What is left, roughly in order. Each step is its own change:

1. **Construct the store in `Pim`.** Pass `ctx.storage.sql`, `transactionSync` and `Date.now`. Add the tables in `TRIGGER_TABLES` to `PimStore.remainingData` and to erasing a space.
2. **A deliverer.** On the Durable Object's alarm, `claim` deliveries. Hand each one to `submitTo(chat, message, { operationId: item.operationId }, "pim")`, starting a chat for `new_chat` destinations as `runScheduledTask` does, then `complete` or `fail`. A `429` from the run limit maps to `budget_blocked` health. Use the spec returned with the claim, not the current one.
3. **A scheduler for time sources.** Compute due instants (cron in its time zone, with the DST rule above), call `admitTimeFiring`, and set the next alarm.
4. **Connector events.** Route webhook deliveries, verified as `app-events.ts` verifies them, to `admit` with the event's id. Subscriptions stay with the connector code.
5. **Computer observers.** Messages over pim-computer's connection, carrying the generation they were started for. Health comes from the connection (`waiting_computer`, `reconnecting`), and `recordGap` from reconnects.
6. **Tools, routes and UI**, with approvals filling `authorizationRef` for computer sources.
7. **Moving schedules and watches**, behind a migration that keeps their behavior.

Not done here: the scheduler and cron evaluation, checking that a cron firing falls on its expression, any observer, delivery, tool, route or UI, the migration, and quotas across a space's triggers.
