import * as Y from "yjs";
import { Authorizer, principalId } from "./authz.ts";
import type { Db, Tx } from "./db.ts";
import { ConflictError, NotFoundError } from "./errors.ts";
import { newId } from "./ids.ts";
import type { Principal } from "@pim/v2-contracts/identity";
import type { ObjectStore } from "@pim/v2-contracts/platform";

/** The text inside a note's document, named as the Worker's notes name it so imported documents open unchanged. */
const TEXT = "markdown";
export const LEASE_MS = 15_000;
/** After this many logged updates a snapshot is written to the object store and the log before it is dropped. */
export const COMPACT_AFTER = 200;
/** How long a person's typing in a live note must stop before what they wrote becomes a kept version. */
export const PAUSE_MS = 5_000;

export type KeptSource = "person" | "agent" | "restore";
export type KeptVersion = { version: number; text: string; source: KeptSource; restoredFrom: number | null; createdAt: Date };

export class LeaseLostError extends ConflictError {
	constructor() {
		super("This writer no longer holds the note's document lease", "lease_lost");
	}
}

export type Lease = { noteId: string; holder: string; fence: number };

/**
 * Canvas: collaborative notes as Yjs documents. PostgreSQL holds the ordered update log and the lease; snapshots go to the object store.
 * Each append is checked against the lease's fence in the same statement, so a writer whose lease was taken over cannot add an update.
 * The live text is the truth; a version is what it said at a moment worth keeping (`keep`): when the person pauses or closes the note, before and
 * after each agent change, and on restore. The version people and agents see is that kept number. An edit tool reads a version and edits with it,
 * and the person's typing since makes a newer kept version, so the edit is a conflict the caller resolves by reading again. `notes.version`
 * only counts the log's updates. Live typing is never lost: edits are Yjs updates merged into the log, not replacements of it.
 */
export class Canvas {
	/** `instance` names this service process: every writer in it (live editors, note tools) shares one lease holder, so they never block each other, while another process taking over fences this one out. */
	constructor(private readonly db: Db, private readonly store: ObjectStore, readonly instance = newId("canvas"), private readonly authz = new Authorizer(db)) {}

	/** How long a live editor's typing pauses before it is kept; a field so a test can shorten it. */
	pauseMs = PAUSE_MS;

	readonly #listeners = new Set<(noteId: string, update: Uint8Array, origin: string) => void>();

	/** Hears every update this process appends to any note, with where it came from: live editors broadcast what their peers and agents wrote. */
	onUpdate(listener: (noteId: string, update: Uint8Array, origin: string) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async create(p: Principal, title: string, text = "", source: KeptSource = "person"): Promise<string> {
		await this.authz.enforce(p, "api:write");
		const id = newId("n");
		await this.db.owner(p.ownerId, async (tx) => {
			await tx.query("INSERT INTO pim_app.notes (note_id, owner_id, title) VALUES ($1, $2, $3)", [id, p.ownerId, title]);
		});
		if (text) await this.#withLease(p.ownerId, id, async (lease) => {
			const doc = new Y.Doc();
			doc.getText(TEXT).insert(0, text);
			await this.append(p.ownerId, lease, Y.encodeStateAsUpdate(doc), `user:${principalId(p)}`);
		});
		await this.keep(p.ownerId, id, source);
		return id;
	}

	/** Takes (or renews) the document lease. Another live holder blocks it; an expired one is taken over with a higher fence. */
	async acquire(ownerId: string, noteId: string, holder: string, now = new Date()): Promise<Lease> {
		return this.db.owner(ownerId, async (tx) => {
			if (!(await tx.query("SELECT 1 FROM pim_app.notes WHERE note_id = $1 AND deleted_at IS NULL", [noteId])).rowCount) throw new NotFoundError("No such note");
			const { rows } = await tx.query(
				`INSERT INTO pim_app.note_leases (owner_id, note_id, holder, fence, expires_at) VALUES ($1, $2, $3, 1, $4)
				 ON CONFLICT (owner_id, note_id) DO UPDATE SET holder = $3, expires_at = $4,
				   fence = CASE WHEN pim_app.note_leases.holder = $3 THEN pim_app.note_leases.fence ELSE pim_app.note_leases.fence + 1 END
				 WHERE pim_app.note_leases.holder = $3 OR pim_app.note_leases.expires_at <= $5
				 RETURNING fence`,
				[ownerId, noteId, holder, new Date(now.getTime() + LEASE_MS), now],
			);
			if (!rows[0]) throw new ConflictError("Another writer holds this note right now", "lease_held");
			return { noteId, holder, fence: Number(rows[0].fence) };
		});
	}

	async release(ownerId: string, lease: Lease): Promise<void> {
		await this.db.owner(ownerId, (tx) => tx.query("UPDATE pim_app.note_leases SET expires_at = now() WHERE note_id = $1 AND holder = $2 AND fence = $3", [lease.noteId, lease.holder, lease.fence]));
	}

	/** Renews this process's lease for the duration of the call; it is kept until it expires so a burst of edits pays for one takeover. */
	async #withLease<T>(ownerId: string, noteId: string, fn: (lease: Lease) => Promise<T>): Promise<T> {
		return fn(await this.acquire(ownerId, noteId, this.instance));
	}

	/** Appends a Yjs update if the lease's fence is still current, and returns the new version. */
	async append(ownerId: string, lease: Lease, update: Uint8Array, origin: string): Promise<number> {
		const version = await this.db.owner(ownerId, async (tx) => {
			const cur = await tx.query("SELECT l.fence, n.version FROM pim_app.note_leases l JOIN pim_app.notes n USING (owner_id, note_id) WHERE l.note_id = $1 AND l.holder = $2 FOR UPDATE OF n", [lease.noteId, lease.holder]);
			if (!cur.rows[0] || Number(cur.rows[0].fence) !== lease.fence) throw new LeaseLostError();
			const version = Number(cur.rows[0].version);
			await tx.query("INSERT INTO pim_app.note_updates (owner_id, note_id, seq, data, origin, fence) VALUES ($1,$2,$3,$4,$5,$6)", [ownerId, lease.noteId, version + 1, Buffer.from(update), origin, lease.fence]);
			await tx.query("UPDATE pim_app.notes SET version = $2 WHERE note_id = $1", [lease.noteId, version + 1]);
			return version + 1;
		});
		for (const listener of this.#listeners) listener(lease.noteId, update, origin);
		if (version % COMPACT_AFTER === 0) await this.compact(ownerId, lease.noteId).catch(() => undefined);
		return version;
	}

	async #load(tx: Tx, noteId: string): Promise<{ doc: Y.Doc; kept: number; seq: number }> {
		const note = (await tx.query("SELECT version, kept_version, snapshot_key, snapshot_seq FROM pim_app.notes WHERE note_id = $1 AND deleted_at IS NULL", [noteId])).rows[0];
		if (!note) throw new NotFoundError("No such note");
		const doc = new Y.Doc();
		if (note.snapshot_key) {
			const snapshot = await this.store.get(note.snapshot_key);
			if (!snapshot) throw new Error(`The snapshot of note ${noteId} is missing from the object store`);
			Y.applyUpdate(doc, snapshot.body);
		}
		for (const row of (await tx.query("SELECT data FROM pim_app.note_updates WHERE note_id = $1 AND seq > $2 ORDER BY seq", [noteId, note.snapshot_seq])).rows) Y.applyUpdate(doc, row.data);
		return { doc, kept: Number(note.kept_version), seq: Number(note.version) };
	}

	/** The live text and the latest kept version, which may be older than the text while someone is typing. A note with no kept version keeps its text as version 1. */
	async read(ownerId: string, noteId: string): Promise<{ text: string; version: number }> {
		const { text, kept } = await this.db.owner(ownerId, async (tx) => {
			const { doc, kept } = await this.#load(tx, noteId);
			return { text: doc.getText(TEXT).toString(), kept };
		});
		return { text, version: kept || (await this.keep(ownerId, noteId, "person")) };
	}

	/**
	 * Keeps the note's live text as a new version, unless the latest kept version already says it, and returns the latest kept version. The row
	 * lock is the one `append` takes, so what is kept is a whole state of the log.
	 */
	async keep(ownerId: string, noteId: string, source: KeptSource, restoredFrom: number | null = null): Promise<number> {
		return this.db.owner(ownerId, async (tx) => {
			await tx.query("SELECT 1 FROM pim_app.notes WHERE note_id = $1 FOR UPDATE", [noteId]);
			const { doc, kept } = await this.#load(tx, noteId);
			const text = doc.getText(TEXT).toString();
			if (kept && (await tx.query("SELECT 1 FROM pim_app.note_versions WHERE note_id = $1 AND version = $2 AND text = $3", [noteId, kept, text])).rowCount) return kept;
			await tx.query("INSERT INTO pim_app.note_versions (owner_id, note_id, version, text, source, restored_from) VALUES ($1, $2, $3, $4, $5, $6)", [ownerId, noteId, kept + 1, text, source, restoredFrom]);
			await tx.query("UPDATE pim_app.notes SET kept_version = $2 WHERE note_id = $1", [noteId, kept + 1]);
			return kept + 1;
		});
	}

	/** The kept versions of a note, newest first. */
	async versions(ownerId: string, noteId: string): Promise<KeptVersion[]> {
		await this.read(ownerId, noteId);
		return this.db.owner(ownerId, async (tx) =>
			(await tx.query("SELECT version, text, source, restored_from, created_at FROM pim_app.note_versions WHERE note_id = $1 ORDER BY version DESC", [noteId])).rows.map((r) => ({ version: Number(r.version), text: r.text, source: r.source, restoredFrom: r.restored_from ?? null, createdAt: r.created_at })));
	}

	/** The state a live editor's Yjs provider starts from. */
	async state(ownerId: string, noteId: string): Promise<{ update: Uint8Array; version: number }> {
		return this.db.owner(ownerId, async (tx) => {
			const { doc, kept } = await this.#load(tx, noteId);
			return { update: Y.encodeStateAsUpdate(doc), version: kept };
		});
	}

	/** A live editor's update (typing). Holds the lease for the editor and merges into the log whatever else was written meanwhile. */
	async applyLive(ownerId: string, noteId: string, editor: string, update: Uint8Array): Promise<number> {
		return this.#withLease(ownerId, noteId, (lease) => this.append(ownerId, lease, update, `user:${editor}`));
	}

	/**
	 * note_edit: replaces the first occurrence of `find` with `replace`, only if the note is still at the kept version `baseVersion`. What the person has
	 * typed since is kept first, so it makes a newer version and the edit is refused. The change is made as a Yjs delete and insert on the current
	 * document, so characters a person typed elsewhere in the note stay, and the result is kept as the agent's version.
	 */
	async edit(p: Principal, noteId: string, baseVersion: number, find: string, replace: string): Promise<{ version: number }> {
		await this.authz.enforce(p, "api:write");
		return this.#withLease(p.ownerId, noteId, async (lease) => {
			const current = await this.keep(p.ownerId, noteId, "person");
			if (current !== baseVersion) throw new ConflictError(`The note changed (version ${current}, you edited ${baseVersion}); read it again`, "version_conflict");
			await this.#replace(p, lease, (text) => {
				const at = text.toString().indexOf(find);
				if (at < 0) throw new ConflictError("That text is not in the note", "text_not_found");
				return [at, find.length, replace];
			});
			return { version: await this.keep(p.ownerId, noteId, "agent") };
		});
	}

	/** Makes an earlier kept version the live text again, as a new version: what the person had is kept first, and nothing is lost. */
	async restore(p: Principal, noteId: string, version: number): Promise<{ version: number }> {
		await this.authz.enforce(p, "api:write");
		return this.#withLease(p.ownerId, noteId, async (lease) => {
			await this.read(p.ownerId, noteId);
			const target = (await this.versions(p.ownerId, noteId)).find((v) => v.version === version);
			if (!target) throw new NotFoundError("No such version");
			await this.keep(p.ownerId, noteId, "person");
			await this.#replace(p, lease, (text) => [0, text.length, target.text]);
			return { version: await this.keep(p.ownerId, noteId, "restore", version) };
		});
	}

	/** Deletes and inserts text in the live document as the Yjs update the log and the editors take. */
	async #replace(p: Principal, lease: Lease, where: (text: Y.Text) => [at: number, length: number, insert: string]): Promise<void> {
		const { doc } = await this.db.owner(p.ownerId, (tx) => this.#load(tx, lease.noteId));
		const text = doc.getText(TEXT);
		const [at, length, insert] = where(text);
		let captured: Uint8Array | null = null;
		doc.on("update", (u: Uint8Array) => {
			captured = u;
		});
		doc.transact(() => {
			text.delete(at, length);
			text.insert(at, insert);
		});
		if (captured) await this.append(p.ownerId, lease, captured, `agent:${principalId(p)}`);
	}

	/** Writes a snapshot to the object store and drops the log before it. */
	async compact(ownerId: string, noteId: string): Promise<void> {
		const { doc, seq: version } = await this.db.owner(ownerId, (tx) => this.#load(tx, noteId));
		const key = `${ownerId}/notes/${noteId}/${version}.snapshot`;
		await this.store.put(key, Y.encodeStateAsUpdate(doc), { contentType: "application/octet-stream" });
		await this.db.owner(ownerId, async (tx) => {
			const n = await tx.query("UPDATE pim_app.notes SET snapshot_key = $2, snapshot_seq = $3 WHERE note_id = $1 AND snapshot_seq < $3", [noteId, key, version]);
			if (n.rowCount) await tx.query("DELETE FROM pim_app.note_updates WHERE note_id = $1 AND seq <= $2", [noteId, version]);
		});
	}
}
