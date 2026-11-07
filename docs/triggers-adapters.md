# Trigger observers on the computer

> **Behind a gate, and not active.** Only pim-computer's triggers host ([`computer/triggers-host.ts`](../computer/triggers-host.ts)) constructs these adapters, and pim-computer loads it only when `PIM_COMPUTER_TRIGGERS` is `internal`, which nothing sets; no service or install script registers them, and nothing in Pim sends a reconcile yet ([triggers-runtime.md](triggers-runtime.md#over-pim-computers-connection)). **Pim has no managed launcher yet**, so no process handle resolves and every process watch fails to start.

The triggers runtime ([triggers-runtime.md](triggers-runtime.md)) runs the computer sources a space wants through `ObserverAdapter`s. This tranche adds two concrete ones, for the two sources that need no long-lived stream: `poll` and `process`. `stream` has its own ([triggers-stream.md](triggers-stream.md)), which `observerAdapters` offers when given stream options, the same as `poll` and `process`. `file` has none: `observerAdapters` refuses it, and so a `stream` source when no stream options are given, and the runtime reports `unsupported`.

| Module | What it is |
| --- | --- |
| `poll.ts` | `PollAdapter`, which runs a poll's command on its cadence; `NodeChildLauncher`, which starts that command in a process group of its own; `readPollOutput`, which reads what it printed |
| `process.ts` | `ProcessWatchAdapter`, which reports one managed process's completion; the `ManagedProcessProvider` contract it reads through |
| `managed.ts` | The durable records behind a handle (launch intent and completion receipt), `FileProcessProvider` over them and Linux's `/proc`, and `superviseManaged`, a supervisor that writes them around one job |
| `index.ts` | `observerAdapters`, the `AdapterFactory` a host would give the runtime; it offers `poll`, `process` and `stream` each only when its options are given |

Neither adapter changes the runtime or its protocol: the source shapes are `triggers.v1`'s as they are (`poll`: `command`, `cwd`, `intervalMs`, `deadlineMs`; `process`: `handle`, `expiresAt`).

## Authority

**Consent is checked before an adapter exists.** The runtime asks the host's `authorize` check before it calls the factory, and only `{ ok: true }` gets an adapter made. A denied source never reaches these modules: no adapter is constructed, no command runs and no record is read.

**What an adapter enforces is its own lifecycle and resources**: one invocation at a time, deadlines, output bounds, its own children, its own timers. It decides nothing about consent and confines nothing. A poll's command runs as the user who runs pim-computer, with that user's access to their files, network and processes. A process watch only reads. Nothing here is a sandbox, and nothing claims to be.

## Poll

**Bounds.** The space's own (`TRIGGER_DEFAULTS`): an interval from 60 seconds to a day (5 minutes is the spec's default), a deadline from 1 to 30 seconds, a command of at most 4,000 characters, and an absolute `cwd` or none. The runtime checks a source's shape and leaves its bounds to the space, so `start` checks them again and throws on any it doesn't meet; the runtime reports that as `start_failed`, and nothing runs. A test keeps these constants equal to the spec's.

**Cadence.** The first poll is due when `start` returns, plus jitter; poll *k* is due at `start + k × interval + jitter(k)`. Jitter is drawn for each slot from the injected `random`, up to a tenth of the interval (`jitterRatio`, at most half) and never more than 30 seconds. With the default ratio, slots stay at least 0.9 of an interval apart, more than the longest a poll can take (deadline, grace and reaping: 34 seconds); with a larger one, a slot that comes while a poll is still being ended is skipped. The cadence is anchored to the start, not to when polls end, and runs on the injected clock. A slot is **skipped**, not queued, when the last invocation hasn't exited, when the runtime has paused the adapter, or when an observation still waits to be taken. A timer that fires late, as after the computer slept, runs one poll and moves on to the next slot still to come, reporting `poll_skipped`: never a burst of the missed ones.

**One child, its own group.** `NodeChildLauncher` starts a small leader, `/bin/sh` running `POLL_LEADER`, in a new process group (`detached`), stdin closed, in the source's `cwd` or the launcher's `defaultCwd`. The leader runs the command with `/bin/sh -c` (the shell is configurable) as its child, so in its group. Their environment is only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ` and `TMPDIR` of pim-computer's, so its token and anything else it holds stay out. Nothing is ever found or signalled by name, and **the group is signalled only while it is provably this launcher's**, in two ways:

- **By the leader, before it exits.** When the command ends, the leader writes its exit status on fd 3, and only then sends `kill -9 0` to its whole group, itself included. While the leader lives, the group's id is its own process id, so that signal can reach no other group. It catches SIGTERM, SIGINT and SIGHUP only to outlive the command and clean up after it; a caught signal is reset to its default in the command, so the command still gets them. Whatever a poll leaves running in its group is killed this way, whether the poll succeeded or not.
- **By the launcher, only while the leader is unreaped.** Until a child is reaped its process id stays taken, and with it the group's. Node reaps a child and records its exit in the same step of its event loop, so `exitCode` and `signalCode` still null means unreaped. **After that the launcher never signals the group again**, whatever may be left in it.

**What the launcher can vouch for.** A status on fd 3 proves how the command ended; it is written before the leader's `kill -9 0`, so it is not itself proof that the group was killed. The launcher reports `cleaned: true` only when the leader, after its status, ended by SIGKILL, as its own `kill -9 0` ends it, or when its own SIGKILL reached the group while the leader was unreaped. That is evidence, not a receipt: an outside SIGKILL in the instant between the status and the leader's own kill looks the same. Any other end of the leader (killed from outside before its status, or ended otherwise after it) is `cleaned: false`: what is left of its group may still run and can't be signalled safely.

**Unknown cleanup stops the adapter for good.** On `cleaned: false` the adapter reports `poll_cleanup_unknown` (error) and fences itself: its cadence and retries are cancelled, it starts no further child, emits nothing, drops anything it held, ignores pause and resume, and reports nothing after, so that code stays the last word. It never signals the reaped group. `stop` then returns at once and claims nothing about the leftovers. Only a new adapter, made by the runtime for a new reconcile or a new generation, polls again; nothing resumes on its own.

**Ending a child.** At the deadline, when stdout passes 64 KiB, or when stderr passes 16 KiB, the adapter sends SIGTERM to the group. The command gets it and, once it ends, the leader cleans up as above. If the leader hasn't exited after `graceMs` (2 s), the adapter sends SIGKILL to the group, leader included. If it still hasn't exited `reapMs` (2 s) later, the adapter reports `poll_unreaped` and polls no more until it does: it never starts a second child beside one it couldn't end.

**Output.** stdout is read as UTF-8 and parsed with `JSON.parse` only, never run or interpreted otherwise. It must be one JSON object, with whitespace around it allowed and nothing else, with finite numbers only (an exponent too large is refused, never rounded to null), at most 8 levels below it and 16,384 values (the runtime's own rules), and at most 16 KiB as JSON (what the store takes). That object is the observation's `data`, with `occurredAt` the moment the poll's output was complete, no checkpoint, and a key of the adapter's own (`poll:<nonce>:<slot>`) so a retry is the same event. stderr is counted and dropped as it arrives: it is never kept, logged, reported or sent. A poll that fails reports one code and emits nothing:

| Code | Status | When |
| --- | --- | --- |
| `poll_timeout` | degraded | Past `deadlineMs` |
| `poll_output_too_large` | degraded | stdout over 64 KiB, stderr over 16 KiB, data over 16 KiB, or the runtime refused it `too_large` |
| `poll_invalid_output` | degraded | Not UTF-8, not exactly one JSON object, a number JSON can't carry (`1e999` parses as Infinity), too deep or too many values |
| `poll_failed` | degraded | A nonzero exit or a signal |
| `poll_spawn_failed` | error | The shell couldn't start, such as for a missing `cwd` |
| `poll_unreaped` | error | Still not exited after SIGKILL |
| `poll_cleanup_unknown` | error | Cleanup of the last child's group can't be vouched for; the adapter polls no more |
| `poll_skipped` | degraded | A late wake skipped slots |
| `poll_ok` | ok | The first observation taken after any of these |

**What happens to an emission.** The runtime answers each `emit`:

- `ok` (or a duplicate): done.
- `not_started` or `spool_unavailable`: nothing of it was kept and the runtime counted no gap, so the adapter **keeps it**, the one observation it holds, and emits it again, with the same key and `occurredAt`, after 1 second, doubling to 30. No newer sample is taken meanwhile: slots are skipped until it is taken or refused for good.
- `backpressure`: the runtime has counted it in an `overflow` gap and paused the adapter. It is dropped, nothing is polled while paused, and after `resume` the next slot still to come samples afresh.
- `too_large`, `invalid`: dropped with a code (the runtime counts `too_large` in a gap).
- `stopped`: the adapter fences itself.

So nothing is dropped without a gap and nothing moves a checkpoint: a poll carries none.

**Stop and abort.** The runtime's `AbortSignal` fences the adapter at once, before `stop` is called: no further poll, no emit, the retained observation dropped (the runtime's next start records the break in coverage), and its own child, if one runs, ended as above. `stop` does the same and returns once that child has exited, or after `graceMs + reapMs + 100` ms at the latest (4.1 s by default). The adapter is given the runtime's `stopTimeoutMs` (10 s unless set) and refuses settings whose bound isn't below it, so a stop never outlasts what the runtime waits for.

**What it doesn't contain.** A command that leaves its process group (`setsid`, a double fork into a new session) leaves this adapter's reach too; without cgroups or another OS mechanism, nothing here can follow it.

## Process

**What a handle is.** A `process` source names a handle: a random UUID, lower case, that a managed launcher gave a job when it started it. A handle maps to the **launch intent** its supervisor recorded, which pins that supervisor by boot id, process id and start time (Linux's `/proc/<pid>/stat` field 22). A name, a process id alone, or anything that isn't such a UUID is refused at `start`. The watch observes an operation that already exists: nothing here can start a job, and a watch of a handle never launched fails to start (`process_unknown_handle`).

**The provider.** `ManagedProcessProvider` has two methods, both reads: `read(handle)`, the intent and the receipt if any, and `liveness(identity)`, whether that exact process runs now (`running`, or `exited`, `pid_reused`, `other_boot`, all of which mean gone). It has no way to start, signal or stop anything, so neither has the adapter.

**Records.** `FileProcessProvider` reads `<stateDir>/<handle>/intent.json` and `receipt.json`. The state folder and each handle's folder must be absolute, real folders (not links), the user's own and closed to everyone else (no group or other bits, as `0700`); each record a regular file, not a link (`O_NOFOLLOW`) or a FIFO, the user's own and closed to everyone else (as `0600`), at most 4 KiB, refused otherwise rather than narrowed, and read strictly (exact fields, a known version, a UUID boot id, a numeric start time, an exit code 0 to 255 or a signal name, never both). A receipt holds the handle, the supervisor's identity, `exitCode` or `signal`, and `endedAt`: no output, no command, no arguments. Both are written once: a temporary file, synced, linked into place (a link fails if the record exists, so none is ever replaced), and the folder synced. An intent's folder is made new, so a handle can't be launched twice, and a receipt is refused unless its supervisor is the intent's.

**The supervisor.** `superviseManaged` is the smallest supervisor that keeps that contract: it records the intent with its own identity, runs the job directly (no shell, no input, output dropped), waits, and records the receipt. It forwards no signals and stops nothing. If it dies first, there is no receipt. It is what the tests run around tiny Node jobs; **it is not a launcher**. Which jobs may be started, after what approval, detached how from pim-computer so a job outlives it, with the state folder where, and when old records go, are not decided here, and nothing in pim-computer calls it.

**A watch.** `start` checks the handle, that `expiresAt` is still to come and at most 7 days away, and reads the intent, pinning it; any failure throws, which the runtime reports as `start_failed`. Then, once `start` has returned, every `checkMs` (5 s):

1. Read the records. **Every intent read, with a receipt or without, is checked against the pinned one**: the same handle, launch time, boot, process id and start time. One that changed ends the watch (`process_identity_mismatch`), and so does one that vanished (`process_record_lost`), with nothing emitted. A receipt is checked the same way against the pinned intent.
2. With no receipt, ask whether the pinned supervisor still runs. If it does, check again later.
3. If it is gone (exited, its process id now another process's, or another boot), read the records again, since a receipt written just before it exited may have landed since. Still none: the outcome is **unknown**. It is reported as such, `exitCode` and `signal` null, never as a guessed exit code.

**Expiry is asked again after every answer from the provider.** A check that finds the watch's time is up after any read or liveness check makes **one final read**, unless the read it just made began at or after expiry, in which case that was the final read. In that read only a receipt that matches the pinned intent and ended by `expiresAt` completes the watch; anything else, a supervisor found gone included, ends it with `process_watch_expired`. An unknown outcome is only ever inferred before expiry. Each answer from the provider is waited for at most `ioTimeoutMs` (5 s), and only one question is outstanding at a time: while a read that was given up on still hasn't answered, nothing more is asked, and a check counts as failed (`process_read_failed`). So a provider that hangs can't keep a watch past its expiry, or pile up reads. Stop and abort while a question is outstanding make its answer count for nothing.

The one observation is `data: { handle, outcome, exitCode, signal }` with `outcome` `exited`, `signalled` or `unknown`; `occurredAt` is the receipt's `endedAt`, or when the supervisor was found gone. Its key is the handle and the supervisor's identity, `process:<handle>:<bootId>:<pid>:<startTime>`, so **one launched instance is one event**: read again by this watch, by one started after a restart, or as `unknown` and later from a receipt, it is the same `eventId`, and the space takes it once (`duplicate` otherwise).

**After a restart** the runtime starts a new watch only on the space's reconcile; that watch resolves the handle again and reads the durable receipt, so a completion while pim-computer was down is still reported, and a supervisor that died meanwhile is reported unknown.

**Delivery.** A completion is an event and is never given up for room: on `backpressure` it waits for `resume` and is emitted again, the same event; on `not_started` or `spool_unavailable` it is emitted again after 1 second, doubling to 30. Records that can't be read report `process_read_failed` once and are read again at the next check (`process_watching` when they can be).

**Expiry and stopping end the watch, never the process.** At `expiresAt` the records are read once more; a receipt that ended by then is reported, anything else ends the watch with `process_watch_expired` and nothing emitted. Stop, abort, a lease running out, the trigger's deletion and expiry all only cancel the adapter's timers: the job and its supervisor run on, untouched.

**Linux only.** Start times and the boot id come from `/proc`. Elsewhere `LinuxProcessProbe` throws, so a watch fails to start rather than trusting a process id alone.

## Health before installation

The runtime drops an adapter's health until the observer is installed, by design. So a reason an adapter can't start (a bound, an unknown handle, an expired watch) is thrown from `start` with a code (`PollConfigError`, `ProcessWatchError`), and the space hears only `start_failed`. Everything both adapters do runs once `start` has returned, on timers; an emission that comes before installation is answered `not_started`, and kept and tried again.

## Tests

`test/triggers-adapters.node.test.ts`, in Node, about 5 seconds:

- A fake clock, launcher and provider for timing (anchored cadence, jitter, late wakes), one child at a time, deadlines and the SIGTERM, SIGKILL, unreaped sequence, output bounds, retained and refused emissions, pause and resume, stop and abort races, `stop`'s bound against the runtime's, start's refusals, receipts and changed intents against the pinned intent, unknown outcomes, slow reads and liveness checks across expiry, a provider that never answers, answers after stop or abort, and read failures.
- Tiny real children through `NodeChildLauncher`, with its signals watched: exit statuses through the leader, leftovers killed by the leader's own `kill -9 0` with no signal from the launcher, nothing sent once a leader is reaped, a leader killed from outside reported as `cleaned: false` with its leftover not signalled, and an adapter that then polls, emits and reports nothing more through many intervals, pause and resume, and stop, the environment kept to its list, a group killed at the deadline and on stop while a bystander process lives on, stderr kept out of reports and the console.
- Real records in a temporary state folder: `superviseManaged` around Node jobs that exit 0, exit 2 and are signalled, a supervisor killed before its receipt (unknown), a stopped watch leaving its job running and a later watch taking its receipt, reused process ids and another boot, records written once, and folders and records that are open to others, links, a FIFO or too large refused.
- The real runtime with these adapters: a denied grant makes no adapter, `file`, and a `stream` with no stream options, are `unsupported`, each observer is `installed` with its coverage gap before its first observation, and a completion read again after a restart is the same event.

## Not done here

- The space's side of `triggers.v1` (pim-computer's side, with the host's grant check, is behind a gate: [triggers-runtime.md](triggers-runtime.md#over-pim-computers-connection)).
- A production managed launcher: the tool that starts jobs under handles, its approvals, detaching jobs from pim-computer, where the state folder lives, and retiring old records (they hold identities and exit statuses only).
- A `file` observer.
- Process watches on macOS and Windows.
- Following a poll's command out of its process group.
