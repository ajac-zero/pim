/**
 * pim-computer's host for the triggers runtime (./triggers-runtime.ts): it
 * builds the runtime with its spool in pim-computer's private folder, the
 * `poll`, `process` and `stream` observers (./triggers-adapters/), and the
 * grant check, and carries `triggers.v1` frames over pim-computer's own
 * connection to the space, the one its token opened.
 *
 * pim-computer loads this module as it starts (`loadTriggers` there): from
 * beside it, or, on an installed computer, which the Pim's install and
 * update give pim-computer.ts alone, from the Pim's newest copy, which it
 * gets then. Without it, nothing of triggers is made or listened for. The
 * contract with the space is in docs/triggers-runtime.md, "Over
 * pim-computer's connection".
 *
 * Nothing here widens what the computer may do. A source runs only after the
 * space asks for it in a reconcile on this connection and its grant names
 * exactly that source, for exactly this computer (`exactSourceGrant`). Its
 * command runs as the user who runs pim-computer, as `shell` calls do; the
 * grant is consent, not a sandbox.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { observerAdapters } from "./triggers-adapters/index.ts";
import { FileProcessProvider } from "./triggers-adapters/managed.ts";
import { type ChildLauncher, NodeChildLauncher } from "./triggers-adapters/poll.ts";
import { NodeStreamLauncher, type StreamLauncher } from "./triggers-adapters/stream.ts";
import { type AuthorizationCheck, type Binding, DEFAULT_LIMITS, ObservationSpool, PROTOCOL, type RuntimeClock, TriggersRuntime, sourceConfigHash } from "./triggers-runtime.ts";

/**
 * How every triggers message on pim-computer's connection begins, both ways:
 * the frame follows as it is, then one `}`. It is a JSON object whose `type`
 * no older Pim or pim-computer acts on, so either end without triggers
 * ignores it, and the frame inside is never escaped, so its bound holds.
 */
export const TRIGGERS_ENVELOPE = '{"type":"triggers","frame":';
/** What the envelope adds to a frame's bytes. */
export const ENVELOPE_BYTES = TRIGGERS_ENVELOPE.length + 1;
/** The most the connection may hold unsent before the runtime is told to wait (`blockedRetryMs`) rather than given more. */
export const MAX_BUFFERED_BYTES = 1_048_576;

/** The source kinds that have an observer here; a grant for any other kind is refused. */
const RUNNABLE = new Set(["poll", "stream", "process"]);

/** pim-computer's connection, as much of a WebSocket as the host uses. */
export type TriggersSocket = { readonly readyState: number; readonly bufferedAmount?: number; send(data: string): void };

export type TriggersHostOptions = {
	/** The token pim-computer connects with; the binding is made from it, and it is never sent or stored. */
	readonly token: string;
	/** pim-computer's own folder (`~/.pim-computer`), where the spool is kept, in `triggers/`. */
	readonly stateDir: string;
	/** Where a poll or stream whose source names no `cwd` runs: the computer's root. */
	readonly root: string;
	readonly log: (line: string) => void;
	/** Tests give their own clock and launchers. */
	readonly clock?: RuntimeClock;
	readonly poll?: ChildLauncher;
	readonly stream?: StreamLauncher;
};

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The one owner this computer's runtime serves, from its token
 * (`pimc_<owner>_<secret>`, as `computerTokenOwner` in src/computer.ts reads
 * it): the space is the owner, and the runtime's id a digest of the token's
 * digest, which the space keeps, so the space can work it out and a new
 * token is a new runtime, with a spool of its own. Null for a token of
 * another form.
 */
export function triggersBinding(token: string): Binding | null {
	const owner = /^pimc_(o_[0-9a-z]{26})_[\w-]+$/.exec(token)?.[1];
	if (!owner) return null;
	return { space: owner, runtimeId: `rt_${sha256(`${PROTOCOL}/runtime\n${sha256(token)}`).slice(0, 32)}` };
}

/**
 * The scope a grant consents to, as the space must compute it for `scopeHash`:
 * SHA-256, in hex, of `triggers.v1/grant`, a newline, and the JSON of these
 * six strings with their keys sorted. So a grant names one source's exact
 * configuration of one trigger, on one computer, under one approval.
 */
export function grantScopeHash(scope: { readonly space: string; readonly runtimeId: string; readonly triggerId: string; readonly sourceId: string; readonly configHash: string; readonly grantRef: string }): string {
	const sorted = { configHash: scope.configHash, grantRef: scope.grantRef, runtimeId: scope.runtimeId, sourceId: scope.sourceId, space: scope.space, triggerId: scope.triggerId };
	return sha256(`${PROTOCOL}/grant\n${JSON.stringify(sorted)}`);
}

/**
 * The host's grant check: a `poll`, `stream` or `process` source runs only
 * when its grant's `scopeHash` is `grantScopeHash` of this computer's
 * binding, the trigger, its source identity, the digest of the source as
 * given and the grant's reference. Any other kind, binding or digest is
 * refused. The runtime asks it before every start and on every reconcile.
 */
export function exactSourceGrant(binding: Binding): AuthorizationCheck {
	const deny = (reason: string) => ({ ok: false as const, reason });
	return (request) => {
		if (!RUNNABLE.has(request.source.kind)) return deny("kind");
		if (request.binding.space !== binding.space || request.binding.runtimeId !== binding.runtimeId) return deny("binding");
		const configHash = sourceConfigHash(request.source);
		if (configHash !== request.configHash) return deny("config_hash");
		const expected = grantScopeHash({ space: binding.space, runtimeId: binding.runtimeId, triggerId: request.triggerId, sourceId: request.sourceId, configHash, grantRef: request.grant.grantRef });
		return request.grant.scopeHash === expected ? { ok: true } : deny("scope");
	};
}

/**
 * The children the launchers started and haven't reported ended. `killAll`
 * sends each SIGKILL through its own `signal`, which reaches its process
 * group only while its leader is unreaped, so only while the group is
 * provably the launcher's: it never finds or signals anything else. It is
 * synchronous, for pim-computer's `exit`.
 */
class OwnedChildren {
	readonly #children = new Set<{ signal(name: "SIGKILL"): boolean }>();

	get size(): number {
		return this.#children.size;
	}

	poll(inner: ChildLauncher): ChildLauncher {
		return {
			launch: (request, events) =>
				this.#track((ended) =>
					inner.launch(request, {
						stdout: (chunk) => events.stdout(chunk),
						stderr: (chunk) => events.stderr(chunk),
						exit: (result) => {
							ended();
							events.exit(result);
						},
					}),
				),
		};
	}

	stream(inner: StreamLauncher): StreamLauncher {
		return {
			launch: (request, events) =>
				this.#track((ended) =>
					inner.launch(request, {
						stdout: (chunk) => events.stdout(chunk),
						stdoutEnd: () => events.stdoutEnd(),
						stderr: (chunk) => events.stderr(chunk),
						exit: (result) => {
							ended();
							events.exit(result);
						},
					}),
				),
		};
	}

	killAll(): void {
		for (const child of this.#children) child.signal("SIGKILL");
	}

	#track<T extends { signal(name: "SIGKILL"): boolean }>(launch: (ended: () => void) => T): T {
		let done = false;
		let child: T | undefined;
		child = launch(() => {
			done = true;
			if (child) this.#children.delete(child);
		});
		if (!done) this.#children.add(child);
		return child;
	}
}

/** Makes a folder only this user may use, or checks the one there is: not a link, the user's own, its mode narrowed to 0700. */
async function privateFolder(folder: string): Promise<void> {
	await fs.mkdir(folder, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(folder);
	if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("unsafe_path");
	if ((stat.mode & 0o077) !== 0) await fs.chmod(folder, 0o700);
}

/**
 * The runtime with its spool, observers and grant check, made for one token,
 * or null for a token it can't bind to. The spool is in
 * `<stateDir>/triggers/<runtimeId>`, and process watches read records from
 * `<stateDir>/triggers/managed`, which nothing writes yet; both are made
 * private. Nothing runs until the space reconciles on a connection.
 */
export async function startTriggers(options: TriggersHostOptions): Promise<TriggersHost | null> {
	const binding = triggersBinding(options.token);
	if (!binding) {
		options.log("This computer's token names no space, so it runs no triggers.");
		return null;
	}
	const folder = path.join(options.stateDir, "triggers");
	await privateFolder(folder);
	const managed = path.join(folder, "managed");
	await privateFolder(managed);
	const spool = await ObservationSpool.open(path.join(folder, binding.runtimeId));
	const owned = new OwnedChildren();
	const clock = options.clock;
	const stopTimeoutMs = DEFAULT_LIMITS.stopTimeoutMs;
	const adapters = observerAdapters({
		poll: { launcher: owned.poll(options.poll ?? new NodeChildLauncher({ defaultCwd: options.root })), stopTimeoutMs, ...(clock ? { clock } : {}) },
		stream: { launcher: owned.stream(options.stream ?? new NodeStreamLauncher({ defaultCwd: options.root })), stopTimeoutMs, ...(clock ? { clock } : {}) },
		process: { provider: new FileProcessProvider(managed), ...(clock ? { clock } : {}) },
	});
	const runtime = new TriggersRuntime({
		binding,
		spool,
		adapters,
		authorize: exactSourceGrant(binding),
		...(clock ? { clock } : {}),
		// Codes and counts only, as the runtime gives them.
		log: (event) => options.log(`Triggers: ${event.code}${event.count === undefined ? "" : ` (${event.count})`}`),
	});
	return new TriggersHost(runtime, owned);
}

/**
 * The runtime on pim-computer's connection. Each socket that opens is a new
 * connection of the runtime's, with an id of its own the space learns from
 * the runtime's `hello` and names in everything it sends; a frame that
 * comes on another socket, or after its socket closed, is dropped. When the
 * socket closes, observers keep running until the space's lease runs out (at
 * most 120 s), as Pim's apps keep running; then the runtime stops them. On
 * shutdown `close` stops them at once.
 */
export class TriggersHost {
	readonly #runtime: TriggersRuntime;
	readonly #owned: OwnedChildren;
	#socket: TriggersSocket | null = null;
	#connectionId: string | null = null;
	#closing: Promise<void> | null = null;

	constructor(runtime: TriggersRuntime, owned: OwnedChildren) {
		this.#runtime = runtime;
		this.#owned = owned;
	}

	/** How many commands this computer's observers started are still running. */
	get owned(): number {
		return this.#owned.size;
	}

	/** Each trigger's observer, as the runtime has it. */
	sources(): ReturnType<TriggersRuntime["sources"]> {
		return this.#runtime.sources();
	}

	/** Resolves once the runtime has nothing left to do; for tests. */
	idle(): Promise<void> {
		return this.#runtime.idle();
	}

	/** A socket opened, and pim-computer has sent its own hello: the runtime says its `hello` on it, and sends nothing else until the space reconciles. */
	attach(socket: TriggersSocket): void {
		if (this.#closing) return;
		if (this.#connectionId) this.#runtime.detach(this.#connectionId);
		const connectionId = randomUUID();
		this.#socket = socket;
		this.#connectionId = connectionId;
		this.#runtime.attach(
			{
				send: (frame) => {
					if (this.#socket !== socket || socket.readyState !== 1 || (socket.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) return false;
					socket.send(`${TRIGGERS_ENVELOPE}${frame}}`);
					return true;
				},
			},
			connectionId,
		);
	}

	/** The socket closed. */
	detach(socket: TriggersSocket): void {
		if (socket !== this.#socket || !this.#connectionId) return;
		this.#runtime.detach(this.#connectionId);
		this.#socket = null;
		this.#connectionId = null;
	}

	/**
	 * A message from the space on `socket`. A triggers message is taken here,
	 * whatever it holds, and true returned, so it never reaches the `Link`;
	 * the frame inside goes to the runtime, which reads it strictly, within
	 * its bound. Any other message is left alone.
	 */
	receive(socket: TriggersSocket, message: string): boolean {
		if (!message.startsWith(TRIGGERS_ENVELOPE)) return false;
		if (socket === this.#socket && this.#connectionId) void this.#runtime.receive(this.#connectionId, message.slice(TRIGGERS_ENVELOPE.length, -1));
		return true;
	}

	/** Stops every observer and waits for their stops, each bounded, closes the spool, and kills whatever child is still provably its own. */
	close(): Promise<void> {
		this.#closing ??= (async () => {
			this.#socket = null;
			this.#connectionId = null;
			try {
				await this.#runtime.close();
			} finally {
				this.#owned.killAll();
			}
		})();
		return this.#closing;
	}

	/** For pim-computer's `exit`, when there's no time to stop: SIGKILL to every child's group still provably its own. */
	killOwned(): void {
		this.#owned.killAll();
	}
}
