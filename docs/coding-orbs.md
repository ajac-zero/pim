# Agent-hosted coding threads (orbs)

A coding thread's agent runs somewhere. Until now there has been one kind of provider for that: a **workspace** — a sandbox machine Pim makes (the sandbox manager's Compose pool, or Cloudflare Containers) and execs into, where the harness runs as a local process. An **agent-hosted** thread is the second kind: there is no machine Pim can exec into at all. The agent runs in the vendor's own cloud — an Amp **Orb** — and Pim only drives it through a client that speaks to that cloud.

The two kinds sit side by side in a thread's record: `providerKind` says which one runs it, and an agent-hosted thread also keeps the orb it runs on, the agent's own thread id and the page where the person can watch it (`src/coding/orb/types.ts`). Nothing about workspaces changes: their providers, their registry and their tests are as they were, and old thread records read as the workspace threads they are.

## The interface

`OrbClient` (`src/coding/orb/types.ts`) is the whole of what Pim can do with an agent-hosted thread. It is written so that nothing in it depends on one vendor's API: the client is the only seam, and a later slice adds a real Amp client behind it.

- `start({project, prompt, mode, title, idempotencyKey})` starts a thread and returns its id and url. It is **idempotent on the idempotency key**: the same key again is the thread the first call started, so a retry — after a lost response, a restart, anything — never starts a second orb and never bills for one.
- `steer(threadId, message)` gives a running thread another message. It **queues**: the agent takes the message when it is ready, on a turn boundary. It never interrupts the run in progress.
- `stop(threadId)` ends a thread: it is **archived** on the agent's site, so it leaves the person's list there, and its run is cancelled. Stopping a stopped thread does nothing.
- `state(threadId)` says what the thread is doing — `working`, `idle`, `awaiting_approval`, `error`, or `unknown` when the client can't tell — and when its agent last did anything.
- `messages(threadId, {after})` reads the thread's transcript, oldest first, a page at a time: each call asks for what follows the message the caller ends at.
- `usage(threadId)` says what the thread has cost in dollars, or **null when the client can't say**. Null means unavailable, not free.
- `capabilities()` says which of `steer`, `stop` and `usage` the client can do; a call on one it can't throws `OrbUnsupportedError`.

Every method throws a subclass of `OrbError` — `OrbUnreachableError` (the agent's cloud can't be reached just now, nothing was changed), `OrbUnsupportedError` (the client's `capabilities` say it can't), `OrbLostError` (the thread no longer exists there) — never a bare string, so a caller tells failures apart by type. There is no workspace behind the interface: no files, no commands, no resource limits Pim can set, no egress Pim can allow or refuse.

The conformance suite in `src/coding/orb/conformance.ts` is what a client must pass, in the style of the workspace suite: idempotent start, steering that queues without interrupting, idempotent stop, state as it moves, usage that answers null when it can't say, capability flags honoured, a lost orb reported as a typed error, and transcript paging. `FakeOrbClient` (`src/coding/orb/fake.ts`), an in-memory client with a deterministic clock and scriptable failures, is the first to pass it; `test/coding-orb-fake.test.ts` runs the suite against it.

## What is honest about it

- **Costs are the agent's word.** The client reports what the agent's cloud says it spent; the thread can't measure the run itself, as it can in a workspace it owns. A client that reports no cost answers `null`, and a budget can't be held to that.
- **Tests are the agent's word too, or n/a.** A workspace thread runs the repository's own tests in its sandbox and reads their exit codes. An agent-hosted thread reports what its agent says it did; Pim has no process table, no files and no terminal of its own there. What Pim can still check is the diff: the thread's commits and the branch it pushes, as with any harness.
- **Steering queues; it does not interrupt.** A workspace thread can stop a CLI's process mid-turn. Here the run belongs to the agent's cloud: a steered message waits for the agent to take it, and there is no way to cut a turn short except `stop`, which ends the whole thread.
- **`stop` archives.** Archiving is what takes the thread off the person's list on the agent's site; it is best-effort there, as it is for the Amp CLI harness's own threads. Cancelling the run is the part Pim asks for; whether the agent's cloud finished writing anything down first is its word again.
- **The repository is outside Pim's sandbox policy.** An agent-hosted clone reaches the network as the vendor's cloud allows, not as a workspace's egress allowlist allows, and the agent's own credentials and settings live there. What a workspace thread keeps out of a repository (`docs/coding-amp.md`'s untrusted-repository table) is out of Pim's reach here.

## What is not there yet

This slice adds only the kind, the interface and the fake client. There is no real Amp client (no network call anywhere in this code), no way to start a thread as agent-hosted from the API or the UI, no pool placement or scheduler slot for orbs, and no provider registry for them: a thread record *can* say `providerKind: "agent-hosted"` and its orb, and nothing yet makes one say so. Those come in later slices. There is no feature flag or opt-in to add: this is additive code, on by default and inert until a later slice wires it.
