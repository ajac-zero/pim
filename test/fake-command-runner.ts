// A CommandRunner for tests of the Amp CLI orb client (src/coding/orb/amp-cli.ts):
// it scripts what the CLI prints, when, and how its commands end, and records
// every command it was asked to run. No real `amp`, no network — the client
// under test can't tell it from the CLI its runner would exec in a sandbox,
// except that nothing here is anyone's money.

import { type CommandRunner, type OrbCommand, type OrbCommandEvent } from "../src/coding/orb/amp-cli";

/** The commands of Amp's CLI the client runs, as the fake tells them apart. */
export type AmpCommandKind = "start" | "steer" | "stop" | "other";

const kindOf = (argv: readonly string[]): AmpCommandKind =>
	argv[0] !== "amp" ? "other" : argv.includes("archive") ? "stop" : argv.includes("continue") ? "steer" : "start";

/** The message a `--execute` flag carries, which is the prompt or the steered words. */
const executeOf = (argv: readonly string[]): string => argv.find((each) => each.startsWith("--execute="))?.slice("--execute=".length) ?? "";

/** The thread an init line names, which the fake remembers as the command's own. */
const threadOfLine = (text: string): string | null => {
	try {
		const value = JSON.parse(text) as { type?: string; subtype?: string; session_id?: unknown };
		return value.type === "system" && value.subtype === "init" && typeof value.session_id === "string" ? value.session_id : null;
	} catch {
		return null;
	}
};

/** The stream-json lines the fake prints, in the CLI's own shape (docs/coding-amp.md). */
export const ampOrbLines = {
	init: (threadId: string) =>
		JSON.stringify({ type: "system", subtype: "init", cwd: "/workspace/repo", session_id: threadId, agent_mode: "medium", tools: ["create_file", "edit_file", "shell_command", "skill", "Task"] }),
	user: (threadId: string, text: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: threadId }),
	assistant: (threadId: string, text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: threadId }),
	/** The turn's result, the only end of a turn the stream says. */
	result: (threadId: string, ok = true) => JSON.stringify({ type: "result", subtype: ok ? "success" : "error_during_execution", is_error: !ok, result: ok ? "Done" : "It failed", session_id: threadId }),
};

/** One command the fake is running. Its lines are handed to the client as it reads them; a script awaits each and so knows the client took it. */
export class FakeCommand implements OrbCommand {
	readonly argv: readonly string[];
	readonly kind: AmpCommandKind;
	/** true once the client killed the process, as `stop` does. */
	killed = false;
	/** The thread the command's init line named, until then null. */
	thread: string | null = null;
	readonly events: AsyncIterable<OrbCommandEvent>;
	#items: { readonly event: OrbCommandEvent; readonly took?: () => void }[] = [];
	/** The item the client is reading, whose `took` resolves when it asks for the next. */
	#reading: { readonly event: OrbCommandEvent; readonly took?: () => void } | null = null;
	#pull: ((item: { readonly event: OrbCommandEvent; readonly took?: () => void } | null) => void) | null = null;
	#done = false;
	readonly #holds: (() => void)[] = [];

	constructor(argv: readonly string[]) {
		this.argv = argv;
		this.kind = kindOf(argv);
		this.events = {
			[Symbol.asyncIterator]: () => ({ next: () => this.#next() }),
		};
	}

	/** true once the command has ended, well or by a kill. */
	get exited(): boolean {
		return this.#done;
	}

	/** Prints one line on the CLI's output; resolves once the client has read it. */
	async line(text: string): Promise<void> {
		const threadId = threadOfLine(text);
		if (threadId !== null) this.thread = threadId;
		await this.#push({ type: "stdout", data: `${text}\n` });
	}

	/** Prints on the CLI's error output; resolves once the client has read it. */
	async error(text: string): Promise<void> {
		await this.#push({ type: "stderr", data: text });
	}

	/** Ends the command with this exit code; resolves once the client has read the exit. */
	async exit(code: number): Promise<void> {
		await this.#push({ type: "exit", code });
	}

	/** Prints nothing for a while, as a turn that is running; ends early if the command is killed. */
	async delay(ms: number): Promise<void> {
		await new Promise<void>((resolve) => {
			const held = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(held, ms);
			this.#holds.push(held);
		});
	}

	/** Waits until the command ends, for a script whose turn stays open until the test or the client ends it. */
	hold(): Promise<void> {
		return new Promise((resolve) => {
			if (this.#done) resolve();
			else this.#holds.push(resolve);
		});
	}

	/** What the client's `stop` does to a process it holds: kills it, and the exit follows. */
	kill(): void {
		if (this.#done) return;
		this.killed = true;
		this.#offer({ type: "exit", code: null, signal: "SIGKILL" });
	}

	/** Runs `script`, ending the command cleanly if it returns and with its error on the CLI's error output if it throws. */
	go(script: (command: FakeCommand) => Promise<void>): void {
		void (async () => {
			try {
				await script(this);
			} catch (error) {
				this.#offer({ type: "stderr", data: `${String(error)}\n` });
				this.#offer({ type: "exit", code: 1 });
				return;
			}
			if (!this.#done) this.#offer({ type: "exit", code: 0 });
		})();
	}

	async #push(event: OrbCommandEvent): Promise<void> {
		if (this.#done) return;
		return new Promise((resolve) => {
			this.#offer(event, resolve);
		});
	}

	#offer(event: OrbCommandEvent, took?: () => void): void {
		if (this.#done) return;
		const item = { event, took };
		if (event.type === "exit") {
			this.#done = true;
			for (const hold of this.#holds.splice(0)) hold();
		}
		if (this.#pull === null) this.#items.push(item);
		else {
			const pull = this.#pull;
			this.#pull = null;
			this.#reading = item;
			pull(item);
		}
	}

	async #next(): Promise<IteratorResult<OrbCommandEvent>> {
		// The client has finished with what it was reading, so whoever printed it can go on.
		this.#reading?.took?.();
		this.#reading = null;
		const item = this.#items.shift();
		if (item !== undefined) {
			this.#reading = item;
			return { value: item.event, done: false };
		}
		if (this.#done) return { value: undefined as never, done: true };
		return new Promise((resolve) => {
			this.#pull = (handed) => {
				if (handed === null) resolve({ value: undefined as never, done: true });
				else {
					this.#reading = handed;
					resolve({ value: handed.event, done: false });
				}
			};
		});
	}
}

/**
 * The `amp` CLI as a test scripts it. By default a start makes a thread,
 * echoes the person's words and keeps running; a `threads continue` takes the
 * message and then waits, as one queued behind a running turn; `threads
 * archive` succeeds. `script` replaces any of that, `refuse` makes a kind
 * fail as one whose network is down, and `lost` makes a thread's commands
 * answer what the CLI says about one that is gone.
 */
export class FakeCommandRunner implements CommandRunner {
	/** Every command the client asked for, oldest first. */
	readonly commands: FakeCommand[] = [];
	/** The threads that no longer exist on Amp's cloud, whose commands answer "thread not found". */
	readonly lost = new Set<string>();
	readonly #refused = new Set<AmpCommandKind>();
	readonly #scripts = new Map<AmpCommandKind, (command: FakeCommand) => Promise<void>>();
	#threads = 0;

	run(argv: readonly string[]): FakeCommand {
		const command = new FakeCommand(argv);
		this.commands.push(command);
		const thread = command.kind === "start" ? null : (argv[3] ?? null);
		command.go(async () => {
			if (this.#refused.has(command.kind)) return this.#fail(command, "Error: Couldn't connect to the Amp server at https://unreachable.invalid.\n");
			if (thread !== null && this.lost.has(thread)) return this.#fail(command, "Error: thread not found\n");
			const scripted = this.#scripts.get(command.kind);
			if (scripted !== undefined) return await scripted(command);
			switch (command.kind) {
				case "start": {
					// A new thread: its id, the person's words, and a turn that keeps running until the test ends it.
					const id = `T-${++this.#threads}`;
					await command.line(ampOrbLines.init(id));
					await command.line(ampOrbLines.user(id, executeOf(argv)));
					await command.hold();
					return;
				}
				case "steer":
					// The message is taken and queued behind the running turn; this process stays attached until that turn ends.
					await command.line(ampOrbLines.init(thread!));
					await command.hold();
					return;
				default:
					await command.exit(0);
			}
		});
		return command;
	}

	/** Makes commands of this kind run `script` in place of the fake's own idea of what the CLI does. */
	script(kind: AmpCommandKind, script: (command: FakeCommand) => Promise<void>): void {
		this.#scripts.set(kind, script);
	}

	/** Makes commands of this kind fail as one whose network is down, or stops that when `on` is false. */
	refuse(kind: AmpCommandKind, on = true): void {
		if (on) this.#refused.add(kind);
		else this.#refused.delete(kind);
	}

	/** The commands of a kind, oldest first. */
	of(kind: AmpCommandKind): FakeCommand[] {
		return this.commands.filter((command) => command.kind === kind);
	}

	/** The commands still attached to a thread, oldest first: the running turn and the ones queued behind it. */
	attached(threadId: string): FakeCommand[] {
		return this.commands.filter((command) => !command.exited && (command.thread === threadId || command.argv.includes(threadId)));
	}

	async #fail(command: FakeCommand, text: string): Promise<void> {
		await command.error(text);
		await command.exit(1);
	}
}
