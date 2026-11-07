# The stream observer on the computer

> **Not active.** This is a review-only tranche. Nothing imports [`computer/triggers-adapters/stream.ts`](../computer/triggers-adapters/stream.ts) but `observerAdapters` and tests, and nothing imports that: `observerAdapters` ([`index.ts`](../computer/triggers-adapters/index.ts)) offers it, as it does `poll` and `process`, when given stream options (`launcher`, limits, clock) and refuses a `stream` source as `unsupported` when not given them. Nothing passes them: pim-computer constructs no runtime, and no service or install script registers anything. The runtime's side of a stream's end (`endCoverage`, end records, the `ended` state) is in `computer/triggers-runtime.ts`, also unregistered and unused by anything that runs.

A `stream` source (`{ kind: "stream", command, cwd }`, unchanged from `triggers.v1`) is a shell command on the person's computer that keeps running and prints one JSON object per line, each an event. `StreamAdapter` is its `ObserverAdapter`; `NodeStreamLauncher` starts its command.

| Export | What it is |
| --- | --- |
| `StreamAdapter` | Runs one command once, and emits each line it prints as an event, in order, until the stream ends |
| `NodeStreamLauncher` | Starts the command under the poll's leader in a process group of its own, with stdout that can be paused |
| `STREAM_LIMITS`, `checkStreamSource` | The bounds, and the source's own check |

## Authority

**Consent is checked before the adapter exists.** The runtime asks the host's `authorize` check, which keys consent on the exact source, before it calls the factory; a denied source never reaches this module. Nothing here re-decides or loosens that.

**The command is not sandboxed.** It runs as the user who runs pim-computer, with that user's files, network and processes, in the source's `cwd` or the launcher's `defaultCwd`, with only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ` and `TMPDIR` of pim-computer's environment (`pollEnvironment`). What the adapter enforces is its own child's lifecycle and resources, nothing more.

## The child

**One child, never started again.** The command starts once `start` has returned (a timer of 0), never inside it. When it ends, for whatever reason, the adapter reports why and **starts nothing more**: no automatic restart, because running an arbitrary command again can repeat its side effects (posting, consuming a queue, moving files) and can't give back what it printed before. Once its end is recorded (below), the runtime never runs that generation again either: only a new generation, which the space makes on every change of lifecycle or source, does. A stream that hadn't ended when the runtime stopped it (a lease that ran out, a changed grant, a restart) is run again by a new adapter on the space's next reconcile that wants it, after a gap that says coverage broke, and that is a new stream (below).

**Its own process group, signalled only while provably its own.** `NodeStreamLauncher` runs the command under `POLL_LEADER`, exactly as `NodeChildLauncher` does for a poll ([triggers-adapters.md](triggers-adapters.md#poll)): a `/bin/sh` leader in a new group (`detached`), stdin closed, the command its child. The leader reports the command's status on fd 3 and then `kill -9 0`s its own group. The launcher signals the group (`-pid`) only while the leader is unreaped (`exitCode` and `signalCode` both null), so never once its process id, and with it the group's, could be anyone else's. The adapter doesn't signal after the leader's exit either. `cleaned` follows the same evidence rule as a poll's.

**Ending it.** When the adapter ends the stream itself, or is stopped, it sends SIGTERM to the group, SIGKILL after `graceMs` (2 s), and reports `stream_unreaped` if the leader still hasn't exited `reapMs` (2 s) later; if it is reaped after that, the end's code is reported again.

**Unknown cleanup is sticky.** An exit with `cleaned: false` (the leader killed from outside, say) reports `stream_cleanup_unknown`, and from then on it is the only code reported. The group is never signalled again, nothing restarts, and `stop` claims nothing about leftovers. Unlike a poll, the adapter still emits what it reads as at any exit (the complete lines already read, and what the pipe still holds, for at most `drainMs`): they precede the end, and dropping them would be a loss nothing counts.

**What it doesn't contain.** A process that leaves the group (`setsid`, a double fork into a new session) leaves the adapter's reach. If it holds stdout open after the leader has exited, the adapter reads for `drainMs` (1 s), then reports `stream_output_unclosed` and lets go of the pipe; whatever it prints later is never read. Nothing here claims to contain such a process; that would need cgroups or another OS mechanism.

## Output

**JSON Lines, read as data only.** stdout is split on `\n` bytes and each line is decoded as strict UTF-8 and parsed with `JSON.parse` (through the poll's `readPollOutput`), never run or interpreted otherwise. A line must be one JSON object with finite numbers only (`1e999` is refused, never rounded), at most 8 levels below it, 16,384 values and 16 KiB as JSON: the runtime's and the store's own rules. Whitespace around it is allowed, so CRLF line ends are; a line of only whitespace is skipped, as no event.

**Split anywhere.** A chunk may end inside a line, a multi-byte UTF-8 character or a CRLF: lines are only cut at `\n`, which never occurs inside a UTF-8 character, and decoded whole. A record left without a newline counts only at the command's own end, once the leader has exited and stdout has ended, and only if it parses; one cut short by the adapter's own end is dropped.

| Bound | Value | Past it |
| --- | --- | --- |
| Command | 4,000 characters, `TRIGGER_LIMITS.commandLength`; `cwd` absolute or none | `start` throws (`StreamConfigError`); the runtime reports `start_failed` |
| A line | 64 KiB without its newline (`lineBytes`) | The stream ends, `stream_line_too_large`, as soon as the line being printed passes it |
| An event's data | 16 KiB as JSON, 8 levels, 16,384 values, finite numbers | The stream ends: `stream_event_too_large`, `stream_invalid_output` |
| Read and not yet emitted | 1 MiB (`bufferBytes`); reading pauses at 128 KiB (`readHighBytes`) | The stream ends, `stream_output_overflow` |
| Events waiting to be emitted | One, parsed only when the one before it has been taken | Not reachable: the rest waits as bytes, within the buffer |
| stderr | 64 KiB a minute (`stderrBytes`, `stderrWindowMs`) | The stream ends, `stream_stderr_flood` |

**stderr is counted and dropped as it arrives**: never kept, logged, reported or sent. stdout's raw bytes live only in the adapter's memory until each line is parsed and emitted; nothing writes them anywhere else.

**`occurredAt` is when the line's newline was read**, not when the command printed it. While reading is paused the command waits on its pipe, so under backpressure an event can be dated later than it happened; a command that cares should put its own time in its data.

## Events and identity

Each event is `{ occurredAt, data, checkpoint: null, key: "stream:<nonce>:<n>" }`: `nonce` is a random UUID drawn when the adapter is constructed, one per invocation of the command, and `n` the event's place in that invocation's stream, from 0. The runtime turns a key into a stable `eventId` (a digest of the source identity and the key), so:

- **Within one invocation, a line is one event.** An emission retried after `not_started`, `spool_unavailable` or `backpressure` carries the same key and `occurredAt`, so it is the same `eventId`; the next line gets the next number only once the one before is taken. Once the runtime has spooled an event, it keeps its `eventId` and `sequence` through reconnects and runtime restarts, and the space answers a retransmission `duplicate`. The adapter takes no part in that and never re-emits a taken event, so nothing it does can reset the runtime's or the space's claim on an event.
- **Across invocations, nothing is resumable.** There is no checkpoint and no cursor: the adapter ignores `config.resume` and never offers `commit`. A new adapter, when one runs it again, does so under a new nonce; what the old one had read and not yet emitted is gone, and the new one can't name it. If the command prints the same lines again (`tail -n 10` would), they are new events with new ids, and the space can't tell them from new ones; if it doesn't (`tail -F`, a WebSocket script), whatever happened between the two runs is never seen. The runtime records a coverage gap before the new observer's first event (`interrupted` from when the old one stopped, or `coverage_unknown` after a restart); that gap, not anything here, is how the space learns of the break.
- **Durable source ids need a future contract.** Making a stream resumable would need the command itself to print a stable id or cursor per event, and an adapter contract that takes it as the key and checkpoint, with the command given that cursor to resume from. That is a different source kind or an explicit extension of this one, and nothing here pretends to it.

## Delivery

The adapter emits one event at a time and awaits the runtime's answer before the next. While an event waits, the next lines stay bytes in its buffer, and once 128 KiB are held, or the runtime has paused it, stdout isn't read and the command blocks on its pipe. Nothing is resampled: unlike a poll's states, distinct events can't be replaced by a newer reading.

| The runtime answers | The adapter |
| --- | --- |
| `ok` (or a duplicate) | Parses the next line |
| `not_started`, `spool_unavailable`, or `emit` throws | Keeps the event and emits it again, the same event, after 1 s, doubling to 30 s; reads only within its buffers meanwhile |
| `backpressure` | Keeps the event, stops reading, and emits it again only once `resume` is called; a resume that came while the refusal was on its way counts, so it isn't left waiting |
| `too_large`, `invalid` | The event is lost: the stream ends before it (`stream_event_too_large`, `stream_event_refused`) |
| `stopped` | Fences itself, as at stop |

**Backpressure over-counts by one, and says so.** The runtime counts every refused emission in an `overflow` gap before it answers `backpressure`, and the adapter can't tell it the event was kept. So after a full spool the space sees an `overflow` gap of 1 and then, once resumed, the same event delivered anyway. The gap marks that the spool overflowed at that moment; it doesn't mean an event is missing. It doesn't cover the time the command was blocked either: whether the command's own source lost anything while it waited on its pipe (a WebSocket script that drops messages, say) is beyond what the adapter can see.

## Ends, and what the space learns of them

**A stream is a prefix.** What it delivers is every line the command printed, in order, from the first, until it ends; it never skips a line and goes on. Any line it can't deliver ends the stream before that line, and the complete lines read before the end are still emitted. That keeps the one rule that matters for honesty: **nothing after an uncounted loss is ever delivered as if coverage were continuous.** A future version could skip and count bad lines once the runtime can record them (below).

| Code | When |
| --- | --- |
| `stream_ended` | The command exited 0 |
| `stream_failed` | The command exited non-zero or by a signal |
| `stream_spawn_failed` | The shell couldn't start, such as for a missing `cwd` |
| `stream_output_closed` | stdout ended and the command hadn't exited 1 s (`drainMs`) later; the adapter ends it |
| `stream_output_unclosed` | The leader exited and something outside its group still held stdout open after `drainMs` |
| `stream_invalid_output` | A line that isn't one bounded, finite JSON object in UTF-8, or a trailing record cut short |
| `stream_line_too_large` | A line past 64 KiB |
| `stream_event_too_large` | Data past 16 KiB, or the runtime refused it `too_large` |
| `stream_event_refused` | The runtime refused an event `invalid` |
| `stream_output_overflow` | More than 1 MiB held, which only a launcher that ignores the pause can cause |
| `stream_stderr_flood` | More than 64 KiB of stderr in a minute |
| `stream_unreaped` | Its leader still hadn't exited after SIGKILL |
| `stream_cleanup_unknown` | Its group's cleanup can't be vouched for; sticky |

All have status `error`. None is followed by `ok`: a stream doesn't recover.

**Health is not durable, so an end is said again.** The runtime drops an adapter's health before the observer is installed and while no connection is reconciled, so the one report of an end could be lost and the trigger look as if it were listening. An ended stream therefore reports its last code again after 1 s, doubling to once a minute, until it is stopped. That keeps the end visible; it doesn't make it durable.

**The end is durable.** Once the stream has ended **and** everything it read before the end has been emitted, the adapter calls the runtime's `endCoverage({ at, code })`, with `at` when the end was decided (the leader's exit, the bad line, the overflow) and its code. In one commit the runtime writes a gap of its own, `interrupted` from `at`, after every event of the stream, and the generation's end record; then it stops the adapter (`stopped`, reason `ended`) and answers `ended` for that generation on every later reconcile, after restarts and in new epochs too, sending the code as health, and never runs the command again. See [triggers-runtime.md](triggers-runtime.md#lifecycle). The adapter asks once at a time: `not_started` (an end before installation) and `unavailable` (the commit failed; nothing changed) are asked again after 1 s, doubling to 30 s; `stopped` fences it; `invalid` stops asking, and only its health tells of the end. Until `recorded`, it keeps saying its code as health; after, the runtime does.

**An end while an event waits on backpressure.** The end is recorded only after the events before it, so a stream that ends while the runtime has it paused, with an event kept, closes its coverage only once it is resumed and that event and the rest are taken. Meanwhile the `overflow` gap of the refusal is durable, and the end's code is said as health, again after 1 s, doubling to once a minute: a bounded repetition, not a growing queue, and never `ok`. If it is stopped before it is resumed, by a lease or the space, its kept events are dropped and the runtime counts its coverage as broken **from when it paused it**, not from the stop: the next generation's gap starts there.

**Stop and restart.** At stop or abort, lines the command had printed and the adapter hadn't emitted (at most the buffer, the pipe and one event) are dropped, inside the gap that starts at the stop or the pause; the space should treat events near a stop as possibly incomplete. An end that couldn't be written before a restart is unknown afterwards: the space's reconcile runs that generation again, after a `coverage_unknown` gap, as it does any stream.

| Situation | Durable at the space | Only health | Lost and uncounted |
| --- | --- | --- | --- |
| Spool full | `overflow` gap (counts the kept event too) | `backpressure`, `resumed` | Nothing of the adapter's |
| Runtime can't write (`spool_unavailable`, `not_started`) | Nothing needed: the event is kept and retried | The runtime's `spool_unavailable` | Nothing |
| A bad line, a refused event, overflow, a stderr flood, an exit | `interrupted` gap from the end, the end record, `reconciled` `ended` | The end's code, until recorded | Nothing after the events before the end |
| The same, while an event waits on backpressure | The `overflow` gap; the end's gap once resumed and drained | The end's code, repeated | If stopped first: the kept events, inside a gap from the pause |
| The end can't be written | Nothing yet; asked again | The end's code, repeated | If pim-computer restarts first: the end itself, and the stream runs again after `coverage_unknown` |
| Stop, abort, lease expiry | `interrupted` gap from the stop or pause, when an observer starts again | The runtime's `stopped` | Whatever was read and not yet emitted |
| Restart of pim-computer | `coverage_unknown` gap, or `ended` for a recorded end | | Whatever wasn't spooled, and everything the command would have printed meanwhile |

A later extension could let an adapter report a counted loss and go on (`{ reason: "invalid", count: 1, at }`), so a bad line needn't end a stream; it would need a new gap reason, and isn't proposed here.

## Lifecycle

- **`start`** checks the source, keeps `emit`, `health` and the runtime's `endCoverage`, and returns; the command starts on a timer after. Emissions before the runtime has installed the observer are answered `not_started` and retried, so the first event follows installation and its coverage gap.
- **`pause`** stops reading stdout and holds any waiting event; nothing is dropped. **`resume`** reads again and emits the waiting event. Once the leader has exited, stdout is read to its end whatever the pause, within the buffer, so the pipe can close.
- **`stop`** and **abort** fence at once: no later data, emission answer, health or retry counts, every timer of reading and delivery is cancelled, everything held is dropped, and the child, if it runs, is ended as above. `stop` returns once it exits or after `graceMs + reapMs + 100` ms (4.1 s by default); the adapter refuses settings whose bound isn't below the runtime's `stopTimeoutMs` (10 s unless set). Abort comes before `stop`, so the fence never waits for it.
- **Leases** are the runtime's: a disconnected runtime stops the observer when its lease runs out, independently of the adapter.

## Privacy

Held, in pim-computer's memory only: at most 1 MiB of what the command printed and one parsed event, until each is emitted or the adapter stops. Then the runtime's spool holds emitted events as it holds any observation (up to 24 hours, on disk, see [triggers-runtime.md](triggers-runtime.md#the-spool)). stderr is never held. The adapter keeps no history, writes no log and reports codes only. What the space keeps of an event, and whether any of it may enter a chat's context, is the space's delivery policy (raw payloads are off; see [triggers.md](triggers.md)) and is not decided here.

## Tests

`test/triggers-stream.node.test.ts`, in Node, about 1.5 seconds:

- A fake clock and launcher: the source's bounds; nothing before `start` returns; lines split inside characters, CRLFs and records, each dated by its newline, keyed by invocation and place; every kind of bad line ending the stream with nothing after it, and the bounds accepted exactly; a trailing record only at the command's own end; reading paused at the high mark and a launcher that ignores it; stderr counted per minute and dropped; retries as the same event with nothing skipped; backpressure held until resume, and a resume crossing a refusal; refusals for good; each way a command ends, no restart in an hour, and the end repeated until stop; stop and abort during output and a slow emission, within their bound; no signal after the reap; sticky unknown cleanup; unreaped and reaped later; `endCoverage` asked after the last event, again after `unavailable` and `not_started`, never after `invalid`, once while held across pause, resume and stop, and its late answer dropped.
- Tiny real children through `NodeStreamLauncher`: events in order with only the allowed environment and `stream_ended`; `yes` through `head -c 200000000` held on its pipe with one event outstanding, memory within bounds, then its group, with a background `sleep`, ended at stop while a bystander lives; the leader's own cleanup with no signal sent, from the adapter or the launcher, after the reap; stderr out of everything, the console included; a leader killed from outside reported as unknown cleanup, with its leftover not signalled.
- The real runtime and spool with fake children: lines printed before installation answered `not_started` and delivered after `installed` and the coverage gap; the spool resending the same events on a new connection; a restart running the command again as a new stream with new ids after `coverage_unknown`; a full spool's `backpressure` holding the event, the `overflow` gap that counts it, and every line delivered in order after `resumed`; an end recorded after the last event, then `ended` for the same generation on this runtime and after a restart, with the command run once, and again only for a new generation; an end before installation recorded once installed, after the event printed before it; an end while an event waits on backpressure closed only after resume, and, when the lease ends it first, the next generation's gap from the pause.

The runtime's own tests of ending, in `test/triggers-runtime.node.test.ts` ("observers that end"), with fake adapters and a real spool: the gap and end record in one journal line after the events, the observer stopped and later calls `stopped`; no restart of the generation on reconcile, after the lease, in a new epoch or after a restart, and a new generation's gap from the end with the record removed; an end before installation; a failed commit changing nothing, a retry, and a restart before it running the generation again after `coverage_unknown`; one answer for repeated calls; a new epoch asked for while the end's commit is held; a stop while it is held, the end still durable after a restart; a paused observer's coverage from the pause; the end gap kept apart from an unsent coverage gap; and end records bounded, private and read strictly.

## Not done here

- Constructing `observerAdapters` with stream options in pim-computer (a launcher, a real `NodeStreamLauncher` among them), the host's real grant check, which stays as it is: the runtime asks it for the exact source before the factory is called, so a denied source never gets an adapter, and carrying `triggers.v1` over pim-computer's connection.
- The space's side of `ended` and the end gap: mapping them onto the store (`recordGap`, `setHealth`) and offering the person a new generation.
- Factoring `NodeChildLauncher` and `NodeStreamLauncher` into one launcher in `poll.ts`; this module imports the poll's leader, environment and output reader rather than editing it.
- Resumable streams with source-given ids and cursors.
- Skipping and counting a bad line instead of ending the stream.
- A standalone WebSocket or HTTP client, and file observers.
- Containing processes that leave the group, and macOS and Windows.
