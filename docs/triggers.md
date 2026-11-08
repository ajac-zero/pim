# Triggers

> **Not active.** This is a review-only foundation. Pim builds the engine for time triggers (the store, the coordinator and its real host, and a wake) only in a space opted in where the deployment allows it, and no deployment does: the gate is a variable no deployment sets, and only tests opt a space in (below). In a space opted in, and only there, the API (below) gives the person routes and agents tools for triggers; no prompt, UI, setting or computer call reaches it otherwise, and no space's database has its tables unless it was opted in. The ingress adapter for connector events (below) is constructed by nothing: no route, subscription or callback reaches it. The coordinator hands connector events on only when it is made with `connectorEvents`, which nothing in Pim does: Pim's engine leaves them pending. It hands computer sources' occurrences on only behind computer triggers' own gate, which nothing sets either. Schedules (`schedule_task`), connector watches (`watch_connector_event`) and Pim's own alarms work exactly as before. Moving schedules and watches to triggers goes as far as draft shadows owned by the schedule or watch, behind a gate of its own that nothing sets ("Moving schedules and watches", below). Turning triggers on for people, and handing a schedule or watch over to its trigger, are later changes.

A trigger is work an agent does when something happens: at a time, on a connector's event, or when something it watches on the person's computer changes. Triggers are meant to replace schedules and watches with one thing people see and manage. Each space's Durable Object stays the authority for its triggers; the person's computer runs the observations (polls, streams, process exits, files), and Pim keeps the record and decides what is an occurrence.

The code is in these modules, with tests in `test/triggers.test.ts`, `test/triggers-time.test.ts`, `test/triggers-coordinator.test.ts`, `test/triggers-connector.test.ts`, `test/triggers-event-dispatch.test.ts`, for Pim's engine and host `test/triggers-host.test.ts`, for moving schedules and watches `test/triggers-migration.test.ts`, and for the API `test/triggers-api.test.ts`:

| Module | What it is |
| --- | --- |
| [`src/triggers/spec.ts`](../src/triggers/spec.ts) | The spec: the typed, versioned definition, read from untrusted JSON with its defaults written in |
| [`src/triggers/condition.ts`](../src/triggers/condition.ts) | Conditions: a restricted expression, its bounded state, and a pure evaluator |
| [`src/triggers/store.ts`](../src/triggers/store.ts) | `TriggerStore`: the tables and the transactions that change them |
| [`src/triggers/time.ts`](../src/triggers/time.ts) | When a time source fires: one pure computation for checking, previewing and selecting the due firing |
| [`src/triggers/coordinator.ts`](../src/triggers/coordinator.ts) | `TriggerCoordinator`: admits due time firings and hands each to its agent through an injected host, one agent run per trigger at a time; made with `connectorEvents`, connector events too, and with `computerEvents`, computer sources' occurrences |
| [`src/triggers/host.ts`](../src/triggers/host.ts) | `PimTriggerHost`: the host in Pim, which makes chats and submits through `submitTo`, keyed by operation |
| [`src/triggers/engine.ts`](../src/triggers/engine.ts) | `TriggerEngine`: the three built together for one space, and the gate |
| [`src/triggers/connector.ts`](../src/triggers/connector.ts) | `ConnectorIngress`: takes a signed connector event delivery into `admit`, unwired; and the typed contract for keeping a subscription alive |
| [`src/triggers/migration.ts`](../src/triggers/migration.ts) | Moving schedules and watches: a pure mapping, a preview, and draft shadows owned by the schedule or watch, behind its own gate |
| [`src/triggers/api.ts`](../src/triggers/api.ts), [`src/triggers/tools.ts`](../src/triggers/tools.ts) | The API: the routes' and agents' tools' contract, behind the engine's gate |

## What a trigger is

A trigger has an opaque `id`, and a **spec** that is kept as immutable numbered **revisions**:

- `version`: the spec's shape, `1`.
- `owningAgentId` and `originChatId`: the agent whose work it is and the chat it was made in. Neither changes for the trigger's life.
- `label` (up to 120 characters) and `instruction` (up to 10,000).
- `source`: what it watches (below).
- `condition`: optional for events, required for states, refused for time.
- `destination`: `{ "type": "existing_chat", "chatId" }` or `{ "type": "new_chat" }` (a new chat with the owning agent each time). Continuing one trigger conversation is the intended default: integration makes that chat once and names it here.
- `delivery`: `maxPendingEvents` (below), and `rawSamples`, which must be false: keeping what a source observed isn't supported yet.
- `authorizationRef`: the grant that lets a computer source run, such as an approval's id, or null. The store never takes it on trust (below).

Beside the spec, and not part of any revision:

- **Lifecycle**, what the person wants: `draft`, `enabled`, `paused`, `ended`, or `deleted` (stopped for good, with its record kept).
- **Health**, how the source is doing: `unknown`, `healthy`, `waiting_computer`, `reconnecting`, `gap`, `auth_required`, `budget_blocked` or `configuration_error`. Health never changes the lifecycle.
- **Generation**, which run of the source's observers is current. It goes up with every lifecycle change and every change of source or condition.
- Each **occurrence**'s own state, and its delivery's (below).

**The space is never a field.** A trigger belongs to the space whose Durable Object stores it. Nothing in a spec, an event or an observation names an owner, so nothing an event carries can move a trigger to another space.

Reading a spec refuses unknown fields, unknown source kinds and operators, forms this version doesn't support, non-finite numbers, and anything past its bounds. The error, `TriggerValidationError`, names the field. The defaults are written into the stored spec, so changing a default later never changes an existing trigger. A spec as read, or as stored, reads back as the same spec, for every source. So a stored spec given back to `update` changes nothing, and an edit of it is one new revision.

## Sources

| Kind | Fields | Mode |
| --- | --- | --- |
| `time`, `schedule: "once"` | `at` (ms), `maxLatenessMs` (default 1 h) | none |
| `time`, `schedule: "cron"` | `expression` (5 fields), `timeZone` (IANA or `UTC`), `catchUpMs` (default 1 h) | none |
| `time`, `schedule: "interval"` | `everyMs` (at least 1 min), `anchorAt` (ms), `catchUpMs` (default 1 h) | none |
| `connector_event` | `connectorId`, `event`, `arguments` (JSON, up to 4 KB) | filter |
| `poll` | `command`, `cwd`, `intervalMs` (1 min to 1 day, default 5 min), `deadlineMs` (1 to 30 s, default 30 s) | edge |
| `stream` | `command`, `cwd`: each line it prints is an event | filter |
| `process` | `handle`, `expiresAt` (ms, at most 7 days ahead): the exit of one process instance, `{ exitCode, signal }` | filter |
| `file` | `path` (absolute), `events` (`created`, `modified`, `deleted`), `recursive` | filter |

**Computer sources are not sandboxed.** `poll`, `stream`, `process` and `file` run on the person's computer as the user who runs pim-computer, with that user's access, not inside `/workspace`. **A reference is not a grant.** The store asks the host's `authorize` check, which it is given, whether `authorizationRef` names a real grant, still current, for exactly this source. With no check configured it denies every computer source, and a non-null reference alone never enables one. The check runs when such a trigger is created enabled, enabled again, or changed while enabled. When its source changes in any way, including its interval, the old reference no longer counts: the update must carry a new one, or none, and with none the trigger can't be enabled. A connector's events and time sources don't run on the computer and aren't checked.

**A process is one instance.** A `process` source names the `handle` pim-computer gave a process it started, and fires on that process's exit. It takes one event, then the trigger ends. It is watched until `expiresAt` at the latest, which must be in the future and no more than 7 days ahead when the source is set; after that, its exit is refused (`expired`). Matching processes by name is not supported, because a name can't tell one run from the next. The other computer sources have no expiry in this version: they run until paused, ended or deleted, and the spec refuses an `expiresAt` for them.

**Cron** takes `*`, numbers, ranges `a-b`, steps `/n` and lists. Day of week 0 and 7 are both Sunday. Names (`MON`), `?`, `L`, `W`, `#`, a seconds field and macros such as `@daily` are refused, as is an expression that names no day that exists, such as `0 0 31 2 *` or `0 0 31 2 */2`. The day fields work as in Vixie cron: a day field is restricted unless it starts with `*` (alone or with a step). When both are restricted, a day matches either one, so `0 9 13 * 5` is every Friday and every 13th; otherwise a day must match both, so `0 9 */2 * 5` is the Fridays that fall on odd days. Time zones are IANA names or `UTC`; offsets such as `+01:00` are refused, because they ignore daylight saving time.

## Defaults for when triggers are turned on

These are decided now, so integration doesn't have to guess. The store enforces the lateness rules and, with `admitDueTime`, works out which time firing is due; the coordinator (below) looks at time triggers when they are due.

- **One-time** triggers run up to `maxLatenessMs` (1 h) late; later than that, the firing is recorded as `missed` and nothing runs. Either way the trigger ends.
- **Recurring** triggers run their latest due firing if it is at most `catchUpMs` (1 h) late, and record older ones as missed. The store refuses a firing that is no later than one it already took.
- **New local cron**, in the person's time zone: a time that doesn't exist on a daylight-saving day (it falls in the skipped hour) is skipped, and a time that happens twice (in the repeated hour) runs once, at its first instant. `src/triggers/time.ts` computes this (below).
- **Migrated schedules** keep their cron in `UTC`, unchanged.
- **Polls** run every 5 minutes by default, at most once a minute, and each poll has 30 seconds.
- A state goes **stale** after two intervals unless the condition sets `staleAfterMs`.
- **Handing on**: one attempt at a time per trigger, and, for time triggers, one agent run at a time (the coordinator). A state, or a time trigger, holds one pending snapshot. Events queue, up to 20 by default (`maxPendingEvents`, up to 100).
- **Raw samples** are off, and turning them on is refused until it is built. An occurrence keeps why it fired, its truth, when, and which fields the condition read were present, never their values or an event's body.
- **Replay**: event ids are remembered for 7 days, the shortest the store accepts.
- **Moving schedules and watches** to triggers goes as far as draft shadows that never fire (below). Their data and behavior stay as they are.

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

### Edge conditions (polls)

A state becomes an occurrence when the condition is true right after a known false, with nothing unknown between them. The condition's state says where it stands:

| Edge state | Means | A true result |
| --- | --- | --- |
| `unknown` | No known result since it started, or since continuity last broke | Is silent, and the state becomes `waiting_for_false` |
| `armed` | The last result was a known false, with no break since | Fires |
| `waiting_for_false` | The last result was true, with no break since | Is silent, unless a `changed` fired it (below) |

A false result always sets `armed`, and a true result always sets `waiting_for_false`.

- **Initial false arms. Initial true waits silently for a known false.** A price already below $500 when the trigger starts is not news.
- **A break in continuity starts the condition over.** A break is an `unknown` result, a gap, or a stale observation. The edge goes back to `unknown`, so false, unknown, true is silent, and so is true, unknown, true. After a break, the condition must be seen false before a true fires.
- **Durations restart after a break.** Every stateful operator forgets what it remembered: `stable_for` counts again, `changed` takes its next value as a new baseline, and `hysteresis` starts its band again. The same happens when the operator's own input is unknown (a missing value for `changed` or `hysteresis`, an unknown operand for `stable_for`), even where the whole condition is still known.
- **Changes are their own occurrences.** A true `changed`, outside any `not`, also fires from `waiting_for_false`, so back-to-back changes each fire. It never fires from `unknown`.
- `stable_for` counts from the first observation seen true, so it can't say the condition was true longer than seen. False also starts the count again.
- `hysteresis` is unknown inside its band until the value has entered or left it. A rising band needs `exit` below `enter`; a falling band needs it above.

| Results | Fires |
| --- | --- |
| true, true | Nothing |
| false, true | The true |
| true, unknown, true | Nothing |
| false, unknown, true | Nothing |
| unknown, false, true | The true |
| false, gap: true, true | Nothing |
| false, gap: false, true | The last true |

**Freshness and gaps are explicit.** An observation older than `staleAfterMs` when it is taken in is not evidence. It isn't evaluated, its result is unknown, and it breaks continuity. A **gap** is a break too. It comes from an observation flagged `gap`, from `recordGap` (such as while the computer was away), or from a stale observation.

**Pausing and editing are breaks.** Every new generation starts the condition over, as a gap does: pausing and enabling again, ending, and changing the source or the condition. So a trigger enabled again fires only on a true after a known false it sees from then on, and `stable_for` counts again from then.

**`changed` keeps a digest, not the value.** What it remembers is a SHA-256 digest of the last value's type and value, so the stored state holds nothing observed. A value with few possibilities, such as a status of "up" or "down", can still be guessed from its digest by trying each.

**Only observations change the condition's state.** A run the person starts by hand isn't built yet. When it is, it must make an occurrence without evaluating the condition or touching its state: it neither arms the condition, nor disarms it, nor restarts a duration.

### Filter conditions (events and process exits)

Each event the condition is true for is an occurrence; unknown or false ones are not. Stateful operators and `staleAfterMs` are refused, because an event is never a baseline and never stale. Without a condition, every event is an occurrence.

## Time

[`src/triggers/time.ts`](../src/triggers/time.ts) works out when a time source fires. It is pure: it is given the clock's reading and the trigger's watermark, and reads nothing but the runtime's time zone data. The same computation serves checking a schedule when it is saved, showing its next firings, and choosing which firing is due, so what a person is shown is what runs.

| Function | What it gives |
| --- | --- |
| `previewFirings(source, { now, count?, timeZone? })` | The next `count` firings after `now` (3 by default, at most 10), each with its instant, local date and time, zone and UTC offset; the local times skipped before the last of them, listed up to 5 and all counted; and whether it ran out |
| `selectDueFiring(source, { now, after })` | The firing to admit now, `due` or `missed`, with its deadline and a summary of older ones; or `none`. Both give the next firing after `now` |
| `isScheduledFiring(source, at)` | Whether an instant is one of the source's firings |
| `resolveLocalTime(local, timeZone)` | A local date and time for a one-time trigger: `unique`, `ambiguous` (both instants) or `nonexistent` (with a suggestion) |
| `describeInstant(at, timeZone)` | An instant as read in a zone |

**Each local time fires at most once.** A cron expression is read in its own time zone, fixed when it is saved; migrated schedules will keep `UTC`. A local time it names that clocks skip that day is skipped, never moved to another time: a preview lists it as skipped, apart from the firings, and no firing is made for it. A local time that happens twice fires at its first instant only. The second instant is never a firing, so a preview, or a restart, that begins between the two shows the next day's.

**Selecting a due firing.** `after` is the instant after which firings count: the trigger's watermark (`lastObservedAt`, the last firing it admitted), or before its first firing, the instant before its current enabled generation began (`activeSince`, below). Of the firings after `after` and at or before `now`, only the latest is selected, so an outage of days runs once. It is `due` when `now` is at most its deadline, which is its time plus the source's `catchUpMs` (or a one-time trigger's `maxLatenessMs`), inclusive, and `missed` after that. The deadline depends only on the firing, so retrying the delivery never moves it. The older firings are not listed: `older` gives how many there were and the first and last. A firing at or before `after` is never selected again, so a restart never replays one, and a clock that reads earlier than `after` selects nothing.

**Bounds.** Instants given in (`now`, `at`) are whole milliseconds from 2000-01-01 to 2100-01-01, both included, as a spec's are; `after`, which is exclusive, may also be one millisecond before 2000, so a firing at the very first instant counts. A preview or a `next` may still name a later instant (from 2097, the next 29th of February is in 2104); nothing past 2100-01-01 is ever scheduled or admitted. A schedule whose next firing is past it is refused when saved, and one that reaches it while enabled stops there (`admitDueTime`'s `limit`, below). A cron search walks local calendar days, skipping months the expression leaves out, and resolves only the times of days that match, so its cost is bounded by days, never minutes. It looks at most 4,400 days (just over 12 years) forward or back. That finds every expression whose days may match either field, the 29th of February included (8 years apart around 2100, which is not a leap year), and a date on one day of the week (at most 11 years apart). A rarer expression, such as `0 0 29 2 */7` (the 29th of February on a Sunday, 28 years apart), has no firing within it: its preview is empty and `exhausted`. **A schedule whose preview has no firings is refused when it is saved** (the store does). After an outage longer than the horizon, `older` counts only the firings within it and says so (`complete: false`). Counting them doesn't go through every firing: a day on one offset is counted whole. An interval's firings, and a one-time trigger's, are worked out, not searched for.

**Time zones** come from the runtime's `Intl` data, read as the Temporal polyfill reads them: the offset at an instant is what `Intl` shows there, and a local time is resolved by trying the offsets a day before and after it. That relies on a zone changing its offset at most once in any three days, which holds for every zone from 2000 to 2115 (the closest two changes, in America/Boa_Vista in 2000, are almost seven days apart). Offsets that aren't whole hours (Asia/Kathmandu's +05:45) and a half-hour change of daylight saving time (Australia/Lord_Howe) work as any other. The zone data is the runtime's, so a zone whose rules change takes effect when the runtime's data does.

**A local time for a one-time trigger** is the caller's to choose. `resolveLocalTime` applies no cron rule: an ambiguous time returns both instants, and a nonexistent one returns a suggestion (the time moved later by the length of the skip, as clocks read it: 02:30 suggests 03:30). A tool that sets a reminder must ask which, rather than take the first instant or skip the reminder. The spec's `at` stays an instant.

## The store

`new TriggerStore(sql, { transaction, now, authorize?, newId?, retention?, ownedElsewhere? })` makes its own tables, prefixed `pim_trigger`, in the database it is given. `transaction` is the Durable Object's `transactionSync`, `now` is the clock, `authorize` is the host's check of grants, and `ownedElsewhere` says whether a schedule or watch still delivers a trigger's work, so enabling it is refused (`owned_elsewhere`; see "Moving schedules and watches"). Pim constructs one only in a space opted in (below), with no `authorize` unless computer triggers' own gate is on (below), so no computer source can be enabled there.

| Table | Holds |
| --- | --- |
| `pim_triggers` | Current revision, lifecycle, health, generation. A deleted trigger keeps its row, as `deleted` |
| `pim_trigger_revisions` | Each revision's spec. A SQLite trigger refuses any update |
| `pim_trigger_sources` | The source's revision, checkpoint (`position`, `cursor`), last observation time, pending gap, condition state, when its enabled generation began (`active_since`), and a time source's next wake (`next_wake_at`) |
| `pim_trigger_inbox` | Each event id taken in within the replay horizon, unique by (source identity, event id), with what came of it but not its data |
| `pim_trigger_occurrences` | Occurrences, unique by (trigger, occurrence key), with their evidence. A SQLite trigger keeps each one's revision and evidence fixed |
| `pim_trigger_outbox` | One item per occurrence (unique), with a stable unique `operationId` |
| `pim_trigger_tombstones` | When each trigger was deleted |

Every method that writes does all its writes in one transaction. A refusal writes nothing, so the source may send the same thing again.

- **Revisions** (`create`, `update`). `update` takes `expectedRevision` and is refused on a mismatch (compare-and-swap). The same spec again changes nothing. A time source with no firing from now on, within the search horizon and before 2100, is refused when it is saved (`TriggerValidationError` on `spec.source`), such as a one-time trigger whose time has passed; a stored revision is never checked again, and nothing about today's schedules changes. A new source or a new condition starts a new generation, so an observation made under the old ones is refused (`stale_generation`) rather than judged by the new condition, and the condition starts over. A new source also gets a new source identity and no checkpoint. A new label, instruction, destination or delivery is only a new revision. An ended trigger can't be edited.
- **Lifecycle** (`setLifecycle`). Draft or paused to enabled; enabled to paused; anything but ended to ended. Every change starts a new generation, and a break (above). **Enabling must name the revision it means**, and checks a computer source's grant again; pausing and ending are always safe and may leave it out. Enabling a time trigger with no firing left is refused (`schedule_exhausted`). A paused trigger keeps its undelivered occurrences until it is enabled again. An ended one still hands on what it already took in.
- **The enable boundary** (`activeSince`). Each generation that starts enabled (created enabled, enabled again, or its source changed while enabled) records its instant, in the same transaction; pausing or ending clears it. A time source's firings count from it until one is admitted, then from the watermark. It is never set from a restart's clock, so a crash neither loses the firings since it was enabled nor replays the ones from before. Enabling again starts a fresh one, so the hours a trigger was paused are never replayed. A new label or instruction keeps it.
- **Deleting** (`remove`). The trigger stops for good: a new generation, nothing more is claimed, and its id and anything its observers send are refused. Occurrences no attempt had claimed are `cancelled`. **Deleting asks for a stop; it is not proof that anything was cancelled or undone.** An occurrence with an attempt under way may already have been handed on, and a run it started may go on, so it becomes `outcome_unknown`, not cancelled. That attempt can no longer `complete` or `fail` it; `reconcile` records it as delivered or failed once that is known, without claiming anything or bringing the trigger back. **What it did is kept:** its row (as `deleted`), its revisions, its occurrences with their evidence, and its outbox items with how each ended. Its source state and inbox, which only served taking in events, go. **`eraseAll`** is separate: it removes every trigger of the space and everything they recorded, tombstones included, for erasing the space.
- **Admission** (`admit`, `admitTimeFiring`). An observer passes the generation it was started for. Both methods first check, in order, that the trigger exists (`not_found`), isn't deleted (`deleted`), is at that generation (`stale_generation`), is enabled (`not_enabled`), and has the right kind of source (`wrong_source`). Then, in one transaction, the store writes the inbox entry, advances the checkpoint, updates the condition state, and writes the occurrence with its outbox item when the condition fires.
  - The **source identity** is the trigger's id and the revision its source was set in (`<id>#<revision>`). An event id is taken once per identity (`duplicate`), and a new source may reuse old ids. Occurrence keys carry the identity too: `event:<identity>:<eventId>`, and `time:<scheduledFor>`.
  - **Replay horizon.** Event ids, filtered ones included, are remembered for the horizon (7 days by default, and no less), plus 5 minutes for clocks ahead. An event or observation from before the horizon is refused (`too_old`), because whether it was taken in before can no longer be told. So `observedAt` must be the event's own time, the same on every delivery of it. Within the horizon a trigger remembers at most `inboxCap` ids (20,000 by default, room for a poll a minute twice over); past that, admissions are refused (`inbox_full`) until old ids expire, and no id within the horizon is forgotten to make room.
  - The **checkpoint** moves only to a higher `position`.
  - A state **no newer** than the last observation is refused (`out_of_order`). Events are taken in any order.
  - **Events are bounded, not merged.** Past `maxPendingEvents` undelivered occurrences, an event is refused (`backpressure`) and its source retries; no event is dropped or coalesced silently. A new snapshot of a state, or a time firing, supersedes an older undelivered one, which is marked `superseded`. An attempt already under way is left to finish.
  - A process's exit ends its trigger, and one after `expiresAt` is refused (`expired`).
  - A time firing must be one of the source's (`isScheduledFiring`: a one-time trigger's `at`, an interval's grid, or a cron expression's instant in its time zone), or it is refused (`schedule_mismatch`), so no arbitrary instant is admitted. One before `activeSince` is refused (`before_enabled`). A firing before its time is `not_due`.
  - **`admitDueTime`** looks at an enabled time trigger now, in one transaction: it selects the due firing with `selectDueFiring` from `max(watermark, activeSince − 1)`, admits it as due or missed (lateness measured at admission, inclusive), writes the summary of older firings into the occurrence's evidence (`older`: count, first, last, complete), and sets `next_wake_at` to the next firing. Called again before that, it admits nothing. A one-time trigger ends with its firing. When the next firing is past 2100 (`past_supported_range`), none is found within the horizon (`beyond_horizon`), or the clock itself reads outside 2000 to 2100 (`unsupported_clock`), no wake is set and the health becomes `configuration_error` with the reason; the lifecycle is the person's and stays as it is. `dueTimeTriggers({ now, limit })` lists the triggers whose wake has come, earliest first, and `nextTimeWake()` the earliest wake.
- **Handing on** (`claim`, `complete`, `fail`, `reconcile`). `claim` leases the next attempt: at the oldest unsettled item of an enabled or ended trigger, when no older item of that trigger is unsettled. With `triggerId`, it claims only that trigger's next item, which is how the coordinator claims only for triggers whose run slot is free. So each trigger has **one attempt at a time**, in order. That is not one run at a time: once a submission is accepted, the run it starts may still be going when the next occurrence is handed on, and keeping runs apart is the coordinator's job (below). Each claim is a new attempt with the **same operation id**.
  - `complete` means the submission was accepted, not that the agent's run finished or succeeded.
  - `fail` means the attempt is known not to have handed the occurrence on. It retries from `retryAt`, and fails for good after 5 attempts or with no `retryAt`.
  - `complete` and `fail` take the attempt, and do nothing once a later claim or a deletion has superseded it.
  - A lease that runs out says nothing of whether the submission happened, so the item is claimed again. After 5 attempts it isn't claimed again: its outcome is `outcome_unknown`, the next item goes on, and `reconcile` settles it as delivered or failed once the deliverer has found out, such as from the operation id's record.
- **Revision snapshots.** An occurrence records the revision it happened under, and `claim` returns the spec of that revision, so an edit after the event doesn't change what the run is told.
- **History.** Within the horizon every occurrence is kept. Of settled occurrences from before it, each trigger keeps its newest 200 (`retention.occurrences`). Unsettled ones, `outcome_unknown` included, are always kept.

**No exactly-once outside.** The store's guarantees are about this database. A deliverer that passes `operationId` to `submitTo` (which takes an operation id) makes a retried submission one run. Anything outside Pim (a connector, a command on the computer) may still see a request twice.

**Nothing observed is kept.** Inbox entries keep an event's id and what came of it, occurrences keep the evidence above, and condition state keeps digests, flags and times. The errors and health details a deliverer or observer records (`fail`, `setHealth`) are theirs to keep free of what was observed.

Inputs are bounded: event ids up to 256 characters, cursors up to 1 KB, payloads up to 16 KB and 8 levels as JSON, observation times no more than 5 minutes ahead of the clock, leases up to 1 hour, errors up to 1,000 characters.

## The coordinator

`new TriggerCoordinator(sql, { store, host, transaction, now, ... })` admits time firings and hands them to the owning agent, and, made with `connectorEvents: true`, connector events the store took in as well (see "Handing events on", below). It makes one table, `pim_trigger_runs` (`COORDINATOR_TABLES`), beside the store's in the same database, and reads the store's outbox and occurrences there to choose what to hand on. The coordinator's own tests construct one with a fake clock and a fake host; Pim constructs one with its real host (below) only in a space opted in.

`tick()` is one bounded pass, safe to run at any time, twice at once, or after a crash. It returns what it did and `nextWakeAt`, when the host's alarm should next fire (the coordinator registers none; Pim's engine keeps one wake, below).

1. **Admit.** Up to `batch.admissions` (16) time triggers whose wake has come, earliest first: `admitDueTime` for each.
2. **Tidy.** Occurrences the store lost track of (`outcome_unknown`, from leases run out or a deletion while claimed) with no run here are adopted as possibly submitted, so the host is asked about them. Runs that never submitted, whose occurrence was superseded, cancelled, failed or deleted, are closed. Ended runs whose occurrence the store's history let go are pruned with it.
3. **Reconcile.** Up to `batch.lookups` submissions whose outcome isn't known are looked up, then up to as many accepted runs are asked about, all in parallel. Each run asked about is marked first, in a transaction, with a token and the answer's deadline, so no other tick, and no coordinator made again, asks about it meanwhile, and only that answer may settle it.
4. **Hand on.** Up to `batch.handoffs` (4) triggers, one occurrence each, while the space has compute free (`maxRunning`, 4). The trigger handed on to longest ago goes first, so a busy trigger can't starve the rest. A trigger whose run slot is taken, whose handoff is already reserved, whose next occurrence isn't one it hands on (a time firing, or a connector's event when made with `connectorEvents`), or that is paused or deleted, is passed over. Each handoff is reserved before any waits on the host (below); then they go on in parallel.

Every query is bounded by its batch; nothing lists all triggers and fans out. **Every question to the host has a deadline**, `callTimeoutMs` (30 seconds, at most a quarter of `leaseMs`), measured by an injectable `sleep`; the call's `signal` is aborted when it passes. No answer in time is "not known", exactly as a throw is: never a success, and never a refusal. A later answer is dropped. So one silent host call holds up nothing else for longer than its deadline, and a tick takes at most about six deadlines (a lookup, a run check, then a handoff's preflight, chat lookup, chat and submission).

### A run

Each occurrence is one **operation**, keyed by its outbox item's `operationId`, the same for every attempt. Its run record keeps, fixed from its first claim (a SQLite trigger refuses changing them): the trigger, the occurrence, its spec **revision**, the owning **agent**, `scheduledFor`, `admittedAt` (when the firing was admitted) and `deliverBy` (`admittedAt` plus `deliveryTtlMs`, 24 hours). The **chat** is pinned before anything is submitted, and a pinned chat never changes. It also keeps when it was first and last dispatched, submitted, accepted and ended, the host's receipt, deferrals and the last error.

| Phase | Means | Holds the trigger's slot | Holds compute |
| --- | --- | --- | --- |
| `preparing`, reserved | Claimed by a handoff that holds a reservation until `dispatchUntil`; nothing submitted | Yes | Yes |
| `preparing` | Nothing submitted; deferred, or its handoff's reservation ran out | No | No |
| `submitting` | The host was asked to submit; whether it accepted isn't known | Yes | Yes |
| `accepted` | Accepted; how the run is doing isn't known yet | Yes | Yes |
| `queued`, `running` | What the host said of the run | Yes | Yes |
| `waiting_approval` | The run waits for the person's approval | Yes | **No** |
| `completed`, `failed`, `cancelled` | What the host said the run ended as | No | No |
| `not_submitted` | Known never handed on, and it won't be | No | No |

**Reservations are durable.** A handoff takes its compute slot, its trigger's slot and its occurrence in one transaction: `#begin` counts the runs holding compute, claims the occurrence for this outbox attempt and records `dispatchAttempt` and `dispatchUntil` (the lease). Nothing about which runs are under way lives only in an instance's memory, so concurrent ticks, and a coordinator made again after a restart, count the same reservations. A reservation is given up when the handoff defers, ends, or submits (when the `submitting` phase holds the slot instead), and runs out by itself after a crash.

**Each step with an effect outside is gated.** Before making a chat and before submitting, a transaction checks again that the run is still preparing under this attempt's claim (a later claim, a deletion or a tidy supersedes a stale continuation, which then does nothing), that its trigger isn't paused (its occurrence goes back to wait) or deleted, and that `deliverBy` hasn't passed (it is never submitted). Before submitting it also counts compute again, apart from itself: if its reservation ran out while it waited and another run took the slot, it doesn't submit, and tries again later. The gate records the step in the same transaction: `creating` before a chat is asked for, `submitting` before a submission. A step whose answer comes back after its trigger was paused or deleted records only what happened (the chat that was made) and goes no further.

**One agent run per trigger.** A trigger's next occurrence isn't handed on while any of its runs holds the slot. Its time firings meanwhile coalesce in the store: a newer one supersedes a pending one, so only the latest waits. A claimed, submitting or running one is never superseded. The slot is freed only when the host says the run ended, by `lookupRun` or by `runStatusChanged`; a submission's acceptance never stands for its run's end.

### The host

The host is injected (`TriggerAgentHost`). Each method is given a `signal`, aborted at its deadline, and may throw; a throw or no answer in time is "not known", never success or refusal. A call aborted at its deadline may still take effect, which is why chats and submissions are keyed by the operation and looked up.

| Method | Contract |
| --- | --- |
| `preflight({ triggerId, operationId, agentId, destination, sourceKind })` | `sourceKind` is `time` or `connector_event`. Before each new handoff: the agent exists, an existing chat is still that agent's, the space is active. A refusal that isn't `retryable` ends the operation. It never substitutes another agent or chat, and it grants nothing: the run's actions still go through approvals |
| `findChat({ operationId })` | The chat made for the operation: `found`, `absent` or `unknown` |
| `createChat({ operationId, agentId, title })` | Makes a chat keyed by the operation: `created` or `denied` |
| `lookupSubmission({ operationId })` | `accepted` with its receipt, `absent` (wasn't accepted; may still be submitted under the key), or `unknown` |
| `submit({ idempotencyKey, chatId, agentId, instruction, evidence })` | At most one acceptance per key, reserving the run budget only for a new one. `accepted`, `duplicate` (accepted before; its reservation given back), `budget_blocked` (nothing reserved), `suspended`, `failed` (definitively not accepted), or `uncertain` |
| `lookupRun({ operationId, receipt })` | `queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled` or `unknown` |

The instruction is the pinned revision's. The **evidence** is fixed when the occurrence is handed on. For a time firing it holds only the firing's times and the schedule: `{ kind: "time", triggerId, revision, label, scheduledFor, admittedAt, schedule, older }`; a time source observes nothing, so there is nothing else to leave out. For a connector's event it holds what the occurrence keeps, and never what the event carried: `{ kind: "connector_event", triggerId, revision, label, connectorId, event, eventId, observedAt, admittedAt, reason, fields }`, where `fields` are the paths the condition read and whether each was there. A trigger's instruction is not an approval of anything the run does.

### What happens when

| Situation | What the coordinator does |
| --- | --- |
| Two ticks at once, the alarm again, or a coordinator made again | Admission is one transaction that moves the watermark; a handoff is reserved in the database before it waits on the host, and a question out about a run is marked there. One occurrence, one submission, one question at a time, and never more than `maxRunning` runs holding compute |
| A handoff's reservation ran out while it waited, and another run took the compute | Its gate before submitting counts again and finds none free: nothing is submitted, and it tries again later |
| The host doesn't answer | After `callTimeoutMs` it is "not known": a preflight is tried again later; a chat may have been made, so it is looked up next time; a submission may have been accepted, so it holds the slot until `lookupSubmission` says. Other handoffs and lookups go on meanwhile |
| An answer about a run arrives after a callback, or after another answer settled it | Dropped: only the question whose token the run still holds may settle it, a callback withdraws that token, and an ended run never changes |
| Paused or deleted while its preflight was out | No chat is made and nothing is submitted. Paused, its occurrence waits for the trigger to be enabled; deleted, it is closed as never submitted |
| Deleted while its chat was being made | The chat is recorded as made, and nothing is submitted to it; if the answer never came, the run says a chat may have been made (`creating`) |
| Its preflight or chat ends past `deliverBy` | Never submitted. One that ends exactly at it still is. Already submitting or accepted past it, it is kept and followed, never cancelled |
| Crash before an admission commits | Nothing was written; the next tick admits the same firing, from the same boundary |
| Crash after it commits | The watermark moved; nothing is admitted again |
| The chat may have been made, but the answer was lost | It recorded `creating` before asking; on the retry it asks `findChat` and pins what it finds, and makes one only when the host says there is none. `unknown` defers it. Never a second chat |
| Crash, or a throw, after `submit` | The run was `submitting` before the host was called. It holds the slot, and nothing is submitted again until `lookupSubmission` answers: `accepted` records the receipt and delivers the occurrence; `absent` submits again under the same key; `unknown` asks again after `retryMs` |
| A lookup missed an acceptance | The resubmission is a `duplicate`: the host gives back its reservation, and the receipt is the first one's |
| `budget_blocked` or `suspended` | Known not submitted: deferred to `retryMs` (15 minutes) or the host's `retryAt`, with the same key and chat. `budget_blocked` health until a later acceptance. Out of attempts (5) or past `deliverBy`, it is `not_submitted`. The source's lateness never cancels it: a firing admitted in time is handed on even hours later |
| `failed`, or a preflight refusal that isn't retryable | `not_submitted`; a deleted agent or chat sets `configuration_error` health with the reason. Never another agent or chat |
| Paused before its submission | The occurrence goes back to pending, kept for when the trigger is enabled again, and is handed on then with its own revision |
| Paused, edited or deleted after its submission began | What happened is recorded as it happened, with the revision it was made under. A deleted trigger's occurrence is reconciled as delivered or failed, and its run is followed; nothing new is admitted or handed on for it, and its runs and occurrences stay as its history. Deleting asks for a stop; it cancels nothing already handed on |
| Leases run out, or deleted while claimed (`outcome_unknown`) | Adopted and looked up: delivered, failed, or still unknown and asked again later |
| A connector's event, without `connectorEvents` | Never claimed; it stays pending, and nothing wakes for it |
| A connector's event whose trigger was edited before it was submitted | Never handed on: `not_submitted`, its outbox item `failed` (see "Handing events on") |
| A poll's, stream's or process's occurrence, without `computerEvents` | Never claimed; it stays pending, and nothing wakes for it |
| One with `computerEvents` whose trigger was edited, or whose grant isn't current, before it was submitted | Never handed on: `not_submitted`, its outbox item `failed`; a grant no longer current also makes the trigger `auth_required` |
| A file's occurrence | Never claimed; it stays pending |
| A run waiting for approval | Holds its trigger's slot, but none of the space's compute |
| A callback for an older receipt, or a run that ended | Changes nothing |
| `lookupSubmission` or `lookupRun` keeps answering `unknown` | The run holds its trigger's slot, and is asked again every `retryMs` (a run, every `runCheckMs`), for as long as it takes: conservative by design, and never taken as an answer either way. After `UNKNOWN_ATTENTION` (3) such answers in a row, the trigger's health is `unknown` with a detail naming the operation it waits on; a known answer clears it (`healthy`). The run counts them (`unknownAnswers`) |
| The host's receipt is longer than `MAX_RECEIPT_LENGTH` (256) | It is never cut short: the submission stays `submitting`, holding the slot, with the error recorded, and is looked up again; nothing is taken as accepted under a receipt the coordinator can't keep whole |

## In Pim, behind a gate

`TriggerEngine` (`src/triggers/engine.ts`) is the store, the coordinator and `PimTriggerHost` built together on one space's database. `Pim.triggerEngine()` builds it, and with it its tables, only when both hold:

- **The deployment allows it**: `PIM_TRIGGERS_ENGINE` is `internal`. It is not in `wrangler.jsonc`, `wrangler.preview.jsonc` or the deployment settings, so no deployment, and not the preview, sets it; only the tests do (`vitest.config.ts`).
- **The space was opted in**, by `Pim.enableTriggerEngine()`, which records it in the space's meta. Only tests call it: no route, tool, setting or Worker code does. The API's routes and tools exist only once it has (see "The API").

Anywhere else `triggerEngine()` is null. Nothing is built, admitted or handed on, no table is made and no wake is kept, and the wake's callback, if one were left, does nothing but clear itself. In a space never opted in, nothing of triggers exists.

**Turning it off keeps everything.** `Pim.disableTriggerEngine()` (internal, as enabling is) takes the space's opt-in back and clears the wake; taking the gate off the deployment does the same for every space. Either way what triggers recorded stays, runs already going go on, and the export and `remainingData` still show it all. On again, the engine is built over the same tables, as it left them: nothing is made again or lost, and a firing that came while it was off is admitted as any late firing is (within `catchUpMs`, or recorded as missed).

**The wake.** Where the engine is on, the space keeps one schedule, like Pim's own (`runTriggerTick`, `TRIGGER_TICK_CALLBACK`), at the coordinator's `nextWakeAt`, at least a second on, and none when it has nothing waiting. `runTriggerTick` ticks once, then sets the wake again; changes to the wake go one after another, so ticks that run together leave one. Starting the Durable Object sets it again, in case a tick was cut short. The schedules people make, the watches' renewals and Pim's other alarms are untouched, and `schedule_task`'s list doesn't show it. Pim's engine lets at most **2** runs of a space's triggers hold compute at once (`ENGINE_MAX_RUNNING`), below the coordinator's ceiling of 4.

**What a space holds.** The engine's tables (`ENGINE_TABLES`) are in `PimStore.remainingData` while they hold rows, and in the export as `triggers`: every row of each of them that exists, as stored (`triggerHistory`), read without building the engine or making a table, whether triggers are on or not. The subscription manager's table, which nothing in Pim makes yet, is there too when it exists, without its callback keys and secrets. Erasing the space removes them with everything else.

**Computer sources, behind a second gate.** `src/triggers/computer.ts` is the space's side of `triggers.v1`, which pim-computer's triggers runtime speaks over the computer's connection: it checks the runtime against the stored token's digest, keeps its epoch and desired revision with the runtime durably, reconciles the enabled computer triggers that have a current grant with a lease it renews, takes observations in with `admit` and gaps with `recordGap`, acknowledging each only once its transaction has returned, and reads everything else the runtime says as health. Grants (`ComputerGrants`) are records made only from an approval the person themselves gave for exactly one source of one trigger on one computer, and checked again at every reconcile and admission, so a revoked grant stops admission at once. `Pim` builds it only when `PIM_TRIGGERS_COMPUTER` is `internal`, which nothing sets, in a space whose engine is on, and only then gives the engine's store an `authorize`. Behind the same gate, agents get `trigger_computer_grant`, which files the approval of exactly a trigger's current source for the person to decide and, once they approve it, records the grant and points the trigger at it; the computer is told again whenever a trigger or grant changes; the link with the runtime is kept in SQLite and its lease renewed from the space's wake, so an eviction loses nothing; and the coordinator hands each computer occurrence on as a `computer_event` (the source's kind and the event's id, never what was seen), checking that the trigger wasn't edited and its grant is still current before every step. Its tables (`COMPUTER_TABLES`) are in the export and `remainingData` when they exist. The details, and what is not wired (no route or screen to ask for, see or revoke a grant; no contract for a run reading what was observed), are in [triggers-runtime.md](triggers-runtime.md), "In Pim, behind its gate".

**Tables made before.** The coordinator adds a column it needs to a `pim_trigger_runs` made by an earlier version (`unknown_answers`, at 0), once, keeping every run as it was. Nothing else is migrated: schedules and watches stay as they are, and get at most a draft shadow ("Moving schedules and watches", below).

### The host

`PimTriggerHost` does what anything else that starts a run does, through `submitTo(chat, text, …, "pim")`: the run counts once against the run limit (a duplicate's reservation is given back), a suspended space refuses it, and every action of the run still goes through approvals as in any chat. A trigger's instruction is not an approval of anything.

It keeps one record per operation (`pim_trigger_host_operations`, `HOST_TABLES`), and writes what it is about to do there **before** doing it:

| Step | Recorded first | How a lookup knows |
| --- | --- | --- |
| A new chat (`createChat`) | The operation, then the chat's id as pi stages the commit that makes it | The chat is made in one pi commit with a document naming the operation (`TriggerChatDoc`). A recorded chat counts only once that document names the operation, so an id pi never wrote, or gave another chat after a crash, is forgotten, and the chat is made then. A chat pi wrote but whose making was cut short is tied to its agent and title when found |
| A submission (`submit`) | Its key, which `submitTo` tells the host (`stable.keep`) before it submits | pi's own record of the key in that chat (`submissionByRequest`): there, it was accepted; not there, it wasn't, and it may be submitted again under exactly that key |
| The receipt | When first known accepted | A digest of the chat and the key (`pim-trigger:` and 43 characters): the same for every answer about one submission, never cut short |

**One key per operation.** On `main`, `submitTo` from `pim` into a finished task's chat rewrites the operation id to `wake:<id>`, depending on the task's state when it is called, so a retry after the task reopened would go in under another key. `submitTo` takes `stable` for this: its `keep` is told the key the input goes in under, after that decision and before anything is submitted, and with `exact` a retry uses the recorded key as it is, never rewritten. A recorded `wake:` key wakes the task if it is finished again; a key recorded unwoken never wakes it. Every other caller of `submitTo` passes no `stable` and works as before.

**Lookups are authoritative or unknown.** While this instance is making the operation's chat or submitting it, questions about it are "not known", and a second submission is `uncertain`; a lookup that can't read pi's record is "not known". Absent means the key was never recorded or pi has no record of it.

| Method | In Pim |
| --- | --- |
| `preflight` | The space is erased: refused. Suspended: refused, to try again. The agent was deleted: refused. An existing chat must be one of the space's own chats, there and not deleted (not a group chat's seat, an old task's conversation or a visit), and with the trigger's agent as Pim says (`ofSession`): refused otherwise, never another chat or agent |
| `findChat`, `createChat` | Above. The person's limit on chats refuses a new one (`denied`) |
| `lookupSubmission`, `submit` | Above. The run limit is `budget_blocked`, with nothing reserved or recorded; a suspended space is `suspended`; a deleted chat or agent is `failed`; a failure after the key was recorded is `uncertain` |
| `lookupRun` | pi's record of the key: `queued`; `placed` is `running`, or `waiting_approval` while an approval filed in the chat since the key was recorded waits for its decision; `done` is `completed`; `unanswered` is `cancelled` when aborted, `failed` otherwise; no record, or another receipt, is `unknown` |

**What the run reads**: `[Trigger "<label>" <id>] <instruction>`, then when it was due (the cron's time zone, if it has one) and how many earlier firings were missed. Nothing else: a time source observes nothing. For a connector's event, after the instruction: `(On <event> from <connector> at <time>, event <eventId>. What the event carried isn't kept or passed on.)`.

**Stopping.** Pausing or deleting a trigger stops its next handoff, never a run already going: a run waiting for an approval keeps waiting for the person, and its approval is theirs to decide. Suspending the space aborts its runs, as it does every run, and defers handoffs until it is restored (or their `deliverBy`). A deleted chat or agent ends each later firing as `not_submitted` with `configuration_error`; nothing goes to the majordomo or another chat instead. Deleting a chat aborts its runs, as it always has.

**Cross-agent triggers**: a trigger is handed on only to its owning agent. Only the majordomo makes a trigger for another agent, as with schedules, and only one that starts new chats (see "The API").

## Connector events: the ingress adapter, unwired

`new ConnectorIngress({ store, host, now })` takes one webhook delivery for a trigger on a connector's event and admits it with `TriggerStore.admit`. It is an adapter, not another engine: it writes nothing but what `admit`, `recordGap` and `setHealth` write, it submits nothing, and nothing constructs it. Its tests (`test/triggers-connector.test.ts`) use a real store on a Durable Object's database and a fake host; no connector, route or network is involved.

**The contract it takes** is the webhook slice of the draft MCP Events extension, as `app-events.ts` receives it, held to the draft's own rules where `app-events.ts` is looser:

| Part | Taken | Refused |
| --- | --- | --- |
| Headers | `webhook-id` (1 to 256 characters, no spaces), `webhook-timestamp` (Unix seconds, within 5 minutes of the clock), `webhook-signature` (Standard Webhooks `v1,`, up to 8), `X-MCP-Subscription-Id` equal to the bound provider subscription, `Content-Type: application/json` (charset UTF-8 or none) | Any missing, past its bound, or another subscription's id |
| Body | Up to 64 KiB (a quarter of `app-events.ts`'s cap), read chunk by chunk within 10 seconds, strict UTF-8 with its bytes kept as signed, nesting at most 9 deep | Larger (`413`, reading stops and the stream is cancelled; a larger `Content-Length` isn't read), slower (`408`, retry), malformed UTF-8, deeper |
| Event | `{ eventId, name, timestamp, data, cursor?, _meta? }`: `eventId` equal to `webhook-id`; `name` the trigger's event; `timestamp` ISO 8601 with seconds and a zone, fractions past milliseconds cut off; `data` an object within the store's 16 KB and 8 levels; `cursor` a string up to 1 KB, or null or absent; `_meta` an object, read and not kept | Any other field, such as a trigger, owner or generation; a time with no zone, an impossible date or a leap second; data past the store's bounds (`413`) |
| Control | `verification` (`challenge` echoed), `gap` (`cursor`), `terminated` (`error.code`, with `message` and `data` read and not kept) | Any other `type` |

The signature and its freshness are checked with `app-events.ts`'s own `verifyWebhook`, after the bytes are decoded and before anything is read as JSON; a stale signing time is refused before the body is read.

**Who it is for comes from the route and the space, never the body.** The callback is `<owner>/<key>`. The owner must be the space's own; the key resolves, through the host, to a `ConnectorSubscription` binding one trigger at one source revision and generation to one connector, event, provider subscription id and secret. The trigger must exist, not be deleted, be at that generation, be enabled, and be on that connector's event at that source revision, and the connector must be connected. All of it is checked before the body is read, and again, with the binding compared field by field, after the last wait and right before the store's one transaction, so a trigger paused, deleted or edited, or a subscription revoked or rotated, while a body was arriving takes nothing in.

**An event's identity and time.** Its id is the provider's `eventId`, taken once per source identity (`<trigger>#<source revision>`), as `admit` takes any event. Its time is the event's own `timestamp`, the same on every delivery of it, so a retry, two deliveries at once, or one after a restart is a `duplicate` at the same `observedAt`. **There is no fallback time.** The draft makes `timestamp` required, and `webhook-timestamp` is when a delivery was signed, new on every retry, so it can't stand in; an event without a time of its own is refused. A source without event times would need a durable first-seen record per event id, which nothing keeps yet.

**The checkpoint moves only with an admission**, in the same transaction. The cursor kept is the one carried by the delivery most recently admitted, and the checkpoint's `position` counts this source's admissions; nothing compares opaque cursors or guesses the provider's order. The draft calls each delivered cursor a safe-to-persist watermark whatever order deliveries arrive in, so the one kept may replay events already taken in, which are duplicates. A refusal, `backpressure` included, a failed transaction, and a duplicate move nothing. An event its condition filters out is taken in and moves the checkpoint without an occurrence.

**Outcomes** are typed and honest: `accepted` (`admitted`, `filtered`, `duplicate`, `verified`, `gap_recorded`, `terminated_recorded`), `retry` (sending the same event later may work: `not_ready` while the provider's subscription id isn't known, `connector_disconnected`, `subscription_changed`, `body_timeout`, `too_early` for an event time more than 5 minutes ahead, `backpressure`, `inbox_full`, `admission_failed`), or `reject` (it won't). `ingressResponse` answers with the status and the reason's name, and nothing else: no body, data, secret or provider error text reaches a response, the store, the export or a log. The draft's providers stop retrying only on `410` and `413`, so a deleted, paused or stale trigger, a revoked subscription and an event too old for the replay horizon answer `410`; a rejected signature or subscription answers `401`, which a provider may retry harmlessly.

**Failures between admission and answer.** A failure after the transaction commits answers `retry`; the provider sends the event again and it is a `duplicate`, acknowledged. A failed transaction writes nothing and answers `retry`.

**Control envelopes.** A verification echoes its challenge. A gap is recorded (`recordGap`), but its fresh cursor isn't kept, because the store keeps a cursor only with an admission; the next subscribe would send the last admitted cursor and hear of the gap again. A termination sets the trigger's health (`auth_required` for the Forbidden codes, else `configuration_error`) with a fixed detail naming only the code; the lifecycle stays the person's. All three take the same checks as an event, so a paused trigger's are refused.

**The adapter hands nothing on.** An admitted event is a pending occurrence with its outbox item, and nothing more; the adapter never submits. A coordinator made without `connectorEvents`, as Pim's engine is, leaves it pending (the adapter's tests tick one whose host is never asked anything).

### Handing events on

A coordinator made with `connectorEvents: true` hands a connector's event to its trigger's agent exactly as it hands on a time firing: the same outbox item and `operationId`, the same run record, reservation, gates, deadlines, host calls and lookups. Nothing about the path is new; what differs is what it hands on, what the run is told, and when an event is no longer handed on. Nothing in Pim makes such a coordinator yet; the tests build one (`test/triggers-event-dispatch.test.ts`).

**What was specific to time, and what it is now.** Before this, the coordinator handed on only occurrences keyed `time:` (the candidates it chooses from, and the `outcome_unknown` items it adopts), rolled back any other claim, built only time evidence, and told the host's preflight `sourceKind: "time"`. Now:

| Part | Time firings | Connector events, with `connectorEvents` |
| --- | --- | --- |
| Chosen and adopted | Keyed `time:` | Keyed `event:`, of a revision whose source is `connector_event` (read from the revision's spec). Other sources' events are keyed alike and stay pending |
| Admitted by | The coordinator's tick (`admitDueTime`) | The ingress adapter (`admit`); the tick admits nothing for them |
| `scheduledFor` on the run | When the firing was due | The event's own time (`observedAt`) |
| `deliverBy` | `admittedAt` plus `deliveryTtlMs` (24 hours) | The same |
| An edit before submission | Handed on with the revision it happened under | **Never handed on** (below) |
| Evidence and text | Times and the schedule | Connector, event name, event id, its time, why it fired, which fields were there |
| `preflight`'s `sourceKind` | `time` | `connector_event` |

**Exactly once.** Each event is one occurrence (the store takes an event id once per source identity), one outbox item and one operation. A handoff claims it and reserves its slots in one transaction before it waits on the host; concurrent ticks and a coordinator made again count the same reservations; a chat and a submission are keyed by the operation and looked up before anything is made again. So duplicates of a delivery, ticks running together and restarts at any step submit it once: cut inside the claim's transaction, nothing was written; cut while the preflight was out, the next attempt waits for the lease and the late answer does nothing; cut while a chat was made, it is found, not made again; cut after a submission whose answer was lost, it is looked up and never submitted again. An item the store lost track of (`outcome_unknown`) is adopted and looked up, as a time firing's is, only by a coordinator that hands events on. A trigger's events go one run at a time, in the order they were taken in.

**Paused, deleted, edited.** A paused trigger's event waits, as a time firing does, and is handed on when the trigger is enabled again at the same revision. A deleted trigger's is never handed on. **A connector's event is handed on only while its trigger is at the revision it was taken in under**: an edit of any kind, which a change of source or condition (a new generation) always is, ends it before anything is submitted, as `not_submitted` with its outbox item `failed`, whether it was waiting or its preflight was out. Pausing and enabling again start a new generation without a new revision; they leave the event as the store keeps it, for when the trigger is enabled again, which is what the store promises a paused trigger. Once its submission has begun, an edit, pause or deletion changes nothing already done: what happened is recorded with the revision it was made under. Time firings keep their snapshot as before.

**Bounds.** Events share the coordinator's batches, deadlines and compute with time firings: at most `batch.handoffs` handoffs a tick and `maxRunning` runs holding compute, each host call within `callTimeoutMs`, and the same late fences (the gate before each step, and `deliverBy`). An event that can't be handed on (another source's, or any while `connectorEvents` is off) is not a candidate, so no tick spins on it.

**Nothing observed reaches the run.** The store never kept what the event carried, so nothing can pass it on: the run is told the event's connector, name, id and time, whether a condition held and which fields it read were there, never their values. Neither the coordinator nor the host logs anything of an event. The event id is what the agent may ask the connector about, through its tools, whose actions go through approvals like any run's. A trigger's instruction approves nothing: the run is Pim's own, submitted through `submitTo` as a time firing's is.

**Still unwired.** Nothing constructs a coordinator with `connectorEvents`, so no event reaches an agent anywhere; Pim's engine leaves them pending, and the ingress adapter and the subscription manager are unwired too. Left for later: turning it on in the engine once events can arrive (a real provider and a route), a preflight that checks the connector is still connected, and how a run gets an event's contents when the person wants that, which needs raw samples or a fetch through the connector, decided with consent.

**Computer sources' occurrences, with `computerEvents`.** Pim's engine makes its coordinator with `computerEvents` (and the grants' `authorize`) only behind computer triggers' gate. Then a poll's, stream's or process's occurrence goes the same path as a connector's event: chosen and adopted when keyed `event:` under a revision whose source is one of those, `preflight`'s `sourceKind` that kind, and an edit before submission ending it. One check is added: before every step, the grant the run's revision names must still be current; one revoked or no longer current ends the run `not_submitted` before it is submitted, and the trigger is `auth_required`. The run is told the source's kind, the event's id, when it was observed and taken in, and whether it was an event or a gap (`computer_event`); never what was observed, which the store didn't keep. Its tests are in `test/triggers-computer.node.test.ts`, with the real runtime feeding the store.

**Keeping the subscription** is the subscription manager's, below; it is unwired too.

**Compatibility with watches** (the migration's contract for them is in "Moving schedules and watches", below). `app-events.ts` and its callback `/mcp/events/<owner>/<watch>` are unchanged, as are each watch's secret, provider subscription id (`remoteId`), cursor and the operation id it submits under (`event:<watch>:<eventId>`). Moving a watch to a trigger must keep the provider's subscription, which the draft keys by its callback URL: so the watch's id as the binding's key under the same path, its secret and its `remoteId`. It must also keep events from running twice across the move: a trigger's occurrences are keyed `event:<trigger>#<revision>:<eventId>` and handed on as `trigger:<trigger>:<occurrence>`, which share nothing with a watch's operation ids, so the move needs either the watch's recent event ids seeded as taken in or the old operation ids honored. The adapter is stricter than the watch receiver, which a migration must check each connector against: it requires `X-MCP-Subscription-Id`, `webhook-id` equal to `eventId`, a `timestamp` and a JSON content type, refuses fields the draft doesn't define and control types it doesn't know (a watch acknowledges unknown types), and answers a gone watch's deliveries `410` as a watch does.

### Keeping the subscription

`new ConnectorSubscriptionManager(sql, { store, provider, transaction, now, owner, callbackUrl, ... })` (`src/triggers/subscriptions.ts`) makes the bindings the ingress adapter reads, subscribes each one with its connector, keeps it renewed while its trigger is enabled, and undoes it when it isn't. It is inert: nothing in Pim constructs it, so no table is made, nothing is subscribed and no MCP request is sent. The connector is reached only through the `SubscriptionProvider` it is given (`connector`, `subscribe`, `unsubscribe`); its tests (`test/triggers-subscriptions.test.ts`) give it a fake connector that keeps subscriptions by callback URL, as the draft does, and a real store on a Durable Object's database.

**A binding** is one row of `pim_trigger_subscriptions` (`SUBSCRIPTION_TABLES`): one trigger at one generation and source revision, its connector and event, a callback key and a Standard Webhooks secret made with the binding and never changed (a SQLite trigger refuses changing either, but for wiping the secret), the provider's subscription id once known, the grant (`grantedAt`, `refreshBefore`), at most one intent, and when to look at it next. `subscription(key)` reads it as the adapter's `ConnectorSubscription`, and `ingressHost()` is the whole `ConnectorIngressHost` the adapter takes, so a delivery's owner and binding come from the route and these rows. The callback URL is `callbackUrl({ owner, key })`, worked out for every request and never stored, so the same binding names the same URL each time.

**Desired state comes from the trigger.** Each `tick()`:

1. **Binds.** Up to `batch.plans` (16) enabled triggers on a connector's event with no binding for their generation get one, in a transaction; a binding is unique by trigger and generation, so two ticks or two managers make one.
2. **Revokes.** Up to `batch.revocations` (32) active bindings whose trigger was deleted, paused, ended, or moved to another generation or source revision are revoked at once, so the adapter refuses them (`revoked`, `410`), and made due to be undone.
3. **Steps.** Up to `batch.effects` (8) due bindings, earliest first. Each step decides with `renewalDecision`, in a transaction, and records what it decided before anything is sent; the requests then go out in parallel, each within `callTimeoutMs` (30 seconds, no more than the intent's deadline), and each answer is recorded in a transaction of its own.

A pause, an edit of the source or condition, or a deletion all start a new generation, so they all leave the binding stale; a new label or instruction keeps it. Enabling again binds anew, with a new key and secret. A binding is never moved to a new generation.

| Situation | What the manager does |
| --- | --- |
| Enabled, no grant | Subscribes: `events/subscribe` with the binding's URL and secret, the source's arguments, the source's checkpoint cursor, and a TTL of an hour, as `app-events.ts` asks |
| Granted | Renews 5 minutes before `refreshBefore`, with the same URL and secret; a grant with no expiry is subscribed again a day after it was granted. A `refreshBefore` that is absent or unreadable is the hour asked for; one already past is renewed 30 seconds after the grant, never in a loop |
| Paused, edited or deleted | Revoked at once; unsubscribed with the same URL. A grant that ran out with nothing sent since has lapsed, and ends without a request |
| Connector disconnected | Nothing is sent; looked at again every 5 minutes |
| Connector removed | Revoked and ended without a request, since it can't be asked; health `configuration_error` if the trigger is at that generation |
| A fatal code to a subscribe (`-32011`, `-32012`, `-32014`, as `app-events.ts`) | The binding fails for good: revoked, its secret wiped, and the trigger's health is `auth_required` (`-32012`) or `configuration_error`, with a fixed detail naming the code. No binding is made again for that generation; enabling the trigger again (a new generation) tries again. The lifecycle stays the person's |
| Any other code | Known not done: the intent is settled, and the step is tried again after a backoff of 30 seconds, doubling to an hour |
| An unsubscribe answered with a fatal code | Ended: there is nothing left that Pim could undo |
| An unsubscribe that fails or isn't answered six times | Ended as `unsubscribe_unconfirmed`. The binding is revoked, so the connector's deliveries answer `410`, which the draft's providers take as the end of it |

**Intent before every request, receipt after.** The step's transaction records the intent (its id, kind, `sending`, when it was sent, a token, and the cursor it sends) and makes the binding due at the intent's deadline, 30 seconds on. That is the binding's lease: no other tick, and no manager made again after a restart, sends anything for it until then. The answer is recorded only while the binding still holds that intent and token; an answer that comes after its deadline, or after another settled it, changes nothing.

**Unknown is reconciled, never subscribed anew.** No answer by the deadline, a throw, an answer that can't be read (such as a subscription id that is empty, over 256 characters or holds spaces), or a crash anywhere between the intent and the receipt leaves the intent `unknown` (or `sending` past its deadline, after a crash). The next step sends the same request again, with the same intent, URL, secret and cursor: the draft's subscribe and unsubscribe are idempotent over the callback URL, so this finds the subscription the first request may have made rather than making a second. Cut after the intent, after the connector made the subscription, or before the receipt committed, a binding has one subscription with its connector. If the trigger is no longer wanted by then, the unknown subscribe is undone with an unsubscribe.

**Nothing secret leaves the binding.** The secret is kept only in its binding's row, for the adapter to check signatures, and wiped when the binding ends or fails. Errors are kept as fixed words (`no_answer`, `unreadable_answer`, `lapsed`, `connector_removed`, `unsubscribe_unconfirmed`) or `refused <code>`, never a connector's text or a thrown error's message, which may hold the request. Health details name only the code. A tick's report names triggers, not keys. The export (`triggerHistory`) has the table, when it exists, without its `key` and `secret` columns. The manager logs nothing; a real provider must keep the URL and secret out of its own logs.

**Bounds and history.** Every query is bounded by its batch, so a tick sends at most `batch.effects` requests; `nextWakeAt` is now while bindings wait to be made or revoked, else the earliest due binding, or null. A trigger keeps its 20 newest ended bindings as history. The table is made by `CREATE TABLE IF NOT EXISTS` beside the engine's, which it leaves as they are; `PimStore.remainingData` lists it, and erasing the space removes it with everything else.

**Not done, and not tested.** Nothing constructs the manager, so there is no real provider over the MCP bridge, no route for the callback URL, no wake, and no engine that ticks it. The ingress adapter refuses a delivery while the binding has no provider subscription id (`not_ready`), so a connector that verifies the callback before it answers the first subscribe would be refused; whether any connector does needs checking against real ones. A termination the adapter records (health) is not read by the manager: the binding is subscribed again at its next renewal, and a fatal answer then ends it. The health a fatal code set isn't cleared by a later success, which only a new generation brings. A subscribe aborted at its deadline may still land after an unsubscribe that followed it; such a subscription lapses at its grant and its deliveries answer `410`. A watch's callback key and secret can be read as an adopted binding (`adoptedSubscription`, below), but the manager doesn't take one in yet, which handing a watch over needs. A removed connector is noticed only when its binding is next due.

## Moving schedules and watches

[`src/triggers/migration.ts`](../src/triggers/migration.ts) represents each schedule `schedule_task` made, and each connector watch, as a trigger, without changing how either is delivered. It goes as far as a **shadow**: a draft trigger with the same work, which the store refuses to enable while the schedule or watch still owns it. Its tests are in `test/triggers-migration.test.ts`, on a real space's SQLite database with the legacy paths as they are.

**Nothing changes for schedules and watches.** `runScheduledTask`, the agents SDK's alarms, `AppEvents` and the callback `/mcp/events/<owner>/<watch>` are unchanged, and none of them reads anything this module writes. A schedule fires, and a watch takes its events, exactly as before, whether a shadow exists or not.

### The mapping

`planMigration({ schedules, watches, records }, context)` is pure and deterministic: given the same items, records and context it gives the same plan, in the same order (schedules, then watches, each by id). The context is resolved beforehand: the clock, the space's owner and public origin, whether an agent exists, a chat's agent (read only), and whether a chat is one a trigger may deliver to, as the host's preflight checks it. Each item is `migratable`, with the spec of its trigger, or `unsupported`, with the reason; **nothing that can't be represented exactly is approximated**. A migratable item also lists its `differences`, what its trigger would do differently once it delivers, and its `cutoverBlockers`, what must be built before it may (below).

A schedule (`callback: runScheduledTask`):

| Schedule | Trigger |
| --- | --- |
| `type: "scheduled"` (`at`), `time` | `time`, `once`, `at` = `time` × 1000, `maxLatenessMs` 7 days |
| `type: "delayed"` (`delay_seconds`), `time`, `delayInSeconds` | The same: the instant the delay ends at, which the SDK fires it at; `delayInSeconds` isn't needed |
| `type: "cron"`, `cron` | `time`, `cron`, the same `expression`, `timeZone: "UTC"`, `catchUpMs` 7 days |
| `type: "interval"` | Unsupported (`interval_schedule`): `schedule_task` never makes one |
| `payload.instruction` | `instruction` |
| `payload.label` | `label`; with none, the instruction's first line, as a schedule's chats are titled, cut to 120 characters (`label_derived`) |
| `payload.session` | `originChatId`; and, without `newChat`, `destination: { existing_chat, chatId }` |
| `payload.newChat` | `destination: { new_chat }` |
| `payload.agent` (with `newChat`) | `owningAgentId`, while that agent exists; else the chat's agent, as `runScheduledTask` falls back. Without `agent`, the chat's agent |
| `id` | The trigger's id, `legacy:schedule:<id>:<attempt>` |

**Time zones.** The agents SDK reads a cron expression in the runtime's zone, which on Workers is UTC, so a moved cron stays in `UTC`, unchanged, never the person's zone. A one-time schedule is an instant and stays one. **Cron is checked against how the SDK read it** (cron-schedule), not only parsed: names (`MON`), macros (`@daily`) and a seconds field are `cron_syntax`; a step from a single value (`5/15`, which the SDK reads as `5` alone) and day fields the two combine differently (the SDK takes a day field as restricted unless it names every value, triggers unless it starts with `*`, so `0 9 */2 * 5` and `0 9 1-31 * 5` differ) are `cron_semantics`. The day fields are compared on every day of the month against every day of the week. A one-time schedule whose time has come is `one_time_due`: its alarm runs it. A spec the store would refuse (a label over 120 characters, an instruction over 10,000, control characters) is `invalid_field`, naming the field and never its value.

A watch:

| Watch | Trigger, or the binding it would adopt |
| --- | --- |
| `serverId`, `event`, `arguments` | `connector_event` source: `connectorId`, `event`, `arguments` (up to 4 KB and 6 levels, else `invalid_field`) |
| `instruction` | `instruction` |
| `session` | `originChatId`, `destination: { existing_chat }`, and its agent as `owningAgentId` |
| (no label) | `Connector event <event>` (`label_derived`) |
| `id` | The binding's callback `key`, so its URL stays `/mcp/events/<owner>/<watch>`; the trigger's id is `legacy:watch:<id>:<attempt>` |
| `url` | Must be the URL Pim would make for it now, else `callback_changed`: adopting it would subscribe a new URL |
| `secret` | Never copied: the binding reads it from the watch (`secret: "kept_in_watch"`) |
| `remoteId` | The binding's `providerSubscriptionId`, so no new provider subscription is made. Null, or `status: pending`: `watch_not_subscribed` |
| `cursor` | The source's checkpoint cursor at cutover; the plan says only whether there is one |
| `refreshBefore` | The binding's grant |
| `status: ended` | `watch_ended` |
| `lastError`, `lastEventAt`, `createdAt` | Not carried |
| The operation id of each event, `event:<watch>:<eventId>` | `legacyOperationId`, which a cutover must honor (`legacyEventOperationId`) |

`adoptedSubscription(watch, trigger)` is the **binding adoption contract** as code: the `ConnectorSubscription` the ingress adapter reads, built from the live watch when needed and never stored, with the watch's key, secret and provider subscription id. A test admits a delivery signed with a watch's own secret, to its own key and subscription id, through the real adapter into a trigger made from its plan, and takes it again as a duplicate. Nothing in Pim calls it.

Unsupported for either: a chat that is deleted or isn't one a trigger may deliver to, such as another agent's seat in a group chat (`chat_unavailable`), and a chat whose agent doesn't exist yet, in a space whose majordomo was never made (`agent_unavailable`).

**Differences, accepted and documented.** `run_text`: the run reads `[Trigger "<label>" <id>]` and when it was due, not `[Scheduled task …]` or `[Connector event] …`. `lateness_bound`: a firing more than 7 days late is recorded as missed, where an alarm runs however late. `refused_runs_retry`: a run the limit or a suspension refuses is tried again until `deliverBy`, where a schedule's firing is skipped and the person told once a day. `agent_fixed`: the agent is fixed when migrated, where a schedule resolves it at each firing. `label_derived`, above.

**Cutover blockers**, which keep an item with its schedule or watch until they are built: `firing_notification` (every schedule's firing notifies open apps; a trigger's handoff doesn't yet); `event_contents` (a watch's run reads what the event carried; a trigger's is told only its name, id and time); `stricter_ingress` (each connector must be checked against the adapter's stricter rules, under "Compatibility with watches" above); `legacy_event_ids` (an event a watch took in before the cutover and sent again after it must be a duplicate, so the trigger must honor the watch's operation ids: the adoption test shows a trigger keys it `event:<trigger>#<revision>:<eventId>` instead); `binding_adoption` (nothing routes the watch's callback to the adapter, and the subscription manager takes in no adopted binding).

### The preview

`Pim.previewTriggerMigration()` reads the schedules (`listSchedules`, as `schedule_task` lists them), the watches and the records, checks the chats as the host's preflight does, and returns the plan, with each item's record and the records whose item is gone (`orphans`, such as a one-time schedule that has fired since; its shadow is kept until rolled back). It **writes nothing** and makes no table, whether triggers are on or not: no engine is built, no agent made (a chat's agent is read only), and the records are read without making their table. Nothing secret is in it: no webhook secret and no cursor. It is internal: nothing calls it.

### Apply, one owner, and rollback

`Pim.applyTriggerMigration()` runs only where the deployment sets **`PIM_TRIGGERS_MIGRATION`** to `internal`, which no deployment, the preview or `vitest.config.ts` does (its tests set it on one space's env for the call), and only in a space whose engine is on; elsewhere it returns null and makes nothing. It plans again, then for each migratable item, in **one transaction**: writes its record (`pim_trigger_migrations`, `MIGRATION_TABLES`), owned by `legacy`, phase `shadow`, then makes its trigger as a `draft` at revision 1 with the planned id. So a crash or a throw at any step, after the record, after the trigger, or at the commit, leaves nothing of that item, and applying again makes it; a crash between items keeps those done. An item already shadowed is `already`, so applying again changes nothing, and two applies at once make one shadow, since the record and the trigger's id are unique. An unsupported item is reported and nothing is written for it; one already shadowed stays as it was. The store refusing a trigger (an id another took) writes nothing for that item and is reported `refused`.

**One owner per item.** A record's `owner` says which system delivers its item: `legacy` (the schedule or watch) or `trigger`. Applying writes `legacy`, and **nothing writes `trigger`**: there is no cutover. A shadow can't fire while its record says `legacy`:

- It is a draft: it is never due (`admitDueTime`), its events are refused (`not_enabled`), and nothing claims it.
- Enabling it is refused. The store takes `ownedElsewhere` (`TriggerStore` option), which Pim's engine gives it as `ownedByLegacy`, read in the transaction that would enable a trigger (`setLifecycle` to `enabled`, or `create` enabled): `owned_elsewhere`.

So a due schedule fires once, through its alarm (a retried firing is one submission, as before), and its shadow admits nothing however the clock moves, across the engine being built again (a restart) and a second apply; a watch's event is run once through its callback, retried deliveries included, and the same delivery offered to the shadow through its adopted binding is refused before its body is read. The tests check each of these.

`Pim.rollbackTriggerMigration()` gives every shadowed item back to its schedule or watch for good, one transaction each: its trigger is deleted (kept as any deleted trigger is, with its tombstone, so its id is never reused), and its record says `legacy`, `rolled_back`. The schedule and the watch are exactly as they were. It is idempotent (`already`), and works wherever the engine is on and something was applied, even with the migration's gate off, so it can always be undone. Applying again after a rollback makes a new shadow, `attempt` 2, under a new id.

**What is kept, and what isn't.** A record holds the item's kind and id, its attempt, its trigger's id, the owner, the phase and two times: no secret, cursor, callback URL or instruction (the instruction is in the trigger's revision, as any trigger's). The watch's id is in it, as it is in the export's `watches`. The table is in the export (`triggerHistory`, all of it) and in `remainingData` ("schedules and watches moved to triggers") when it exists; erasing the space removes it with everything else.

**Not wired, and not done.** Nothing calls the preview, apply or rollback: no route, tool, setting or UI. No deployment sets the gate. There is no cutover: nothing writes `owner: trigger`, stops a schedule's alarm or a watch's callback, or enables a shadow, and the legacy paths don't read the records, so a cutover must make them defer to the owner before anything writes `trigger`. Each blocker above is unbuilt. A shadow is made once and not kept in step: a schedule cancelled or fired since leaves an orphan for rollback, and the preview lists it. A rollback after a real cutover would also have to give the item back to its schedule or watch, which no rollback here needs to do.

## The API

[`src/triggers/api.ts`](../src/triggers/api.ts) is the contract a later screen and the agents use: the same `TriggerApi` behind the space's HTTP routes and agents' tools ([`src/triggers/tools.ts`](../src/triggers/tools.ts)). Its tests are in `test/triggers-api.test.ts`, on a real space's SQLite through the Worker.

**Behind the engine's gate.** It exists only where `Pim.triggerEngine()` does (the deployment's `PIM_TRIGGERS_ENGINE` is `internal` and the space was opted in), and never in a guest's space. Elsewhere `/triggers` and `/trigger-runs` answer exactly as any unknown path, `404 {"error":"Not found"}`, whatever the method; the tools aren't installed, and no chat selects them. Turning the space's triggers off uninstalls the tools and takes them out of chats. Schedules', watches' and the computer grant's tools and routes are unchanged.

**Who may do what**, the same on both paths:

| Caller | Sees and changes | Makes triggers for |
| --- | --- | --- |
| The person (HTTP, signed in or with an API token) | Every trigger of their space | Any of their agents (`agentId`, the majordomo by default), delivering to a new chat or an existing chat of that agent |
| The majordomo (tools) | Every trigger | Itself, in the chat it asks from or new chats; another agent, only in new chats (as `schedule_task`'s `agent`) |
| Any other agent (tools) | Only triggers it owns | Itself, in the chat it asks from or new chats |
| A guest | Nothing: `/triggers` and `/trigger-runs` aren't in their routes (`GUEST_ROUTES`, `403`), and their space has neither routes nor tools | — |
| No caller | Nothing: the Worker answers `401` before the space is asked | — |

A trigger the caller may not see is `not_found`, exactly as one that doesn't exist. A tool acts as the agent of the chat it is called in (`#roleOf`); a task's conversation, a review and a visit don't select the tools. An existing chat a trigger delivers to must be one the host's preflight would take (open, the owning agent's, not a group chat's seat or a visit). A trigger the person made over HTTP has `originChatId` `api` (`origin: {"type":"api"}`), or the existing chat it delivers to.

### Routes

Every body is JSON; times are milliseconds since 1970 (UTC), and a source's `at`, `anchorAt` and `expiresAt` may also be given as ISO 8601 text with an offset. Bodies are at most 64 KiB. Responses carry `Cache-Control: no-store`; those that return one trigger carry `ETag: "<revision>"`. The revision is the spec's: lifecycle and health change without it.

| Method and path | Takes | Answers |
| --- | --- | --- |
| `GET /triggers` | `lifecycle`, `agentId`, `sourceKind`, `limit` (1 to 50, 20 by default), `cursor` | `{ triggers: Trigger[], nextCursor }`, oldest first. Deleted triggers only with `lifecycle=deleted` |
| `POST /triggers` | `CreateTrigger`; optional `Idempotency-Key` | `201` with the `Trigger`; `200` with the same one when the key was used with the same request |
| `GET /triggers/:id` | | The `Trigger`, a deleted one included |
| `PATCH /triggers/:id` | `If-Match` (required); `UpdateTrigger` | The `Trigger` at its new revision; the same one when nothing changed |
| `DELETE /triggers/:id` | Optional `If-Match` | `{ deleted: true, trigger }`. A stop asked for: a run already going goes on, and its history stays |
| `POST /triggers/:id/pause` | Optional `If-Match` | The `Trigger`, `paused` |
| `POST /triggers/:id/resume` | `If-Match` (required) | The `Trigger`, `enabled`, exactly as at that revision |
| `POST /triggers/:id/test` | `{ samples?, count? }` | A `DryRun` |
| `GET /triggers/:id/runs` | `limit`, `cursor` | `{ runs: Run[], nextCursor }`, newest first |
| `GET /trigger-runs/:runId` | | The `Run` |

There is no route to run a trigger now, and none for the sources: `list_trigger_sources` is a tool only so far. `If-Match` takes `"3"` or `3`; a weak or other ETag is `400`. A cursor is opaque, works only for the listing that gave it (and, for runs, that trigger), and is `invalid_cursor` anywhere else. Unknown query parameters are ignored; unknown body fields are refused.

### Tools

`create_trigger`, `update_trigger` (`expectedRevision`), `list_triggers`, `get_trigger`, `pause_trigger`, `resume_trigger` (`expectedRevision`), `delete_trigger` (optional `expectedRevision`), `list_trigger_runs`, `test_trigger` and `list_trigger_sources` take the same fields as the routes, with `newChat` for the destination (`true` a new chat, `false` the chat they are called in) and `maxPendingEvents` for `delivery`. They answer the same JSON; a refusal is the tool result `{ error, code, ... }` marked as an error. `create_trigger` answers `{ trigger, replayed }`.

**One creation per tool call.** `create_trigger` makes its trigger under the creation key `tool:<conversation>:<tool task>`, the durable identity pi gives the call, so the call replayed after an eviction gives the trigger it made (`replayed: true`) instead of a second one.

### Shapes

`CreateTrigger`: `label` (1 to 120), `instruction` (1 to 10,000), `source`, `condition` (optional, as above), `destination` (`{"type":"new_chat"}` or `{"type":"existing_chat","chatId":<public id>}`; for the person a new chat by default, for an agent its own chat), `delivery` (`{ maxPendingEvents }` for sources of events; `rawSamples` only `false`), `agentId`, `enabled` (false by default: a draft). `source` is one of the shapes under "Sources", told apart by `kind` and, for time, `schedule`; it is read by `parseTriggerSpec`, so every rule there holds.

`UpdateTrigger`: any of `label`, `instruction`, `source`, `condition` (`null` takes it off), `destination`, `delivery`. Absent fields stay. A changed source takes its own defaults for `delivery` when its mode changed, and a computer source changed loses its grant (`authorizationRef` becomes null). The owning agent and origin never change.

`Trigger`:

| Field | Is |
| --- | --- |
| `id`, `revision`, `createdAt`, `updatedAt` | |
| `lifecycle` | What the person wants: `draft`, `enabled`, `paused`, `ended`, `deleted` |
| `health` | How the source is doing, apart from the lifecycle (as stored; its detail text is not in the API) |
| `agentId`, `label`, `instruction`, `source`, `condition` | The current revision's, with every default written in |
| `destination`, `origin` | Chats by their public ids |
| `policies` | In effect, defaults included: `lateness` (`{ maxLatenessMs, missed: "recorded" }` for a one-time source, `{ catchUpMs, coalesce: "latest_due" }` for a recurring one, null otherwise), `maxPendingEvents`, `pendingSnapshots` (1 for states and time), `rawSamples: false`, `runsAtOnce: 1`, `deliveryTtlMs` (24 h), `replayHorizonMs` (7 days, for sources of events), `staleAfterMs` |
| `schedule` | For time sources: `nextFiringAt` (the next firing after now, null once ended or deleted) and `nextCheckAt` (when the engine looks next, only while enabled); null for other sources |
| `capability` | `{ status, delivers, reason }`: what its kind of source does here now (below) |
| `grant` | `{ required, state }`: `not_required`; for computer sources `missing`, `pending_approval` (the person was asked), `current`, `not_current`, or `unavailable` (computer triggers are off) |
| `migration` | Null, or for a shadow `{ kind, legacyId, owner, phase, enableable }` |

`Run` is one occurrence and what came of it. Its id is the occurrence's.

| Field | Is |
| --- | --- |
| `state` | Below |
| `outcomeKnown` | Whether `state` is final and known: `completed`, `failed`, `cancelled`, `not_submitted`, `missed`, `superseded` |
| `occurrenceStatus`, `phase` | The store's status, and the coordinator's phase (null before it claimed the occurrence) |
| `revision`, `dueAt`, `evidence` | The revision it fired under; when it was due or observed; why it fired (`time`: `scheduledFor`, `older`; events and states: `truth`, `observedAt`, and the condition's fields with only whether each was there) |
| `chatId` | The chat it was pinned to, once pinned |
| `deliverBy`, `submittedAt`, `acceptedAt`, `endedAt`, `deferrals`, `unknownAnswers`, `createdAt`, `updatedAt` | As the coordinator recorded them |

| `state` | Means |
| --- | --- |
| `pending` | Taken in; not claimed yet |
| `preparing` | Claimed; nothing submitted |
| `submitting` | Submitted, and whether it was accepted isn't known |
| `accepted` | Accepted; how its run is doing isn't known yet |
| `queued`, `running`, `waiting_approval` | What the host last said of the run |
| `completed`, `failed`, `cancelled` | What the host said the run ended as |
| `not_submitted` | Known never handed on: refused, out of time or attempts, or its trigger deleted before it was claimed |
| `missed` | Too late to run; recorded only |
| `superseded` | A newer firing or snapshot took its place before it was handed on |
| `outcome_unknown` | Its attempts ran out, or it was deleted while claimed, and what happened isn't known |

Accepted is never called done, and unknown is never called a success or a failure. A run's error text isn't in the API, since it may carry what a host said.

`DryRun`: `{ dryRun: true, valid: true, sourceKind, capability, grant, policies, blockers }`, with `id`, `revision` and `lifecycle` when it tests a trigger by id; for a time source `firings` (each `{ at, timeZone, local, offset }`, `count` of them, 5 by default and at most 10), `skipped`, `skippedCount` and `exhausted`; for other sources `evaluations`, one per sample (`{ value, observedAt?, gap? }`, at most 10, values within the store's 16 KB and 8 levels): `{ index, truth, fires, stale, fields }`, in order from a fresh start, as `evaluate` would on those samples alone. `blockers` lists the codes enabling would meet now (`source_not_wired`, `grant_required`, `grant_not_current`, `schedule_exhausted`, `owned_elsewhere`). Over HTTP it tests the trigger in the path; `test_trigger` also takes `trigger`, what `create_trigger` takes. **A dry run writes nothing** (not a row of the space's database, the tests check every table), starts no agent turn, runs no command and sends no request; a time source observes nothing, so it takes no samples.

### Sources here

`list_trigger_sources` says, per kind, what this space can do now, never more:

| Kind | `status` | Why |
| --- | --- | --- |
| `time` | `available` | The engine admits and hands on time firings |
| `connector_event` | `draft_only` (`not_wired`) | Nothing takes events in or subscribes yet. It lists the connector events the agent may use (the connectors it works with, and the events their catalogs list); a source must name one of them |
| `poll`, `stream`, `process` | `available` behind computer triggers' gate, else `unavailable` (`computer_triggers_off`) | Behind the gate they need the person's grant to be enabled (`requiresGrant`), and say whether a computer is paired |
| `file` | `unavailable` (`not_wired`) | Nothing hands a file's occurrence on |

A kind that is `unavailable` can't be made or edited in; one that is `draft_only` can be kept only as a draft: enabling it, making it enabled, or editing an enabled trigger to it is `source_not_wired`.

**Shadows of schedules and watches** are listed like any trigger, with `migration` saying their schedule or watch owns them (`owner: legacy`, `enableable: false`). The API never changes one: editing, pausing, resuming and deleting are `owned_elsewhere`, a dry run lists `owned_elsewhere` among its blockers, and only rolling the migration back removes one, after which it reads as deleted with `phase: rolled_back`.

### Errors

Every refusal is `{ "error": <message>, "code": <code>, ... }`. Messages name fields, never values: a validation message that would repeat any string or key of the request is replaced by "is not valid", and the field of a connector's arguments or a sample's value stops where the caller's own keys begin. Nothing secret, observed or sampled is ever in one.

| Status | `code` | When | Also |
| --- | --- | --- | --- |
| 400 | `invalid_request` | A field the spec or the API refuses, an unknown field, a body that isn't JSON, a bad `limit`, `If-Match` or `Idempotency-Key` (413 for a body over 64 KiB) | `field` |
| 400 | `invalid_cursor` | A cursor this listing didn't give | `field` |
| 403 | `forbidden` | An agent making a trigger for another agent (not the majordomo), or delivering to a chat other than its own | |
| 404 | `not_found` | No such trigger or run, or one the caller may not see | |
| 409 | `revision_conflict` | The trigger isn't at the named revision | `currentRevision` |
| 409 | `invalid_transition` | Pausing what isn't enabled, resuming what can't be, editing an ended trigger | `lifecycle` |
| 409 | `trigger_deleted` | Changing a deleted trigger | |
| 409 | `owned_elsewhere` | Changing a shadow its schedule or watch owns | |
| 409 | `grant_required`, `grant_not_current` | Enabling a computer source without a current grant | |
| 409 | `schedule_exhausted` | Enabling a time trigger with no firing left | |
| 409 | `source_not_wired` | Enabling a kind of source nothing here delivers | |
| 409 | `idempotency_conflict` | An `Idempotency-Key` used before with another request | |
| 422 | `unknown_agent` | No such agent | `field` |
| 422 | `chat_unavailable` | No chat of the owning agent a trigger may deliver to | `field` |
| 422 | `source_unavailable` | A kind of source not offered here, or a connector event the agent doesn't work with | `field` |
| 428 | `revision_required` | `PATCH` or resume without `If-Match` (`expectedRevision` for the tools) | |
| 500 | `internal` | Anything else; the reason is logged by name only | |

A time source with no firing left when it is saved is `invalid_request` on `source`, as the store refuses it.

### What a space holds

Creating with a key makes `pim_trigger_api_creations` (`API_TABLES`): one row per key, holding a SHA-256 digest of the caller and key (never the key), the trigger's id, a digest of the request, and when. It is in the export (`triggerHistory`) and `remainingData` ("triggers' creation keys") when it exists, and erasing the space removes it. Nothing else is new: the API reads and writes through the store and reads the coordinator's runs.

**Not done here**: a screen; a route for the sources; a manual run; grants through the API (`trigger_computer_grant` stays the way to ask); filtering runs by state; collecting old creation keys.

## Turning it on later

What is left, roughly in order. Each step is its own change:

1. **Done behind the gate: the engine in `Pim`, and its wake** (below). An `authorize` that looks a reference up among the space's grants, made only from the person's own approvals of exactly that source, is done behind computer triggers' own gate (above); without it none is passed, so no computer source can be enabled. Still to do: the decision to set either gate in a deployment.
2. **Done behind the gate: the real host** (below). Left for this step: a notification when a trigger starts a chat, and a bridge that tells the coordinator when a run ends (`runStatusChanged`) rather than its asking every `runCheckMs`.
3. **Tools, routes and UI for time triggers.** Done behind the gate: the API, its routes and agents' tools (above), with `previewFirings` in a dry run and the refusals as coded errors. Left: the screen, a route for the sources, and a manual run.
4. **Connector events.** Done, unwired: the ingress adapter, the renewal contract, the subscription manager that records bindings, intents and grants (above), and handing events on through the coordinator with `connectorEvents`. Left: a real provider over the MCP bridge, a route, a wake for the manager, a cursor kept with a gap, and turning the manager and `connectorEvents` on in Pim's engine.
5. **Computer observers.** Done behind two gates, unwired: pim-computer's runtime and observers (triggers-runtime.md) and the space's side (above), with health from the connection (`waiting_computer`, `reconnecting`) and `recordGap` from the runtime's gaps. Also done behind computer triggers' gate: the agent's tool that asks for a grant and the action that records it, refreshing the computer when a trigger or grant changes, handing computer occurrences on (kind and id only), and keeping the link and its lease across an eviction. Left: a route or UI to ask for, see and revoke grants, a contract for what of an observation a run may read, and a run against a real pim-computer and Durable Object.
6. **Moving schedules and watches.** Done behind its own gate, unwired: the mapping, the preview, draft shadows owned by the schedule or watch, and rollback (below). Left: everything in its cutover blockers, and the cutover itself.

Not done here: setting the gate in any deployment, any observer, a UI, tools and routes outside the gate, a notification for a trigger's chat, a run-status bridge, a manual run, keeping raw samples, expiry for computer sources other than a process, handing a schedule or watch over to its trigger, and quotas across a space's triggers. The coordinator hands on time firings, and connector events only when made with `connectorEvents`, which nothing in Pim does; it doesn't cancel or stop a run (deleting or pausing a trigger doesn't stop one already going), and a chat it made for an operation that was never submitted is left for the host to clean up.

These are conditions for later tranches to meet before they are accepted, not work done here:

- A grant is checked again before ongoing execution and admission, so a revoked grant stops a computer source that is already running, not only its next enabling. Met behind computer triggers' gate: every reconcile and admission checks it; a revoked grant's observations are refused at once and its observer stops at the next reconcile.
- Expiry moves a trigger on: a process watch past `expiresAt` ends its trigger, rather than only refusing its exit.
- A deleted trigger's history is collected 30 days after its deletion.
- A written contract for source context: what of an event or observation a run may see, and how it reaches the run without the store keeping it. For connector events it is written (the event's name, id, time and which fields were there; never what it carried; see "Handing events on"). For observations on the computer, a run is told only the source's kind, the event's id and its times (`computer_event`), behind computer triggers' gate; what was observed is never kept or handed on, and there is no contract yet for letting a run read it.
- A trigger whose source changed from events to time, with an event occurrence still pending ahead of its time firings, is blocked behind it while the coordinator doesn't hand events on (without `connectorEvents`, as in Pim): it never hands the event on, and the store hands on in order. With `connectorEvents`, the edit ends that event and the time firings go on. Today its health is only what the change left (`unknown`); it must say so explicitly, as a configuration status, before such a change is offered.
- With raw samples off, nothing observed reaches a chat, a diagnostic or a dedup record.
- Consent for a recurring script says truthfully that it runs as the person's own OS user, with that user's access.
