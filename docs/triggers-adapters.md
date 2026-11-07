# Trigger observers on the computer

> **Not active.** This is a review-only tranche. Nothing imports [`computer/triggers-adapters/`](../computer/triggers-adapters/): pim-computer doesn't construct the triggers runtime, no service or install script registers these adapters, and no message from a space reaches them. Only `test/triggers-adapters.node.test.ts` constructs them. **Pim has no managed launcher yet**, so in production no process handle resolves and every process watch would fail to start.

The triggers runtime ([triggers-runtime.md](triggers-runtime.md)) runs the computer sources a space wants through `ObserverAdapter`s. This tranche adds two concrete ones, for the two sources that need no long-lived stream: `poll` and `process`. `stream` and `file` have none yet; `observerAdapters` refuses them, and the runtime reports `unsupported`.

| Module | What it is |
| --- | --- |
| `poll.ts` | `PollAdapter`, which runs a poll's command on its cadence; `NodeChildLauncher`, which starts that command in a process group of its own; `readPollOutput`, which reads what it printed |
| `process.ts` | `ProcessWatchAdapter`, which reports one managed process's completion; the `ManagedProcessProvider` contract it reads through |
| `managed.ts` | The durable records behind a handle (launch intent and completion receipt), `FileProcessProvider` over them and Linux's `/proc`, and `superviseManaged`, a supervisor that writes them around one job |
| `index.ts` | `observerAdapters`, the `AdapterFactory` a host would give the runtime |

Neither adapter changes the runtime or its protocol: the source shapes are `triggers.v1`'s as they are (`poll`: `command`, `cwd`, `intervalMs`, `deadlineMs`; `process`: `handle`, `expiresAt`).

## Authority

**Consent is checked before an adapter exists.** The runtime asks the host's `authorize` check before it calls the factory, and only `{ ok: true }` gets an adapter made. A denied source never reaches these modules: no adapter is constructed, no command runs and no record is read.

**What an adapter enforces is its own lifecycle and resources**: one invocation at a time, deadlines, output bounds, its own children, its own timers. It decides nothing about consent and confines nothing. A poll's command runs as the user who runs pim-computer, with that user's access to their files, network and processes. A process watch only reads. Nothing here is a sandbox, and nothing claims to be.

## Poll

**Bounds.** The space's own (`TRIGGER_DEFAULTS`): an interval from 60 seconds to a day (5 minutes is the spec's default), a deadline from 1 to 30 seconds, a command of at most 4,000 characters, and an absolute `cwd` or none. The runtime checks a source's shape and leaves its bounds to the space, so `start` checks them again and throws on any it doesn't meet; the runtime reports that as `start_failed`, and nothing runs. A test keeps these constants equal to the spec's.

**Cadence.** The first poll is due when `start` returns, plus jitter; poll *k* is due at `start + k × interval + jitter(k)`. Jitter is drawn for each slot from the injected `random`, up to a tenth of the interval (`jitterRatio`, at most half) and never more than 30 seconds. With the default ratio, slots stay at least 0.9 of an interval apart, more than the longest a poll can take (deadline, grace and reaping: 34 seconds); with a larger one, a slot that comes while a poll is still being ended is skipped. The cadence is anchored to the start, not to when polls end, and runs on the injected clock. A slot is **skipped**, not queued, when the last invocation hasn't exited, when the runtime has paused the adapter, or when an observation still waits to be taken. A timer that fires late, as after the computer slept, runs one poll and moves on to the next slot still to come, reporting `poll_skipped`: never a burst of the missed ones.

**One child, its own group.** `NodeChildLauncher` runs the command with `/bin/sh -c` (configurable) in a new process group (`detached`), stdin closed, in the source's `cwd` or the launcher's `defaultCwd`. Its environment is only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ` and `TMPDIR` of pim-computer's, so its token and anything else it holds stay out. The group is signalled **only while its leader, the launcher's own child, is unreaped**: until then the leader's process id is taken, and with it the group's, so no other process can have it. Node reaps a child and records its exit in the same step of its event loop, so `exitCode` and `signalCode` still null means unreaped. When the leader exits, whatever is left of its group is sent SIGKILL at once (its id is still reserved while any member lives), and the group is never signalled again. Nothing is ever found or signalled by name.

**Ending a child.** At the deadline, when stdout passes 64 KiB, or when stderr passes 16 KiB, the adapter sends SIGTERM to the group, SIGKILL after `graceMs` (2 s), and if the leader still hasn't exited `reapMs` (2 s) later, reports `poll_unreaped` and polls no more until it does: it never starts a second child beside one it couldn't end.

**Output.** stdout is read as UTF-8 and parsed with `JSON.parse` only, never run or interpreted otherwise. It must be one JSON object, with whitespace around it allowed and nothing else, at most 8 levels below it and 16,384 values (the runtime's own rules), and at most 16 KiB as JSON (what the store takes). That object is the observation's `data`, with `occurredAt` the moment the poll's output was complete, no checkpoint, and a key of the adapter's own (`poll:<nonce>:<slot>`) so a retry is the same event. stderr is counted and dropped as it arrives: it is never kept, logged, reported or sent. A poll that fails reports one code and emits nothing:

| Code | Status | When |
| --- | --- | --- |
| `poll_timeout` | degraded | Past `deadlineMs` |
| `poll_output_too_large` | degraded | stdout over 64 KiB, stderr over 16 KiB, data over 16 KiB, or the runtime refused it `too_large` |
| `poll_invalid_output` | degraded | Not UTF-8, not exactly one JSON object, too deep or too many values |
| `poll_failed` | degraded | A nonzero exit or a signal |
| `poll_spawn_failed` | error | The shell couldn't start, such as for a missing `cwd` |
| `poll_unreaped` | error | Still not exited after SIGKILL |
| `poll_skipped` | degraded | A late wake skipped slots |
| `poll_ok` | ok | The first observation taken after any of these |

**What happens to an emission.** The runtime answers each `emit`:

- `ok` (or a duplicate): done.
- `not_started` or `spool_unavailable`: nothing of it was kept and the runtime counted no gap, so the adapter **keeps it**, the one observation it holds, and emits it again, with the same key and `occurredAt`, after 1 second, doubling to 30. No newer sample is taken meanwhile: slots are skipped until it is taken or refused for good.
- `backpressure`: the runtime has counted it in an `overflow` gap and paused the adapter. It is dropped, nothing is polled while paused, and after `resume` the next slot still to come samples afresh.
- `too_large`, `invalid`: dropped with a code (the runtime counts `too_large` in a gap).
- `stopped`: the adapter fences itself.

So nothing is dropped without a gap and nothing moves a checkpoint: a poll carries none.

**Stop and abort.** The runtime's `AbortSignal` fences the adapter at once, before `stop` is called: no further poll, no emit, the retained observation dropped (the runtime's next start records the break in coverage), and its own child, if one runs, ended as above. `stop` does the same and returns once that child has exited, or after grace, reaping and 100 ms more, well inside the runtime's 10-second `stopTimeoutMs`.

**What it doesn't contain.** A command that leaves its process group (`setsid`, a double fork into a new session) leaves this adapter's reach too; without cgroups or another OS mechanism, nothing here can follow it. The kill of a group's leftovers when its leader exits relies on the group's id being reserved while any member lives; if every member is gone the signal finds nothing (`ESRCH`), and reuse of that id would need the process ids to wrap around in the instant between the leader's exit and that signal.

## Process

**What a handle is.** A `process` source names a handle: a random UUID, lower case, that a managed launcher gave a job when it started it. A handle maps to the **launch intent** its supervisor recorded, which pins that supervisor by boot id, process id and start time (Linux's `/proc/<pid>/stat` field 22). A name, a process id alone, or anything that isn't such a UUID is refused at `start`. The watch observes an operation that already exists: nothing here can start a job, and a watch of a handle never launched fails to start (`process_unknown_handle`).

**The provider.** `ManagedProcessProvider` has two methods, both reads: `read(handle)`, the intent and the receipt if any, and `liveness(identity)`, whether that exact process runs now (`running`, or `exited`, `pid_reused`, `other_boot`, all of which mean gone). It has no way to start, signal or stop anything, so neither has the adapter.

**Records.** `FileProcessProvider` reads `<stateDir>/<handle>/intent.json` and `receipt.json`. The state folder must be absolute, a real folder, the user's own and closed to everyone else (`0700`); each record a regular file, not a link (`O_NOFOLLOW`), the user's own, writable only by them, at most 4 KiB, read strictly (exact fields, a known version, a UUID boot id, a numeric start time, an exit code 0 to 255 or a signal name, never both). A receipt holds the handle, the supervisor's identity, `exitCode` or `signal`, and `endedAt`: no output, no command, no arguments. Both are written once: a temporary file, synced, linked into place (a link fails if the record exists, so none is ever replaced), and the folder synced. An intent's folder is made new, so a handle can't be launched twice, and a receipt is refused unless its supervisor is the intent's.

**The supervisor.** `superviseManaged` is the smallest supervisor that keeps that contract: it records the intent with its own identity, runs the job directly (no shell, no input, output dropped), waits, and records the receipt. It forwards no signals and stops nothing. If it dies first, there is no receipt. It is what the tests run around tiny Node jobs; **it is not a launcher**. Which jobs may be started, after what approval, detached how from pim-computer so a job outlives it, with the state folder where, and when old records go, are not decided here, and nothing in pim-computer calls it.

**A watch.** `start` checks the handle, that `expiresAt` is still to come and at most 7 days away, and reads the intent, pinning it; any failure throws, which the runtime reports as `start_failed`. Then, once `start` has returned, every `checkMs` (5 s):

1. Read the records. A receipt is checked against the pinned intent: the same handle, boot, process id and start time, or it is refused (`process_identity_mismatch`) and the watch ends with nothing emitted. An intent that changed, or vanished (`process_record_lost`), ends it the same way.
2. With no receipt, ask whether the pinned supervisor still runs. If it does, check again later.
3. If it is gone (exited, its process id now another process's, or another boot), read the records again, since a receipt written just before it exited may have landed since. Still none: the outcome is **unknown**. It is reported as such, `exitCode` and `signal` null, never as a guessed exit code.

The one observation is `data: { handle, outcome, exitCode, signal }` with `outcome` `exited`, `signalled` or `unknown`; `occurredAt` is the receipt's `endedAt`, or when the supervisor was found gone. Its key is the handle and the supervisor's identity, `process:<handle>:<bootId>:<pid>:<startTime>`, so **one launched instance is one event**: read again by this watch, by one started after a restart, or as `unknown` and later from a receipt, it is the same `eventId`, and the space takes it once (`duplicate` otherwise).

**After a restart** the runtime starts a new watch only on the space's reconcile; that watch resolves the handle again and reads the durable receipt, so a completion while pim-computer was down is still reported, and a supervisor that died meanwhile is reported unknown.

**Delivery.** A completion is an event and is never given up for room: on `backpressure` it waits for `resume` and is emitted again, the same event; on `not_started` or `spool_unavailable` it is emitted again after 1 second, doubling to 30. Records that can't be read report `process_read_failed` once and are read again at the next check (`process_watching` when they can be).

**Expiry and stopping end the watch, never the process.** At `expiresAt` the records are read once more; a receipt that ended by then is reported, anything else ends the watch with `process_watch_expired` and nothing emitted. Stop, abort, a lease running out, the trigger's deletion and expiry all only cancel the adapter's timers: the job and its supervisor run on, untouched.

**Linux only.** Start times and the boot id come from `/proc`. Elsewhere `LinuxProcessProbe` throws, so a watch fails to start rather than trusting a process id alone.

## Health before installation

The runtime drops an adapter's health until the observer is installed, by design. So a reason an adapter can't start (a bound, an unknown handle, an expired watch) is thrown from `start` with a code (`PollConfigError`, `ProcessWatchError`), and the space hears only `start_failed`. Everything both adapters do runs once `start` has returned, on timers; an emission that comes before installation is answered `not_started`, and kept and tried again.

## Tests

`test/triggers-adapters.node.test.ts`, in Node, about 4 seconds:

- A fake clock, launcher and provider for timing (anchored cadence, jitter, late wakes), one child at a time, deadlines and the SIGTERM, SIGKILL, unreaped sequence, output bounds, retained and refused emissions, pause and resume, stop and abort races, start's refusals, receipts against intents, unknown outcomes, expiry and read failures.
- Tiny real children through `NodeChildLauncher`: the environment kept to its list, leftovers in the group killed, a group killed at the deadline and on stop while a bystander process lives on, stderr kept out of reports and the console.
- Real records in a temporary state folder: `superviseManaged` around Node jobs that exit 0, exit 2 and are signalled, a supervisor killed before its receipt (unknown), a stopped watch leaving its job running and a later watch taking its receipt, reused process ids and another boot, records written once, and an unsafe state folder refused.
- The real runtime with these adapters: a denied grant makes no adapter, `stream` and `file` are `unsupported`, each observer is `installed` with its coverage gap before its first observation, and a completion read again after a restart is the same event.

## Not done here

- Registering these adapters in pim-computer, the host's real grant check, and carrying `triggers.v1` over pim-computer's connection.
- A production managed launcher: the tool that starts jobs under handles, its approvals, detaching jobs from pim-computer, where the state folder lives, and retiring old records (they hold identities and exit statuses only).
- `stream` and `file` observers.
- Process watches on macOS and Windows.
- Following a poll's command out of its process group.
