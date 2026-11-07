# Triggers

> **Not active.** This is a review-only foundation. Nothing in Pim imports `src/triggers/`: no tool, route, prompt, UI, computer call or schedule uses it, and no space's database has its tables. Schedules (`schedule_task`) and connector watches (`watch_connector_event`) work exactly as before. Turning triggers on, and moving schedules and watches to them, are later changes.

A trigger is work an agent does when something happens: at a time, on a connector's event, or when something it watches on the person's computer changes. Triggers are meant to replace schedules and watches with one thing people see and manage. Each space's Durable Object stays the authority for its triggers; the person's computer runs the observations (polls, streams, process exits, files), and Pim keeps the record and decides what is an occurrence.

The code is in four modules, with tests in `test/triggers.test.ts` and `test/triggers-time.test.ts`:

| Module | What it is |
| --- | --- |
| [`src/triggers/spec.ts`](../src/triggers/spec.ts) | The spec: the typed, versioned definition, read from untrusted JSON with its defaults written in |
| [`src/triggers/condition.ts`](../src/triggers/condition.ts) | Conditions: a restricted expression, its bounded state, and a pure evaluator |
| [`src/triggers/store.ts`](../src/triggers/store.ts) | `TriggerStore`: the tables and the transactions that change them |
| [`src/triggers/time.ts`](../src/triggers/time.ts) | When a time source fires: one pure computation for checking, previewing and selecting the due firing |

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

These are decided now, so integration doesn't have to guess. The store enforces the lateness rules; computing due times is the scheduler's job, which isn't built yet.

- **One-time** triggers run up to `maxLatenessMs` (1 h) late; later than that, the firing is recorded as `missed` and nothing runs. Either way the trigger ends.
- **Recurring** triggers run their latest due firing if it is at most `catchUpMs` (1 h) late, and record older ones as missed. The store refuses a firing that is no later than one it already took.
- **New local cron**, in the person's time zone: a time that doesn't exist on a daylight-saving day (it falls in the skipped hour) is skipped, and a time that happens twice (in the repeated hour) runs once, at its first instant. `src/triggers/time.ts` computes this (below).
- **Migrated schedules** keep their cron in `UTC`, unchanged.
- **Polls** run every 5 minutes by default, at most once a minute, and each poll has 30 seconds.
- A state goes **stale** after two intervals unless the condition sets `staleAfterMs`.
- **Handing on**: one attempt at a time per trigger. A state, or a time trigger, holds one pending snapshot. Events queue, up to 20 by default (`maxPendingEvents`, up to 100).
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

**Selecting a due firing.** `after` is the instant after which firings count: the trigger's watermark (`lastObservedAt`, the last firing it admitted), or before its first firing, the instant before it was enabled. Of the firings after `after` and at or before `now`, only the latest is selected, so an outage of days runs once. It is `due` when `now` is at most its deadline, which is its time plus the source's `catchUpMs` (or a one-time trigger's `maxLatenessMs`), inclusive, and `missed` after that. The deadline depends only on the firing, so retrying the delivery never moves it. The older firings are not listed: `older` gives how many there were and the first and last. A firing at or before `after` is never selected again, so a restart never replays one, and a clock that reads earlier than `after` selects nothing.

**Bounds.** Instants given in (`now`, `after`, `at`) are whole milliseconds from 2000 to 2100, as a spec's are. A cron search walks local calendar days, skipping months the expression leaves out, and resolves only the times of days that match, so its cost is bounded by days, never minutes. It looks at most 4,400 days (just over 12 years) forward or back. That finds every expression whose days may match either field, the 29th of February included (8 years apart around 2100, which is not a leap year), and a date on one day of the week (at most 11 years apart). A rarer expression, such as `0 0 29 2 */7` (the 29th of February on a Sunday, 28 years apart), has no firing within it: its preview is empty and `exhausted`. **A schedule whose preview has no firings should be refused when it is saved.** After an outage longer than the horizon, `older` counts only the firings within it and says so (`complete: false`). Counting them doesn't go through every firing: a day on one offset is counted whole. An interval's firings, and a one-time trigger's, are worked out, not searched for.

**Time zones** come from the runtime's `Intl` data, read as the Temporal polyfill reads them: the offset at an instant is what `Intl` shows there, and a local time is resolved by trying the offsets a day before and after it. That relies on a zone changing its offset at most once in any three days, which holds for every zone from 2000 to 2115 (the closest two changes, in America/Boa_Vista in 2000, are almost seven days apart). Offsets that aren't whole hours (Asia/Kathmandu's +05:45) and a half-hour change of daylight saving time (Australia/Lord_Howe) work as any other. The zone data is the runtime's, so a zone whose rules change takes effect when the runtime's data does.

**A local time for a one-time trigger** is the caller's to choose. `resolveLocalTime` applies no cron rule: an ambiguous time returns both instants, and a nonexistent one returns a suggestion (the time moved later by the length of the skip, as clocks read it: 02:30 suggests 03:30). A tool that sets a reminder must ask which, rather than take the first instant or skip the reminder. The spec's `at` stays an instant.

## The store

`new TriggerStore(sql, { transaction, now, authorize?, newId?, retention? })` makes its own tables, prefixed `pim_trigger`, in the database it is given. `transaction` is the Durable Object's `transactionSync`, `now` is the clock, and `authorize` is the host's check of grants. Only the tests construct one; `PimStore` and the `Pim` constructor are unchanged.

| Table | Holds |
| --- | --- |
| `pim_triggers` | Current revision, lifecycle, health, generation. A deleted trigger keeps its row, as `deleted` |
| `pim_trigger_revisions` | Each revision's spec. A SQLite trigger refuses any update |
| `pim_trigger_sources` | The source's revision, checkpoint (`position`, `cursor`), last observation time, pending gap, condition state |
| `pim_trigger_inbox` | Each event id taken in within the replay horizon, unique by (source identity, event id), with what came of it but not its data |
| `pim_trigger_occurrences` | Occurrences, unique by (trigger, occurrence key), with their evidence. A SQLite trigger keeps each one's revision and evidence fixed |
| `pim_trigger_outbox` | One item per occurrence (unique), with a stable unique `operationId` |
| `pim_trigger_tombstones` | When each trigger was deleted |

Every method that writes does all its writes in one transaction. A refusal writes nothing, so the source may send the same thing again.

- **Revisions** (`create`, `update`). `update` takes `expectedRevision` and is refused on a mismatch (compare-and-swap). The same spec again changes nothing. A new source or a new condition starts a new generation, so an observation made under the old ones is refused (`stale_generation`) rather than judged by the new condition, and the condition starts over. A new source also gets a new source identity and no checkpoint. A new label, instruction, destination or delivery is only a new revision. An ended trigger can't be edited.
- **Lifecycle** (`setLifecycle`). Draft or paused to enabled; enabled to paused; anything but ended to ended. Every change starts a new generation, and a break (above). **Enabling must name the revision it means**, and checks a computer source's grant again; pausing and ending are always safe and may leave it out. A paused trigger keeps its undelivered occurrences until it is enabled again. An ended one still hands on what it already took in.
- **Deleting** (`remove`). The trigger stops for good: a new generation, nothing more is claimed, and its id and anything its observers send are refused. Occurrences no attempt had claimed are `cancelled`. **Deleting asks for a stop; it is not proof that anything was cancelled or undone.** An occurrence with an attempt under way may already have been handed on, and a run it started may go on, so it becomes `outcome_unknown`, not cancelled. That attempt can no longer `complete` or `fail` it; `reconcile` records it as delivered or failed once that is known, without claiming anything or bringing the trigger back. **What it did is kept:** its row (as `deleted`), its revisions, its occurrences with their evidence, and its outbox items with how each ended. Its source state and inbox, which only served taking in events, go. **`eraseAll`** is separate: it removes every trigger of the space and everything they recorded, tombstones included, for erasing the space.
- **Admission** (`admit`, `admitTimeFiring`). An observer passes the generation it was started for. Both methods first check, in order, that the trigger exists (`not_found`), isn't deleted (`deleted`), is at that generation (`stale_generation`), is enabled (`not_enabled`), and has the right kind of source (`wrong_source`). Then, in one transaction, the store writes the inbox entry, advances the checkpoint, updates the condition state, and writes the occurrence with its outbox item when the condition fires.
  - The **source identity** is the trigger's id and the revision its source was set in (`<id>#<revision>`). An event id is taken once per identity (`duplicate`), and a new source may reuse old ids. Occurrence keys carry the identity too: `event:<identity>:<eventId>`, and `time:<scheduledFor>`.
  - **Replay horizon.** Event ids, filtered ones included, are remembered for the horizon (7 days by default, and no less), plus 5 minutes for clocks ahead. An event or observation from before the horizon is refused (`too_old`), because whether it was taken in before can no longer be told. So `observedAt` must be the event's own time, the same on every delivery of it. Within the horizon a trigger remembers at most `inboxCap` ids (20,000 by default, room for a poll a minute twice over); past that, admissions are refused (`inbox_full`) until old ids expire, and no id within the horizon is forgotten to make room.
  - The **checkpoint** moves only to a higher `position`.
  - A state **no newer** than the last observation is refused (`out_of_order`). Events are taken in any order.
  - **Events are bounded, not merged.** Past `maxPendingEvents` undelivered occurrences, an event is refused (`backpressure`) and its source retries; no event is dropped or coalesced silently. A new snapshot of a state, or a time firing, supersedes an older undelivered one, which is marked `superseded`. An attempt already under way is left to finish.
  - A process's exit ends its trigger, and one after `expiresAt` is refused (`expired`).
  - A one-time firing must be at `at`, and an interval firing on its grid, or it is refused (`schedule_mismatch`). A firing before its time is `not_due`.
- **Handing on** (`claim`, `complete`, `fail`, `reconcile`). `claim` leases the next attempt: at the oldest unsettled item of an enabled or ended trigger, when no older item of that trigger is unsettled. So each trigger has **one attempt at a time**, in order. That is not one run at a time: once a submission is accepted, the run it starts may still be going when the next occurrence is handed on, and keeping runs apart is the job of the coordinator that will call the store. Each claim is a new attempt with the **same operation id**.
  - `complete` means the submission was accepted, not that the agent's run finished or succeeded.
  - `fail` means the attempt is known not to have handed the occurrence on. It retries from `retryAt`, and fails for good after 5 attempts or with no `retryAt`.
  - `complete` and `fail` take the attempt, and do nothing once a later claim or a deletion has superseded it.
  - A lease that runs out says nothing of whether the submission happened, so the item is claimed again. After 5 attempts it isn't claimed again: its outcome is `outcome_unknown`, the next item goes on, and `reconcile` settles it as delivered or failed once the deliverer has found out, such as from the operation id's record.
- **Revision snapshots.** An occurrence records the revision it happened under, and `claim` returns the spec of that revision, so an edit after the event doesn't change what the run is told.
- **History.** Within the horizon every occurrence is kept. Of settled occurrences from before it, each trigger keeps its newest 200 (`retention.occurrences`). Unsettled ones, `outcome_unknown` included, are always kept.

**No exactly-once outside.** The store's guarantees are about this database. A deliverer that passes `operationId` to `submitTo` (which takes an operation id) makes a retried submission one run. Anything outside Pim (a connector, a command on the computer) may still see a request twice.

**Nothing observed is kept.** Inbox entries keep an event's id and what came of it, occurrences keep the evidence above, and condition state keeps digests, flags and times. The errors and health details a deliverer or observer records (`fail`, `setHealth`) are theirs to keep free of what was observed.

Inputs are bounded: event ids up to 256 characters, cursors up to 1 KB, payloads up to 16 KB and 8 levels as JSON, observation times no more than 5 minutes ahead of the clock, leases up to 1 hour, errors up to 1,000 characters.

## Turning it on later

What is left, roughly in order. Each step is its own change:

1. **Construct the store in `Pim`.** Pass `ctx.storage.sql`, `transactionSync`, `Date.now`, and an `authorize` that looks the reference up among the space's approvals and checks it is current and was given for exactly this source. Add the tables in `TRIGGER_TABLES` to `PimStore.remainingData`, and call `eraseAll` when the space is erased.
2. **A deliverer and a run coordinator.** On the Durable Object's alarm, `claim` attempts. Hand each one to `submitTo(chat, message, { operationId: item.operationId }, "pim")`, starting a chat for `new_chat` destinations as `runScheduledTask` does, then `complete`, `fail`, or later `reconcile`. A `429` from the run limit maps to `budget_blocked` health. Use the spec returned with the claim, not the current one. Keeping one run per trigger at a time, and the event content a run needs without the store keeping it, are this step's to decide.
3. **A scheduler for time sources.** On the alarm, for each enabled time trigger, call `selectDueFiring` with the clock and the source's watermark (`lastObservedAt`, or the instant before the trigger was enabled), pass a `due` or `missed` firing's `scheduledFor` to `admitTimeFiring`, which records a missed one as missed, and set the alarm to the earliest `next`. Admission stays the store's: it refuses a firing it already took and one no later than the watermark. Make `admitTimeFiring` check a cron firing with `isScheduledFiring`, as it checks one-time and interval firings now. Refuse a schedule whose `previewFirings` has no firings when it is saved, and show that preview, skipped times included, when it is made.
4. **Connector events.** Route webhook deliveries, verified as `app-events.ts` verifies them, to `admit` with the event's id. Subscriptions stay with the connector code.
5. **Computer observers.** Messages over pim-computer's connection, carrying the generation they were started for. Health comes from the connection (`waiting_computer`, `reconnecting`), and `recordGap` from reconnects.
6. **Tools, routes and UI**, with approvals filling `authorizationRef` for computer sources.
7. **Moving schedules and watches**, behind a migration that keeps their behavior.

Not done here: the scheduler that calls `src/triggers/time.ts` and sets alarms, `admitTimeFiring` checking that a cron firing falls on its expression, any observer, deliverer, coordinator, tool, route or UI, a manual run, keeping raw samples, expiry for computer sources other than a process, the migration, and quotas across a space's triggers.

These are conditions for later tranches to meet before they are accepted, not work done here:

- A grant is checked again before ongoing execution and admission, so a revoked grant stops a computer source that is already running, not only its next enabling.
- Expiry moves a trigger on: a process watch past `expiresAt` ends its trigger, rather than only refusing its exit.
- A deleted trigger's history is collected 30 days after its deletion.
- A written contract for source context: what of an event or observation a run may see, and how it reaches the run without the store keeping it.
- A coordinator that keeps agent runs apart, separate from the outbox, which only guarantees one attempt at a time.
- The scheduler, the preview and the save-time check all use `src/triggers/time.ts`, so what previews a schedule is what dispatches it.
- A firing is admitted up to and including its due time plus 1 hour, and retries don't move that deadline.
- With raw samples off, nothing observed reaches a chat, a diagnostic or a dedup record.
- Consent for a recurring script says truthfully that it runs as the person's own OS user, with that user's access.
