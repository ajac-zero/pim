/**
 * Notes: the documents of Pim's built-in Notes app, which the person and
 * their agents write together, live (its tools are ./extensions/notes.ts).
 *
 * A note is stored as an app of kind `markdown`, with its versions like any other
 * (see ./artifacts.ts). What it says right now is a Yjs document kept here,
 * in the space, which every open editor of the note syncs with over a
 * socket of its own (`/notes/live?note=<id>`, speaking y-websocket's sync
 * and awareness messages). The person's typing reaches the agent, and the
 * agent's edits reach the person's editor, as they happen.
 *
 * - The live text is the truth; versions are what it said at moments worth
 *   keeping: when the person pauses or closes the note, before and after
 *   each change the agent makes, and when someone restores one. So the
 *   history reads as the person's turns and the agent's, not keystrokes.
 * - The agent's edits are find-and-replace pairs. They apply to the live
 *   text as it is when they land, so what the person typed meanwhile
 *   stays, and the base version they name matters only for a whole new text.
 * - The document's updates are kept in SQL, merged into one now and then,
 *   so an editor that reconnects after the space slept syncs with the same
 *   document and never gets the text twice.
 * - A version made some other way (an older client's whole-file save, an
 *   import) is taken into the live text the next time the note is used.
 */

import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as sync from "y-protocols/sync";
import * as Y from "yjs";
import { type ArtifactSource, type ArtifactStore, type ArtifactVersion, applyEdits } from "./artifacts";
import { HttpError } from "./http";

/** Where an editor opens a note's live document, with `?note=<id>`. */
export const NOTE_LIVE_PATH = "/notes/live";
/** The tag of the sockets editing notes. */
export const NOTE_TAG = "note";

/** What a note's socket says, numbered as y-websocket does, and Pim's own message after them. */
const SYNC = 0;
const AWARENESS = 1;
/** The person paused: what they wrote since the last version becomes one. */
const CHECKPOINT = 2;

/** The shared text in a note's document. */
export const NOTE_TEXT = "markdown";
/** Updates kept for a note before they are merged into one. */
const COMPACT_AFTER = 200;
/** The largest message an editor may send. */
const MAX_MESSAGE_BYTES = 2_000_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pim_note_updates (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	artifact TEXT NOT NULL,
	data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS pim_note_updates_by_artifact ON pim_note_updates (artifact, seq);
-- Each live note: the version its text was last saved as or taken from, and whether the person wrote since.
CREATE TABLE IF NOT EXISTS pim_notes (
	artifact TEXT PRIMARY KEY,
	base INTEGER NOT NULL,
	dirty INTEGER NOT NULL
);
`;

/** An editor connected to a note. */
export type NotePeer = {
	readonly id: string;
	send(data: Uint8Array | string): void;
	close(code: number, reason: string): void;
};

/** What the server tells an editor besides the document: a new version, or a version that couldn't be made. */
export type NoteNotice = { type: "version"; version: number } | { type: "error"; message: string };

type Live = {
	readonly doc: Y.Doc;
	readonly text: Y.Text;
	/** The version the text was last saved as, or taken from. */
	base: number;
	/** Whether the person wrote since. */
	dirty: boolean;
	/** Counts the person's updates, so a save knows whether they wrote while it waited. */
	edits: number;
	/** Updates kept in SQL. */
	rows: number;
};

/** Who changed the live text, when it wasn't an editor. */
type ServerOrigin = "agent" | "version";

export class NoteStore {
	readonly #sql: SqlStorage;
	readonly #artifacts: ArtifactStore;
	readonly #peers: (note: string) => NotePeer[];
	readonly #live = new Map<string, Promise<Live>>();
	readonly #queues = new Map<string, Promise<unknown>>();
	/** Each editor's last awareness message (its cursor and name), and the clients and clocks it named. */
	readonly #awareness = new Map<string, { note: string; message: Uint8Array; clients: Map<number, number> }>();

	constructor(sql: SqlStorage, artifacts: ArtifactStore, peers: (note: string) => NotePeer[]) {
		this.#sql = sql;
		this.#artifacts = artifacts;
		this.#peers = peers;
		this.#sql.exec(SCHEMA);
	}

	/** An editor opened the note: it gets the document's state, and who else is there. */
	async joined(note: string, peer: NotePeer): Promise<void> {
		const live = await this.#queue(note, () => this.#current(note));
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, SYNC);
		sync.writeSyncStep1(encoder, live.doc);
		peer.send(encoding.toUint8Array(encoder));
		for (const [id, { note: other, message }] of this.#awareness) {
			if (other === note && id !== peer.id) peer.send(message);
		}
	}

	/** A message from an editor: the document's sync, its cursor, or a pause. */
	async receive(note: string, peer: NotePeer, data: Uint8Array): Promise<void> {
		if (data.byteLength > MAX_MESSAGE_BYTES) {
			peer.close(1009, "The message is too large");
			return;
		}
		const live = await this.#load(note);
		const decoder = decoding.createDecoder(data);
		const type = decoding.readVarUint(decoder);
		if (type === SYNC) {
			const encoder = encoding.createEncoder();
			encoding.writeVarUint(encoder, SYNC);
			sync.readSyncMessage(decoder, encoder, live.doc, peer);
			if (encoding.length(encoder) > 1) peer.send(encoding.toUint8Array(encoder));
		} else if (type === AWARENESS) {
			const clients = awarenessClients(decoding.readVarUint8Array(decoder));
			const previous = this.#awareness.get(peer.id)?.clients ?? new Map<number, number>();
			for (const [client, clock] of clients) previous.set(client, clock);
			this.#awareness.set(peer.id, { note, message: data, clients: previous });
			this.#broadcast(note, data, peer.id);
		} else if (type === CHECKPOINT) {
			await this.checkpoint(note);
		}
	}

	/** An editor closed the note: others stop seeing its cursor, and the last one out keeps what was written as a version. */
	async left(note: string, peerId: string, remaining: number): Promise<void> {
		const awareness = this.#awareness.get(peerId);
		this.#awareness.delete(peerId);
		if (awareness && awareness.clients.size > 0) this.#broadcast(note, removal(awareness.clients), peerId);
		if (remaining === 0) await this.checkpoint(note);
	}

	/** Keeps what the person wrote since the last version as a new one, if they wrote anything. */
	async checkpoint(note: string): Promise<void> {
		await this.#queue(note, async () => {
			if (!this.#artifacts.get(note)) return;
			const live = await this.#current(note);
			if (!live.dirty) return;
			try {
				await this.#save(note, live, { source: "person" });
			} catch (error) {
				// The live text keeps it; the person hears why there's no version, such as the app's version limit.
				this.#notify(note, { type: "error", message: error instanceof Error ? error.message : String(error) });
			}
		});
	}

	/** Keeps every note's unsaved writing as a version, as before an export. */
	async checkpointAll(): Promise<void> {
		const dirty = this.#sql
			.exec("SELECT artifact FROM pim_notes WHERE dirty = 1")
			.toArray()
			.map((row) => String(row.artifact));
		for (const note of dirty) await this.checkpoint(note);
	}

	/**
	 * The live text, for the agent to read: what the person wrote since the
	 * last version becomes one first, so the version it reads is the latest.
	 */
	async read(note: string): Promise<string> {
		return this.#queue(note, async () => {
			const live = await this.#current(note);
			if (live.dirty) await this.#save(note, live, { source: "person" }).catch(() => undefined);
			return live.text.toString();
		});
	}

	/**
	 * Changes the note: `edits` apply to the live text as it is, whatever
	 * the person wrote since the agent read it, and `append` adds to its end;
	 * a whole new `content` needs `baseVersion` to be the latest, as for any app. What the person wrote
	 * before becomes a version of theirs, and the change one of its own.
	 * `callId` makes a replayed tool call return the version it made.
	 */
	async write(
		note: string,
		change: {
			readonly baseVersion: number;
			readonly edits?: readonly { find: string; replace: string }[];
			readonly append?: string;
			readonly content?: string;
			readonly title?: string;
			readonly source: ArtifactSource;
			readonly callId?: string;
		},
	): Promise<{ version: ArtifactVersion; changed: boolean }> {
		return this.#queue(note, async () => {
			if (change.callId !== undefined) {
				const made = this.#artifacts.byCall(note, change.callId);
				if (made) return { version: made, changed: true };
			}
			const live = await this.#current(note);
			if (live.dirty) await this.#save(note, live, { source: "person" });
			const latest = this.#artifacts.get(note)!;
			if (change.content !== undefined && change.baseVersion !== latest.version) {
				throw new HttpError(409, `Version ${change.baseVersion} is not the latest: version ${latest.version} is. Read it, then edit that.`);
			}
			const before = live.text.toString();
			const edited = change.content ?? (change.edits ? applyEdits(before, change.edits) : before);
			const after = change.append === undefined ? edited : appended(edited, change.append);
			const saved = await this.#artifacts.append(note, {
				baseVersion: latest.version,
				content: after,
				source: change.source,
				...(change.callId !== undefined ? { callId: change.callId } : {}),
				...(change.title !== undefined ? { title: change.title } : {}),
			});
			// The person may have typed while the version was stored: the change goes onto the text as it is now.
			live.doc.transact(() => {
				if (change.content !== undefined) replaceText(live.text, edited);
				else if (change.edits) applyEditsTo(live.text, change.edits, edited);
				if (change.append !== undefined) live.text.insert(live.text.length, appended(live.text.toString(), change.append).slice(live.text.length));
			}, "agent" satisfies ServerOrigin);
			live.base = saved.version.version;
			live.dirty = live.text.toString() !== after;
			this.#saveState(note, live);
			if (saved.changed) this.#notify(note, { type: "version", version: saved.version.version });
			return saved;
		});
	}

	/** Restores an older version as the latest, into the live text too. */
	async restore(note: string, version: number, baseVersion: number): Promise<ArtifactVersion> {
		return this.#queue(note, async () => {
			const live = await this.#current(note);
			if (live.dirty) await this.#save(note, live, { source: "person" });
			const restored = await this.#artifacts.restore(note, version, baseVersion);
			await this.#adopt(note, live, restored.version);
			this.#notify(note, { type: "version", version: restored.version });
			return restored;
		});
	}

	/** Forgets a deleted note's live document, and closes its editors. */
	forget(note: string): void {
		this.#sql.exec("DELETE FROM pim_note_updates WHERE artifact = ?", note);
		this.#sql.exec("DELETE FROM pim_notes WHERE artifact = ?", note);
		this.#live.delete(note);
		for (const peer of this.#peers(note)) peer.close(4004, "The note was deleted");
	}

	/** Runs the note's operations one after another, so two saves never race for the same version. */
	#queue<T>(note: string, run: () => Promise<T>): Promise<T> {
		const previous = this.#queues.get(note) ?? Promise.resolve();
		const next = previous.then(run, run);
		const settled = next.catch(() => undefined);
		this.#queues.set(note, settled);
		void settled.then(() => {
			if (this.#queues.get(note) === settled) this.#queues.delete(note);
		});
		return next;
	}

	/** The note's live document, taking in a version made some other way since. */
	async #current(note: string): Promise<Live> {
		const live = await this.#load(note);
		const latest = this.#artifacts.get(note);
		if (!latest) throw new HttpError(404, `No note ${note}`);
		if (latest.version !== live.base) await this.#adopt(note, live, latest.version);
		return live;
	}

	#load(note: string): Promise<Live> {
		let live = this.#live.get(note);
		if (!live) {
			live = this.#open(note);
			this.#live.set(note, live);
			live.catch(() => {
				if (this.#live.get(note) === live) this.#live.delete(note);
			});
		}
		return live;
	}

	/** Opens the note's document from what SQL keeps, or makes it from its latest version the first time. */
	async #open(note: string): Promise<Live> {
		const summary = this.#artifacts.get(note);
		if (!summary || summary.kind !== "markdown") throw new HttpError(404, `No note ${note}`);
		const doc = new Y.Doc();
		const text = doc.getText(NOTE_TEXT);
		const updates = this.#sql
			.exec("SELECT data FROM pim_note_updates WHERE artifact = ? ORDER BY seq", note)
			.toArray()
			.map((row) => new Uint8Array(row.data as ArrayBuffer));
		const [state] = this.#sql.exec("SELECT base, dirty FROM pim_notes WHERE artifact = ?", note).toArray();
		let live: Live;
		if (state && updates.length > 0) {
			Y.applyUpdate(doc, Y.mergeUpdates(updates));
			live = { doc, text, base: Number(state.base), dirty: Number(state.dirty) === 1, edits: 0, rows: updates.length };
		} else {
			text.insert(0, await this.#artifacts.text(note, summary.version));
			live = { doc, text, base: summary.version, dirty: false, edits: 0, rows: 0 };
			this.#compact(note, live);
			this.#saveState(note, live);
		}
		doc.on("update", (update: Uint8Array, origin: unknown) => this.#updated(note, live, update, origin));
		return live;
	}

	/** Every change to a document is kept, and sent to the editors that didn't make it. */
	#updated(note: string, live: Live, update: Uint8Array, origin: unknown): void {
		this.#sql.exec("INSERT INTO pim_note_updates (artifact, data) VALUES (?, ?)", note, toBuffer(update));
		live.rows++;
		if (live.rows > COMPACT_AFTER) this.#compact(note, live);
		const from = isPeer(origin) ? origin.id : undefined;
		if (from !== undefined) {
			live.edits++;
			if (!live.dirty) {
				live.dirty = true;
				this.#saveState(note, live);
			}
		}
		const encoder = encoding.createEncoder();
		encoding.writeVarUint(encoder, SYNC);
		sync.writeUpdate(encoder, update);
		this.#broadcast(note, encoding.toUint8Array(encoder), from);
	}

	/** Keeps the document as one update in place of many. */
	#compact(note: string, live: Live): void {
		this.#sql.exec("DELETE FROM pim_note_updates WHERE artifact = ?", note);
		this.#sql.exec("INSERT INTO pim_note_updates (artifact, data) VALUES (?, ?)", note, toBuffer(Y.encodeStateAsUpdate(live.doc)));
		live.rows = 1;
	}

	#saveState(note: string, live: Live): void {
		this.#sql.exec(
			"INSERT INTO pim_notes (artifact, base, dirty) VALUES (?, ?, ?) ON CONFLICT (artifact) DO UPDATE SET base = excluded.base, dirty = excluded.dirty",
			note,
			live.base,
			live.dirty ? 1 : 0,
		);
	}

	/** Keeps the live text as a new version, which is now the text's base. */
	async #save(note: string, live: Live, input: { source: ArtifactSource }): Promise<void> {
		const edits = live.edits;
		const content = live.text.toString();
		const latest = this.#artifacts.get(note)!;
		const { version, changed } = await this.#artifacts.append(note, { baseVersion: latest.version, content, source: input.source });
		live.base = version.version;
		// Writing that came in while the version was stored waits for the next one.
		if (live.edits === edits) live.dirty = false;
		this.#saveState(note, live);
		if (changed) this.#notify(note, { type: "version", version: version.version });
	}

	/** Makes the live text what `version` says. */
	async #adopt(note: string, live: Live, version: number): Promise<void> {
		const content = await this.#artifacts.text(note, version);
		live.doc.transact(() => replaceText(live.text, content), "version" satisfies ServerOrigin);
		live.base = version;
		live.dirty = false;
		this.#saveState(note, live);
	}

	#broadcast(note: string, data: Uint8Array, except?: string): void {
		for (const peer of this.#peers(note)) {
			if (peer.id !== except) peer.send(data);
		}
	}

	#notify(note: string, notice: NoteNotice): void {
		const message = JSON.stringify(notice);
		for (const peer of this.#peers(note)) peer.send(message);
	}
}

function isPeer(origin: unknown): origin is NotePeer {
	return typeof origin === "object" && origin !== null && typeof (origin as NotePeer).id === "string";
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.slice().buffer;
}

/** The clients an awareness update speaks for, with their clocks. */
function awarenessClients(update: Uint8Array): Map<number, number> {
	const clients = new Map<number, number>();
	const decoder = decoding.createDecoder(update);
	const count = decoding.readVarUint(decoder);
	for (let i = 0; i < count; i++) {
		const client = decoding.readVarUint(decoder);
		const clock = decoding.readVarUint(decoder);
		decoding.readVarString(decoder);
		clients.set(client, clock);
	}
	return clients;
}

/** An awareness message saying these clients left, as y-protocols' own removal does. */
function removal(clients: ReadonlyMap<number, number>): Uint8Array {
	const update = encoding.createEncoder();
	encoding.writeVarUint(update, clients.size);
	for (const [client, clock] of clients) {
		encoding.writeVarUint(update, client);
		encoding.writeVarUint(update, clock + 1);
		encoding.writeVarString(update, "null");
	}
	const message = encoding.createEncoder();
	encoding.writeVarUint(message, AWARENESS);
	encoding.writeVarUint8Array(message, encoding.toUint8Array(update));
	return encoding.toUint8Array(message);
}

/** `text` with `addition` after it, on a line of its own. */
function appended(text: string, addition: string): string {
	return text === "" || text.endsWith("\n") ? text + addition : `${text}\n${addition}`;
}

/** Makes `text` say `target`, changing only what differs between them, so others' cursors stay where they were. */
export function replaceText(text: Y.Text, target: string): void {
	splice(text, 0, text.toString(), target);
}

/** Changes `from`, at `index` in `text`, into `to`, touching only the part between what they share at each end. */
function splice(text: Y.Text, index: number, from: string, to: string): void {
	let start = 0;
	const shortest = Math.min(from.length, to.length);
	while (start < shortest && from[start] === to[start]) start++;
	// Never between the halves of a surrogate pair.
	if (start > 0 && isHighSurrogate(from.charCodeAt(start - 1))) start--;
	let end = 0;
	while (end < shortest - start && from[from.length - 1 - end] === to[to.length - 1 - end]) end++;
	if (end > 0 && isLowSurrogate(from.charCodeAt(from.length - end))) end--;
	const removed = from.length - start - end;
	if (removed > 0) text.delete(index + start, removed);
	const inserted = to.slice(start, to.length - end);
	if (inserted !== "") text.insert(index + start, inserted);
}

/**
 * Applies find-and-replace edits to the live text, one after another,
 * where each find is now; if one no longer matches exactly once (the person
 * changed that very text meanwhile), the text becomes `after`, the result
 * the edits were checked against.
 */
function applyEditsTo(text: Y.Text, edits: readonly { find: string; replace: string }[], after: string): void {
	for (const { find, replace } of edits) {
		const current = text.toString();
		const at = current.indexOf(find);
		if (at === -1 || current.indexOf(find, at + 1) !== -1) {
			replaceText(text, after);
			return;
		}
		splice(text, at, find, replace);
	}
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}
