# Triggers

> **Not active.** This is a review-only foundation. Nothing in Pim imports `src/triggers/`: no tool, route, prompt, UI, alarm, computer call or schedule uses it, and no space's database has its tables. The coordinator is built only by tests, with a fake host: there is no real host behind it yet, so nothing it does reaches a chat or an agent. Schedules (`schedule_task`), connector watches (`watch_connector_event`) and Pim's own alarms work exactly as before. Turning triggers on, and moving schedules and watches to them, are later changes.

A trigger is work an agent does when something happens: at a time, on a connector's event, or when something it watches on the person's computer changes. Triggers are meant to replace schedules and watches with one thing people see and manage. Each space's Durable Object stays the authority for its triggers; the person's computer runs the observations (polls, streams, process exits, files), and Pim keeps the record and decides what is an occurrence.

The code is in five modules, with tests in `test/triggers.test.ts`, `test/triggers-time.test.ts` and `test/triggers-coordinator.test.ts`:

| Module | What it is |
| --- | --- |
| [`src/triggers/spec.ts`](../src/triggers/spec.ts) | The spec: the typed, versioned definition, read from untrusted JSON with its defaults written in |
| [`src/triggers/condition.ts`](../src/triggers/condition.ts) | Conditions: a restricted expression, its bounded state, and a pure evaluator |
| [`src/triggers/store.ts`](../src/triggers/store.ts) | `TriggerStore`: the tables and the transactions that change them |
| [`src/triggers/time.ts`](../src/triggers/time.ts) | When a time source fires: one pure computation for checking, previewing and selecting the due firing |
| [`src/triggers/coordinator.ts`](../src/triggers/coordinator.ts) | `TriggerCoordinator`: admits due time firings and hands each to its agent through an injected host, one agent run per trigger at a time |

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

**Bounds.** Instants given in (`now`, `after`, `at`) are whole milliseconds from 2000 to 2100, as a spec's are. A preview or a `next` may still name a later instant (from 2097, the next 29th of February is in 2104); nothing past 2100-01-01 is ever scheduled or admitted. A schedule whose next firing is past it is refused when saved, and one that reaches it while enabled stops there (`admitDueTime`'s `limit`, below). A cron search walks local calendar days, skipping months the expression leaves out, and resolves only the times of days that match, so its cost is bounded by days, never minutes. It looks at most 4,400 days (just over 12 years) forward or back. That finds every expression whose days may match either field, the 29th of February included (8 years apart around 2100, which is not a leap year), and a date on one day of the week (at most 11 years apart). A rarer expression, such as `0 0 29 2 */7` (the 29th of February on a Sunday, 28 years apart), has no firing within it: its preview is empty and `exhausted`. **A schedule whose preview has no firings should be refused when it is saved.** After an outage longer than the horizon, `older` counts only the firings within it and says so (`complete: false`). Counting them doesn't go through every firing: a day on one offset is counted whole. An interval's firings, and a one-time trigger's, are worked out, not searched for.

**Time zones** come from the runtime's `Intl` data, read as the Temporal polyfill reads them: the offset at an instant is what `Intl` shows there, and a local time is resolved by trying the offsets a day before and after it. That relies on a zone changing its offset at most once in any three days, which holds for every zone from 2000 to 2115 (the closest two changes, in America/Boa_Vista in 2000, are almost seven days apart). Offsets that aren't whole hours (Asia/Kathmandu's +05:45) and a half-hour change of daylight saving time (Australia/Lord_Howe) work as any other. The zone data is the runtime's, so a zone whose rules change takes effect when the runtime's data does.

**A local time for a one-time trigger** is the caller's to choose. `resolveLocalTime` applies no cron rule: an ambiguous time returns both instants, and a nonexistent one returns a suggestion (the time moved later by the length of the skip, as clocks read it: 02:30 suggests 03:30). A tool that sets a reminder must ask which, rather than take the first instant or skip the reminder. The spec's `at` stays an instant.

## The store

`new TriggerStore(sql, { transaction, now, authorize?, newId?, retention? })` makes its own tables, prefixed `pim_trigger`, in the database it is given. `transaction` is the Durable Object's `transactionSync`, `now` is the clock, and `authorize` is the host's check of grants. Only the tests construct one; `PimStore` and the `Pim` constructor are unchanged.

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

`new TriggerCoordinator(sql, { store, host, transaction, now, ... })` admits time firings and hands them to the owning agent. It makes one table, `pim_trigger_runs` (`COORDINATOR_TABLES`), beside the store's in the same database, and reads the store's outbox and occurrences there to choose what to hand on. Only the tests construct one, with a fake clock and a fake host. **There is no real host yet**: the adapter over `submitTo` is the next reviewed integration, and until then nothing reaches a chat, an agent or the run limit.

`tick()` is one bounded pass, safe to run at any time, twice at once, or after a crash. It returns what it did and `nextWakeAt`, when the host's alarm should next fire (no alarm is registered here).

1. **Admit.** Up to `batch.admissions` (16) time triggers whose wake has come, earliest first: `admitDueTime` for each.
2. **Tidy.** Occurrences the store lost track of (`outcome_unknown`, from leases run out or a deletion while claimed) with no run here are adopted as possibly submitted, so the host is asked about them. Runs that never submitted, whose occurrence was superseded, cancelled, failed or deleted, are closed. Ended runs whose occurrence the store's history let go are pruned with it.
3. **Reconcile.** Up to `batch.lookups` submissions whose outcome isn't known are looked up, then up to as many accepted runs are asked about.
4. **Hand on.** Up to `batch.handoffs` (4) triggers, one occurrence each, while the space has compute free (`maxRunning`, 4). The trigger handed on to longest ago goes first, so a busy trigger can't starve the rest. A trigger whose run slot is taken, whose next occurrence isn't a time firing, or that is paused or deleted, is passed over.

Every query is bounded by its batch; nothing lists all triggers and fans out.

### A run

Each occurrence is one **operation**, keyed by its outbox item's `operationId`, the same for every attempt. Its run record keeps, fixed from its first claim (a SQLite trigger refuses changing them): the trigger, the occurrence, its spec **revision**, the owning **agent**, `scheduledFor`, `admittedAt` (when the firing was admitted) and `deliverBy` (`admittedAt` plus `deliveryTtlMs`, 24 hours). The **chat** is pinned before anything is submitted, and a pinned chat never changes. It also keeps when it was first and last dispatched, submitted, accepted and ended, the host's receipt, deferrals and the last error.

| Phase | Means | Holds the trigger's slot | Holds compute |
| --- | --- | --- | --- |
| `preparing` | Claimed; nothing submitted. A deferred one waits here | No (the outbox's lease does) | No |
| `submitting` | The host was asked to submit; whether it accepted isn't known | Yes | Yes |
| `accepted` | Accepted; how the run is doing isn't known yet | Yes | Yes |
| `queued`, `running` | What the host said of the run | Yes | Yes |
| `waiting_approval` | The run waits for the person's approval | Yes | **No** |
| `completed`, `failed`, `cancelled` | What the host said the run ended as | No | No |
| `not_submitted` | Known never handed on, and it won't be | No | No |

**One agent run per trigger.** A trigger's next occurrence isn't handed on while any of its runs holds the slot. Its time firings meanwhile coalesce in the store: a newer one supersedes a pending one, so only the latest waits. A claimed, submitting or running one is never superseded. The slot is freed only when the host says the run ended, by `lookupRun` or by `runStatusChanged`; a submission's acceptance never stands for its run's end.

### The host

The host is injected (`TriggerAgentHost`). Each method may throw, and a throw is "not known", never success or refusal.

| Method | Contract |
| --- | --- |
| `preflight({ triggerId, operationId, agentId, destination, sourceKind })` | Before each new handoff: the agent exists, an existing chat is still that agent's, the space is active. A refusal that isn't `retryable` ends the operation. It never substitutes another agent or chat, and it grants nothing: the run's actions still go through approvals |
| `findChat({ operationId })` | The chat made for the operation: `found`, `absent` or `unknown` |
| `createChat({ operationId, agentId, title })` | Makes a chat keyed by the operation: `created` or `denied` |
| `lookupSubmission({ operationId })` | `accepted` with its receipt, `absent` (wasn't accepted; may still be submitted under the key), or `unknown` |
| `submit({ idempotencyKey, chatId, agentId, instruction, evidence })` | At most one acceptance per key, reserving the run budget only for a new one. `accepted`, `duplicate` (accepted before; its reservation given back), `budget_blocked` (nothing reserved), `suspended`, `failed` (definitively not accepted), or `uncertain` |
| `lookupRun({ operationId, receipt })` | `queued`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled` or `unknown` |

The instruction is the pinned revision's. The **evidence** is fixed when the occurrence is handed on and holds only the firing's times and the schedule: `{ kind: "time", triggerId, revision, label, scheduledFor, admittedAt, schedule, older }`. A time source observes nothing, so there is nothing else to leave out. A trigger's instruction is not an approval of anything the run does.

### What happens when

| Situation | What the coordinator does |
| --- | --- |
| Two ticks at once, or the alarm again | Admission is one transaction that moves the watermark; a claimed occurrence is leased, and this instance won't claim or ask about an operation it is waiting on. One occurrence, one submission |
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
| An occurrence of another source | Never claimed; it stays pending |
| A run waiting for approval | Holds its trigger's slot, but none of the space's compute |
| A callback for an older receipt, or a run that ended | Changes nothing |

## Turning it on later

What is left, roughly in order. Each step is its own change:

1. **Construct the store and the coordinator in `Pim`.** Pass `ctx.storage.sql`, `transactionSync`, `Date.now`, and an `authorize` that looks the reference up among the space's approvals and checks it is current and was given for exactly this source. Add the tables in `TRIGGER_TABLES` and `COORDINATOR_TABLES` to `PimStore.remainingData`, and call both `eraseAll`s when the space is erased. Run `tick` from the Durable Object's alarm, alongside the alarms Pim keeps already, and set the alarm to its `nextWakeAt`.
2. **A real host.** `submit` over `submitTo(chat, message, { operationId }, "pim")`, which already reserves the run once per operation and gives a duplicate's back; `lookupSubmission` over the harness's `submissionByRequest`; `createChat` and `findChat` keyed by the operation, as `#scheduledChat` keys a firing; `lookupRun` and `runStatusChanged` from the run's status, with waiting for an approval as its own status; `preflight` that refuses, rather than replaces, a deleted agent or chat (today's schedules fall back to the chat's agent; triggers must not). How a time firing reads in the chat, and the notification, are this step's. On `main` since this foundation's base, `submitTo` from `pim` into a finished task's chat rewrites the operation id to `wake:<id>`, depending on the task's state at that moment, so a retry after the task reopened would go in under another key; the real host must keep one key per operation (and look it up in the form it was submitted under) before it can claim the idempotency this contract needs.
3. **Tools, routes and UI for time triggers**: showing `previewFirings`, skipped times included, when one is made, and the refusals when it is saved.
4. **Connector events.** Route webhook deliveries, verified as `app-events.ts` verifies them, to `admit` with the event's id, and a written contract for what of an event a run may see before the coordinator hands event occurrences on. Subscriptions stay with the connector code.
5. **Computer observers.** Messages over pim-computer's connection, carrying the generation they were started for. Health comes from the connection (`waiting_computer`, `reconnecting`), and `recordGap` from reconnects.
6. **Moving schedules and watches**, behind a migration that keeps their behavior.

Not done here: a real host, the alarm, any observer, tool, route or UI, a manual run, keeping raw samples, expiry for computer sources other than a process, the migration, and quotas across a space's triggers. The coordinator hands on time firings only; it doesn't cancel or stop a run (deleting or pausing a trigger doesn't stop one already going), and a chat it made for an operation that was never submitted is left for the host to clean up.

These are conditions for later tranches to meet before they are accepted, not work done here:

- A grant is checked again before ongoing execution and admission, so a revoked grant stops a computer source that is already running, not only its next enabling.
- Expiry moves a trigger on: a process watch past `expiresAt` ends its trigger, rather than only refusing its exit.
- A deleted trigger's history is collected 30 days after its deletion.
- A written contract for source context: what of an event or observation a run may see, and how it reaches the run without the store keeping it. Until then, the coordinator hands on nothing but time firings.
- The real host meets the contract above: an idempotent submission per operation, one reservation per operation, a chat keyed by operation, and run status from the run, never from the submission.
- With raw samples off, nothing observed reaches a chat, a diagnostic or a dedup record.
- Consent for a recurring script says truthfully that it runs as the person's own OS user, with that user's access.
