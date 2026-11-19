/**
 * The space's WebSockets: tagging a connection by what it is for (the person's computer, a live browser view, a desktop screen, a note's editor),
 * the Yjs peers of notes, relaying the desktop and the browser, the computer's frames, and the live watches a chat and a canvas file keep.
 */
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentEventStream } from "@earendil-works/pi-durable";
import type { Connection, ConnectionContext, WSMessage } from "agents";
import { PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { ArtifactStore } from "../artifacts";
import { userInput } from "../images";
import type { CanvasAnswer } from "../extensions/canvas";
import { COMPUTER_PATH, COMPUTER_SCREEN_PATH, COMPUTER_TAG, Computer, type FileEvent, SCREEN_CLIPBOARD, SCREEN_PING, SCREEN_TAG, type WatchState } from "../computer";
import { FILES_ROOT, Files, filesPath } from "../files";
import { LegacyFiles } from "../legacy-files";
import { NOTE_LIVE_PATH, NOTE_TAG, type NotePeer, NoteStore } from "../notes";
import { BROWSER_LIVE_PATH, BROWSER_TAG, type BrowserInput, type BrowserLiveMessage, PimBrowser } from "../browser";
import { HttpError } from "@pim/shared/http";
import type { ClientMessage, ServerMessage, ToolInfo } from "../protocol";
import { PimStore } from "../store";
import { ComputerTriggers, TRIGGERS_ENVELOPE } from "@pim/triggers/computer";
import type { Submit } from "./conversations";
import { type SocketState, type NoteSocketState, errorMessage } from "./shared";

/** How long an agent's question about the app's canvas waits for an answer. */
export const CANVAS_ASK_MS = 5_000;

/** The close code of a socket whose chat's events stopped coming, so the app connects again and resyncs. */
export const WATCH_LOST = 4010;

/** How long what displayd said of who has a display is believed, in milliseconds. */
export const DISPLAY_CONTROL_TTL_MS = 3_000;

/** What the space's WebSockets needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface SocketsHost {
	readonly artifacts: ArtifactStore;
	readonly notes: NoteStore;
	readonly getConnections: <TState = unknown>(tag?: string) => Iterable<Connection<TState>>;
	readonly store: PimStore;
	readonly computer: Computer;
	readonly displayControl: Map<string, { control: "agent" | "user"; at: number; }>;
	displayLookup: Promise<void> | null;
	readonly orphanedScreens: Set<number>;
	readonly browser: PimBrowser;
	readonly browserWindow: (url: URL) => Promise<string>;
	readonly session: (id: string) => Promise<string>;
	readonly tools: () => ToolInfo[];
	readonly watchRequests: Map<string, object>;
	readonly computerTriggers: () => ComputerTriggers | null;
	readonly computerChanged: () => void;
	readonly broadcastMessage: (message: ServerMessage) => void;
	readonly keepAliveWhile: <T>(fn: () => Promise<T>) => Promise<T>;
	readonly legacyFiles: LegacyFiles;
	readonly files: Files;
	readonly harness: PiHarness;
	readonly submitTo: Submit;
	readonly canvasAsks: Map<string, (answer: CanvasAnswer) => void>;
	readonly watches: Map<string, AgentEventStream>;
	readonly note: (event: string, fields: Record<string, unknown>) => void;
	readonly fileHolds: Map<string, Map<string, number>>;
	readonly broadcast: (msg: string | ArrayBuffer | ArrayBufferView, without?: string[]) => void;
}

export class Sockets {
	constructor(private readonly host: SocketsHost) {}

	// WebSocket API

	/** Pim speaks only its own protocol (see `protocol.ts`) on its sockets. */
	shouldSendProtocolMessages(): boolean {
		return false;
	}

	/** The computer's connection is tagged, so the space finds it, and leaves it out of what it tells the app. */
	getConnectionTags(_connection: Connection, ctx: ConnectionContext): string[] {
		const { pathname } = new URL(ctx.request.url);
		if (pathname === COMPUTER_SCREEN_PATH) return [SCREEN_TAG];
		if (pathname === NOTE_LIVE_PATH) return [NOTE_TAG];
		return pathname === COMPUTER_PATH ? [COMPUTER_TAG] : pathname === BROWSER_LIVE_PATH ? [BROWSER_TAG] : [];
	}

	#isComputer(connection: Connection): boolean {
		return connection.tags.includes(COMPUTER_TAG);
	}

	#isBrowserWatcher(connection: Connection): boolean {
		return connection.tags.includes(BROWSER_TAG);
	}

	#isScreenViewer(connection: Connection): boolean {
		return connection.tags.includes(SCREEN_TAG);
	}

	#isNoteEditor(connection: Connection): boolean {
		return connection.tags.includes(NOTE_TAG);
	}

	/** A socket editing a note, as the notes see it. */
	notePeer(connection: Connection): NotePeer {
		return {
			id: connection.id,
			send: (data) => {
				if (connection.readyState !== WebSocket.OPEN) return;
				try {
					connection.send(data);
				} catch {
					// Closed between the check and the send.
				}
			},
			close: (code, reason) => connection.close(code, reason),
		};
	}

	/** An editor opens a note (`?note=`, kept as the socket's state) and syncs with its live text. */
	async #openNote(connection: Connection<NoteSocketState>, request: Request): Promise<void> {
		const note = new URL(request.url).searchParams.get("note") ?? "";
		try {
			if (this.host.artifacts.get(note)?.kind !== "markdown") throw new HttpError(404, `No note ${note}`);
			connection.setState({ note });
			await this.host.notes.joined(note, this.notePeer(connection));
		} catch (error) {
			connection.close(4004, errorMessage(error).slice(0, 120));
		}
	}

	/** An editor went: the note keeps what was written, once the last one has. */
	async #closeNote(connection: Connection<NoteSocketState>): Promise<void> {
		const note = connection.state?.note;
		if (!note) return;
		const remaining = [...this.host.getConnections<NoteSocketState>(NOTE_TAG)].filter((other) => other.id !== connection.id && other.state?.note === note).length;
		await this.host.notes.left(note, connection.id, remaining);
	}

	/**
	 * An app shows the computer's desktop on this socket: a stream of it
	 * opens on a channel of its own, numbered here and kept as the socket's
	 * state, so the stream finds its socket after the space slept. What the
	 * stream says goes to the socket as it is, and what the app sends goes to
	 * the stream (Cua's media plane, rcdp wire v2).
	 */
	async #viewScreen(connection: Connection<SocketState>, request: Request): Promise<void> {
		const channel = crypto.getRandomValues(new Uint32Array(1))[0]! || 1;
		// `?display=` names the thread whose own display it shows, rather than the primary desktop.
		const named = new URL(request.url).searchParams.get("display") || undefined;
		const display = named === undefined ? undefined : this.host.store.sessionOf(named);
		connection.setState({ session: ROOT_SESSION, channel, ...(display ? { display } : {}) });
		try {
			if (named !== undefined && display === undefined) throw new Error("No such chat.");
			const status = this.host.computer.status();
			if (status.state === "none") throw new Error("This space has no computer.");
			if (status.state === "offline") throw new Error("The computer is offline.");
			if (!status.computer?.screen) throw new Error("This computer doesn't stream its desktop.");
			await this.host.computer.openScreen(channel, display);
		} catch (error) {
			connection.close(4004, errorMessage(error).slice(0, 120));
		}
	}

	/**
	 * Whether the person's input may reach a display's stream: only while they have taken it over in
	 * displayd. Anything else, including a display that isn't listed or a list that couldn't be had, is no.
	 */
	async #mayDrive(display: string): Promise<boolean> {
		const fresh = () => {
			const known = this.host.displayControl.get(display);
			return known && Date.now() - known.at < DISPLAY_CONTROL_TTL_MS ? known : undefined;
		};
		const hit = fresh();
		if (hit) return hit.control === "user";
		this.host.displayLookup ??= this.host.computer
			.displays()
			.then(({ displays }) => {
				this.host.displayControl.clear();
				for (const one of displays) this.host.displayControl.set(one.threadId, { control: one.control, at: Date.now() });
			})
			.catch(() => this.host.displayControl.clear())
			.finally(() => {
				this.host.displayLookup = null;
			});
		await this.host.displayLookup;
		return fresh()?.control === "user";
	}

	/** What a stream of the desktop said, for the socket it's for; null when it closed. */
	screenSaid(channel: number, data: string | ArrayBuffer | null): void {
		const viewer = [...this.host.getConnections<SocketState>(SCREEN_TAG)].find((connection) => connection.state?.channel === channel);
		if (!viewer) {
			// Its socket went: the stream goes too, asked once.
			if (data !== null && !this.host.orphanedScreens.has(channel)) {
				this.host.orphanedScreens.add(channel);
				this.host.computer.closeScreen(channel);
			}
			if (data === null) this.host.orphanedScreens.delete(channel);
			return;
		}
		if (data === null) viewer.close(4000, "The computer's desktop closed");
		else if (viewer.readyState === WebSocket.OPEN) viewer.send(data);
	}

	/**
	 * The app times its round trip to here with a ping, which comes back
	 * with what it said and the space's own round trip to the computer
	 * (`computer_ms`, null when the computer didn't answer). The answer
	 * waits for the computer's, so the whole wait is the app's round trip
	 * to the computer through the space.
	 */
	async #screenPing(connection: Connection<SocketState>, raw: string): Promise<void> {
		let payload: unknown;
		try {
			payload = (JSON.parse(raw) as { payload?: unknown }).payload;
		} catch {
			return;
		}
		const computer = await this.host.computer.ping();
		if (connection.readyState === WebSocket.OPEN) {
			connection.send(JSON.stringify({ type: "pim_pong", payload: { ...(payload as object), computer_ms: computer } }));
		}
	}

	/** The app asks for what was copied on the computer, to copy it to the person's own device; the answer is `pim_clipboard_text`, with no text when there was none to read. */
	async #screenClipboard(connection: Connection<SocketState>): Promise<void> {
		let payload: { text: string; error?: string };
		try {
			payload = { text: await this.host.computer.clipboard(connection.state?.display) };
		} catch (error) {
			payload = { text: "", error: errorMessage(error) };
		}
		if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "pim_clipboard_text", payload }));
	}

	/**
	 * Someone takes a chat's window over on this socket (`?session=`, as the
	 * socket's state): it gets the page as pictures, and its mouse and
	 * keyboard go to the page. It closes when the window does. One that
	 * isn't open opens where it was, waking the computer if it's asleep.
	 */
	async #watchBrowser(connection: Connection<SocketState>, request?: Request): Promise<boolean> {
		const send = (message: BrowserLiveMessage) => {
			if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(message));
		};
		try {
			if (!this.host.browser.available) throw new Error("This space has no browser: connect a computer in Settings → Computer.");
			if (request) connection.setState({ session: await this.host.browserWindow(new URL(request.url)) });
			await this.host.browser.watch(connection.state?.session ?? ROOT_SESSION, connection.id, {
				frame: (frame) => send({ type: "frame", ...frame }),
				page: (page) => send({ type: "page", ...page }),
				closed: () => connection.close(4000, "The window closed"),
			});
			return true;
		} catch (error) {
			send({ type: "error", message: errorMessage(error) });
			connection.close(4004, "The window couldn't open");
			return false;
		}
	}

	async onConnect(connection: Connection<SocketState>, ctx: ConnectionContext): Promise<void> {
		if (this.#isComputer(connection)) {
			this.host.computer.connected(connection);
			this.#closeScreens();
			return;
		}
		if (this.#isBrowserWatcher(connection)) {
			await this.#watchBrowser(connection, ctx.request);
			return;
		}
		if (this.#isScreenViewer(connection)) {
			await this.#viewScreen(connection, ctx.request);
			return;
		}
		if (this.#isNoteEditor(connection)) {
			await this.#openNote(connection as unknown as Connection<NoteSocketState>, ctx.request);
			return;
		}
		const requested = new URL(ctx.request.url).searchParams.get("session");
		let session: string;
		try {
			session = requested ? await this.host.session(requested) : ROOT_SESSION;
		} catch (error) {
			this.send(connection, { type: "error", message: errorMessage(error) });
			connection.close(4004, "Unknown session");
			return;
		}
		connection.setState({ session });
		this.send(connection, { type: "hello", session: this.host.store.publicId(session), tools: this.host.tools() });
		await this.watch(connection, session);
	}

	async onMessage(connection: Connection<SocketState>, raw: WSMessage): Promise<void> {
		if (this.#isComputer(connection)) return this.#computerSaid(raw, connection);
		if (this.#isNoteEditor(connection)) {
			const note = (connection.state as unknown as Partial<NoteSocketState> | undefined)?.note;
			if (!note || typeof raw === "string") return;
			const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
			try {
				await this.host.notes.receive(note, this.notePeer(connection), bytes);
			} catch (error) {
				connection.close(4004, errorMessage(error).slice(0, 120));
			}
			return;
		}
		if (typeof raw !== "string") return;
		if (this.#isScreenViewer(connection)) {
			if (raw.startsWith(SCREEN_PING)) return this.#screenPing(connection, raw);
			if (raw.startsWith(SCREEN_CLIPBOARD)) return this.#screenClipboard(connection);
			const { channel, display } = connection.state ?? {};
			// A chat's display is watched only until the person takes it over, which the browser's own say-so doesn't settle.
			if (channel && (display === undefined || (await this.#mayDrive(display)))) this.host.computer.screenInput(channel, raw);
			return;
		}
		if (this.#isBrowserWatcher(connection)) {
			// A space that slept since forgot who was watching: they go on where they were.
			if (!this.host.browser.watching(connection.id) && !(await this.#watchBrowser(connection))) return;
			try {
				await this.host.browser.input(connection.id, JSON.parse(raw) as BrowserInput);
			} catch (error) {
				if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify({ type: "error", message: errorMessage(error) } satisfies BrowserLiveMessage));
			}
			return;
		}
		let message: ClientMessage;
		try {
			message = JSON.parse(raw) as ClientMessage;
		} catch {
			this.send(connection, { type: "error", message: "Malformed JSON" });
			return;
		}
		const session = connection.state?.session ?? ROOT_SESSION;
		try {
			const result = await this.#command(connection, session, message);
			if (message.id !== undefined) this.send(connection, { type: "result", id: message.id, result });
		} catch (error) {
			this.send(connection, {
				type: "error",
				...(message.id === undefined ? {} : { id: message.id }),
				message: errorMessage(error),
			});
		}
	}

	async onClose(connection: Connection): Promise<void> {
		if (this.#isComputer(connection)) return this.#computerDisconnected(connection);
		if (this.#isBrowserWatcher(connection)) return this.host.browser.unwatch(connection.id);
		if (this.#isScreenViewer(connection)) return this.#stopViewing(connection);
		if (this.#isNoteEditor(connection)) return this.#closeNote(connection as Connection<NoteSocketState>);
		this.host.watchRequests.delete(connection.id);
		await Promise.all([this.#unwatch(connection.id), this.#releaseFiles(connection.id)]);
	}

	async onError(connection: Connection): Promise<void> {
		if (this.#isComputer(connection)) return this.#computerDisconnected(connection);
		if (this.#isBrowserWatcher(connection)) return this.host.browser.unwatch(connection.id);
		if (this.#isScreenViewer(connection)) return this.#stopViewing(connection);
		if (this.#isNoteEditor(connection)) return this.#closeNote(connection as Connection<NoteSocketState>);
		this.host.watchRequests.delete(connection.id);
		await Promise.all([this.#unwatch(connection.id), this.#releaseFiles(connection.id)]);
	}

	/** The app stopped showing the desktop: its stream closes. */
	#stopViewing(connection: Connection): void {
		const { channel } = (connection.state ?? {}) as Partial<SocketState>;
		if (channel) this.host.computer.closeScreen(channel);
	}

	/** A message from the computer: what it is, when it has just connected, an answer, or what a stream of its desktop says. */
	#computerSaid(raw: string | ArrayBuffer | ArrayBufferView, connection: Connection): void {
		// Triggers' frames, where the space's triggers are on, before anything else reads the message; elsewhere they go on as before, to be ignored.
		if (typeof raw === "string" && raw.startsWith(TRIGGERS_ENVELOPE)) {
			const triggers = this.host.computerTriggers();
			if (triggers) {
				triggers.receive(connection, raw);
				return;
			}
		}
		const message = typeof raw === "string" || raw instanceof ArrayBuffer ? raw : (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
		const hello = typeof message === "string" && message.startsWith('{"type":"hello"');
		const desktop = hello && this.host.computer.desktop();
		this.host.computer.receive(message);
		if (!hello) return;
		// A computer of the person's own that now has a desktop agents can use, or no longer has one: its tools come or go.
		if (this.host.computer.desktop() !== desktop) this.host.computerChanged();
		this.#computerConnected();
	}

	/**
	 * The computer connected and said what it is: open apps hear of it, and
	 * files kept in the space before files moved to the computer move there.
	 */
	#computerConnected(): void {
		this.host.broadcastMessage({ type: "computer" });
		void this.host.keepAliveWhile(async () => {
			try {
				if (!(await this.host.legacyFiles.any())) return;
				const moved = await this.host.legacyFiles.moveTo(this.host.files);
				if (moved > 0) this.host.broadcastMessage({ type: "computer" });
			} catch (error) {
				// It goes on from where it stopped the next time the computer connects.
				console.warn("moving files to the computer failed", error);
			}
		});
	}

	#computerDisconnected(connection: Connection): void {
		this.host.computerTriggers()?.closed(connection);
		this.host.computer.disconnected();
		this.#closeScreens();
		this.host.broadcastMessage({ type: "computer" });
	}

	/**
	 * The desktop's streams go with the computer's connection they came on,
	 * when it closes or another takes its place: the apps showing them
	 * connect again, once the computer is back.
	 */
	#closeScreens(): void {
		for (const viewer of this.host.getConnections(SCREEN_TAG)) viewer.close(4000, "The computer's connection changed");
	}

	async #command(connection: Connection<SocketState>, session: string, message: ClientMessage): Promise<JsonValue> {
		const handle = this.host.harness.session(session);
		switch (message.type) {
			case "submit": {
				const receipt = await this.host.submitTo(
					session,
					userInput(message.content),
					{
						...(message.whenBusy ? { whenBusy: message.whenBusy } : {}),
						...(message.operationId ? { operationId: message.operationId } : {}),
					},
					"user",
				);
				return { ...receipt, session: this.host.store.publicId(session) };
			}
			case "abort":
				return await handle.abort(message.operationId);
			case "reset":
				await handle.reset(message.handoff);
				return null;
			case "resync":
				await this.watch(connection, session);
				return null;
			case "follow":
				await this.watch(connection, this.host.session(message.session));
				return null;
			case "watch_file":
				await this.#watchFile(connection, message.path);
				return null;
			case "unwatch_file":
				await this.#unwatchFile(connection.id, message.path);
				return null;
			case "canvas_answer":
				this.host.canvasAsks.get(message.request)?.(message);
				return null;
			case "snapshot": {
				const stream = await this.host.harness.session(await this.host.session(message.session)).events();
				await stream.stop();
				return stream.snapshot as unknown as JsonValue;
			}
			default:
				throw new Error(`Unknown message type ${JSON.stringify((message as { type: unknown }).type)}`);
		}
	}

	/**
	 * Sends a session's snapshot on the socket, then its events, in place of
	 * what the socket followed. A socket can switch quickly, as someone flips
	 * through chats: only its latest request is kept.
	 */
	async watch(connection: Connection<SocketState>, which: string | Promise<string>, failure = "watch failed"): Promise<void> {
		const request = {};
		this.host.watchRequests.set(connection.id, request);
		const session = await which;
		let stream: AgentEventStream;
		try {
			await this.#unwatch(connection.id);
			stream = await this.host.harness.session(session).events();
		} catch (error) {
			// The socket follows nothing now: waiting for events that never come, the app would show the chat as it was.
			if (this.host.watchRequests.get(connection.id) === request) this.#watchLost(connection, failure, error);
			throw error;
		}
		if (this.host.watchRequests.get(connection.id) !== request) {
			await stream.stop();
			return;
		}
		connection.setState({ session });
		this.host.watches.set(connection.id, stream);
		// A watch that ends but not by `#unwatch` (the chat's session closed, or the listener failed) leaves the socket following nothing too.
		void stream.closed.then((end) => {
			if (this.host.watches.get(connection.id) !== stream) return;
			this.host.watches.delete(connection.id);
			this.#watchLost(connection, "watch ended", end.kind === "listener_error" ? end.error : end.kind);
		});
		const id = this.host.store.publicId(session);
		this.send(connection, { type: "events", session: id, events: [stream.snapshot] });
		stream.start(async (events) => {
			// Chats only say that a request failed; the provider's own words are for whoever runs the deployment.
			for (const event of events) {
				if (event.type === "task_failed") {
					this.host.note("task_failed", { kind: event.kind, error: event.message.slice(0, 1000) });
				} else if (event.type === "submission" && event.record.status === "unanswered" && event.record.reason === "model_error") {
					this.host.note("model_error", { error: String(event.record.detail ?? "").slice(0, 1000) });
				}
			}
			if (connection.readyState !== WebSocket.OPEN) {
				void this.#unwatch(connection.id);
				return;
			}
			this.send(connection, { type: "events", session: id, events });
		});
	}

	/** Closes a socket whose watch failed or ended, so the app connects again and resyncs. */
	#watchLost(connection: Connection<SocketState>, reason: string, cause: unknown): void {
		this.host.note("watch_lost", { reason, cause: errorMessage(cause).slice(0, 500) });
		this.host.watchRequests.delete(connection.id);
		try {
			connection.close(WATCH_LOST, reason);
		} catch {
			// Closed already.
		}
	}

	async #unwatch(connectionId: string): Promise<void> {
		const stream = this.host.watches.get(connectionId);
		if (!stream) return;
		this.host.watches.delete(connectionId);
		await stream.stop();
	}

	/** The app socket holds a watch on a file of the person's: it hears of changes to it, and of how it is now straight away. */
	async #watchFile(connection: Connection<SocketState>, requested: unknown): Promise<void> {
		const path = filesPath(requested);
		if (path === null) throw new HttpError(400, `path must be an absolute path under ${FILES_ROOT}`);
		let state: WatchState;
		try {
			state = await this.host.computer.watch(path);
		} catch (error) {
			// A computer from before watching can't tell of changes: the file opens, and stays as it was read.
			if ((error as { code?: unknown }).code !== "ENOSYS") throw error;
			this.send(connection, { type: "file_changed", path, kind: "unwatched", sha256: null, size: null });
			return;
		}
		const holds = this.host.fileHolds.get(connection.id) ?? new Map<string, number>();
		if (connection.readyState !== WebSocket.OPEN) {
			// Gone while the computer answered: its holds were let go already, and this one never was.
			await this.host.computer.unwatch(path);
			return;
		}
		holds.set(path, (holds.get(path) ?? 0) + 1);
		this.host.fileHolds.set(connection.id, holds);
		this.send(connection, { type: "file_changed", path, kind: state.exists ? "modified" : "deleted", sha256: state.sha256, size: state.size });
	}

	async #unwatchFile(connectionId: string, requested: unknown): Promise<void> {
		const path = filesPath(requested);
		const holds = this.host.fileHolds.get(connectionId);
		const count = path === null ? undefined : holds?.get(path);
		if (path === null || !holds || count === undefined) return;
		if (count > 1) holds.set(path, count - 1);
		else holds.delete(path);
		if (holds.size === 0) this.host.fileHolds.delete(connectionId);
		await this.host.computer.unwatch(path);
	}

	/** A socket closed: its holds on files go, and with the last of a file's the computer stops watching it. */
	async #releaseFiles(connectionId: string): Promise<void> {
		const holds = this.host.fileHolds.get(connectionId);
		this.host.fileHolds.delete(connectionId);
		for (const [path, count] of holds ?? []) for (let each = 0; each < count; each++) await this.host.computer.unwatch(path);
	}

	/** A watched file changed, or can't be watched anymore: the sockets that hold it hear of it. */
	fileEvent(event: FileEvent): void {
		for (const connection of this.host.getConnections<SocketState>()) {
			const holds = this.host.fileHolds.get(connection.id);
			if (!holds?.has(event.path)) continue;
			if (event.event === "watch_error") {
				holds.delete(event.path);
				this.send(connection, { type: "file_changed", path: event.path, kind: "unwatched", sha256: null, size: null });
			} else this.send(connection, { type: "file_changed", path: event.path, kind: event.kind, sha256: event.sha256, size: event.size });
		}
	}

	/** Tells the apps showing `session` to open a file in the canvas; how many were told. */
	canvasOpen(session: string, path: string, line?: number): number {
		const watchers = this.watchers(session).filter((connection) => connection.readyState === WebSocket.OPEN);
		for (const connection of watchers) this.send(connection, { type: "canvas_open", session: this.host.store.publicId(session), path, ...(line === undefined ? {} : { line }) });
		return watchers.length;
	}

	/** Asks the apps showing `session` about their canvas, and returns the first answer, or null when none comes in a few seconds. */
	canvasAsk(session: string, what: "tabs" | "selection"): Promise<CanvasAnswer | null> {
		const watchers = this.watchers(session).filter((connection) => connection.readyState === WebSocket.OPEN);
		if (watchers.length === 0) return Promise.resolve(null);
		const request = crypto.randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.host.canvasAsks.delete(request);
				resolve(null);
			}, CANVAS_ASK_MS);
			this.host.canvasAsks.set(request, (answer) => {
				clearTimeout(timer);
				this.host.canvasAsks.delete(request);
				resolve(answer);
			});
			for (const connection of watchers) this.send(connection, { type: "canvas_query", session: this.host.store.publicId(session), request, what });
		});
	}

	/** The sockets following `session`. */
	watchers(session: string): Connection<SocketState>[] {
		return [...this.host.getConnections<SocketState>()].filter((connection) => connection.state?.session === session);
	}

	send(connection: Connection, message: ServerMessage): void {
		if (connection.readyState !== WebSocket.OPEN) return;
		try {
			connection.send(JSON.stringify(message));
		} catch {
			// Closed between the check and the send.
		}
	}

	/** Tells every open app; the computer's connection, and those taking the browser over, showing the desktop or editing a note, speak other protocols. */
	broadcastMessage(message: ServerMessage): void {
		this.host.broadcast(
			JSON.stringify(message),
			[...this.host.getConnections(COMPUTER_TAG), ...this.host.getConnections(BROWSER_TAG), ...this.host.getConnections(SCREEN_TAG), ...this.host.getConnections(NOTE_TAG)].map(
				(connection) => connection.id,
			),
		);
	}
}
