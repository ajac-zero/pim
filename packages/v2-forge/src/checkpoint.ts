// What a thread's checkout holds that nothing else does: its commits, and the work its agent left uncommitted. A checkpoint commits that work on the thread's branch (as v1 did when a turn ended), so a push, an
// autosave bundle and a diff all see it; each checkpoint is recorded with its diff from the thread's base, which stays readable after the sandbox is gone.
import { type ComputeHandle, type ComputeProvider } from "./compute";
import { type Queryable, type Row } from "./db";
import { type ForgeStore, type ThreadRow } from "./store";
import { REPO_DIR } from "./git-checkout";

/** The most of a diff that is kept and shown: 256 KiB, as v1 kept. */
export const MAX_DIFF_CHARS = 256 * 1024;

export type CheckpointDeps = { db: Queryable; compute: ComputeProvider; /** Where the checkout is in the sandbox; `/workspace/repo` unless a provider lays it out otherwise. */ repoDir?: string };
export type Checkpoint = { seq: number; sha: string; message: string };

const IDENTITY = ["-c", "user.name=Pim", "-c", "user.email=coding@pim.invalid"];

export const gitIn = (d: CheckpointDeps, handle: ComputeHandle, args: readonly string[], timeoutMs = 120_000) => d.compute.exec(handle, ["git", ...IDENTITY, ...args], { cwd: d.repoDir ?? REPO_DIR, timeoutMs });

/** The diff of `from` to `to` (or to the work tree when `to` is null), cut at the limit. */
export async function makeDiff(d: CheckpointDeps, handle: ComputeHandle, from: string, to: string | null): Promise<{ diff: string; truncated: boolean } | null> {
	const r = await gitIn(d, handle, ["diff", from, ...(to ? [to] : [])]);
	if (r.code !== 0) return null;
	return { diff: r.stdout.slice(0, MAX_DIFF_CHARS), truncated: r.stdout.length > MAX_DIFF_CHARS };
}

/** Keeps a diff of the thread's work from `since` to `head`: what `Forge.diff` answers once the sandbox is gone. */
export async function keepDiff(db: Queryable, threadId: string, d: { since: string | null; head: string | null; diff: string; truncated: boolean; source?: "workspace" | "orb"; unpushedOrb?: boolean }): Promise<void> {
	await db.query("insert into pim_forge.forge_diffs (thread_id, seq, source, unpushed_orb, diff, files) select $1, coalesce(max(seq), 0) + 1, $2, $3, $4, $5 from pim_forge.forge_diffs where thread_id = $1", [threadId, d.source ?? "workspace", d.unpushedOrb ?? false, d.diff, JSON.stringify({ since: d.since, head: d.head, truncated: d.truncated })]);
}

/**
 * The commit the thread started from, found when it wasn't recorded (the clone's branch point on the host's default branch) and kept. Null when the checkout can't say.
 */
export async function ensureBase(d: CheckpointDeps, store: ForgeStore, t: ThreadRow): Promise<ThreadRow> {
	if (t.baseSha || !t.workspaceRef) return t;
	const r = await gitIn(d, t.workspaceRef, ["merge-base", "HEAD", "origin/HEAD"]);
	const sha = r.code === 0 ? r.stdout.trim() : "";
	if (!sha) return t;
	await store.locked(t.threadId, (q) => store.patch(q, t.threadId, { base_sha: sha }));
	return { ...t, baseSha: sha };
}

/** The newest checkpoint of a thread. */
export async function latestCheckpoint(db: Queryable, threadId: string): Promise<Checkpoint | null> {
	const r = (await db.query<Row>("select seq, sha, label from pim_forge.forge_checkpoints where thread_id = $1 order by seq desc limit 1", [threadId])).rows[0];
	return r ? { seq: Number(r.seq), sha: r.sha, message: r.label ?? "" } : null;
}

/**
 * Commits whatever changed in the thread's workspace as a checkpoint and keeps its diff from the base. Null when nothing changed (no edits, and no commit past the last checkpoint or the base) or there is
 * no repository to look at. The agent may have committed its work itself, leaving the tree clean: that is a change too.
 */
export async function checkpointWorkspace(d: CheckpointDeps, t: ThreadRow, operation: string | null): Promise<Checkpoint | null> {
	const handle = t.workspaceRef as ComputeHandle | null;
	if (!handle) return null;
	const status = await gitIn(d, handle, ["status", "--porcelain"]);
	if (status.code !== 0) return null;
	const dirty = status.stdout.trim() !== "";
	const headResult = await gitIn(d, handle, ["rev-parse", "HEAD"]);
	const head = headResult.stdout.trim();
	if (headResult.code !== 0 || !head) return null;
	const last = (await latestCheckpoint(d.db, t.threadId))?.sha ?? t.baseSha;
	if (!dirty && (head === last || last === null)) return null;
	const count = Number((await d.db.query<Row>("select count(*) as n from pim_forge.forge_checkpoints where thread_id = $1", [t.threadId])).rows[0]!.n);
	const message = `Checkpoint ${count + 1}${operation ? ` (${operation})` : ""}`;
	if (dirty) {
		await gitIn(d, handle, ["add", "-A"]);
		const committed = await gitIn(d, handle, ["commit", "--no-verify", "-m", message]);
		if (committed.code !== 0) return null;
	}
	const sha = (await gitIn(d, handle, ["rev-parse", "HEAD"])).stdout.trim();
	if (!sha) return null;
	const seq = Number((await d.db.query<Row>("insert into pim_forge.forge_checkpoints (thread_id, seq, sha, label) select $1, coalesce(max(seq), 0) + 1, $2, $3 from pim_forge.forge_checkpoints where thread_id = $1 returning seq", [t.threadId, sha, message])).rows[0]!.seq);
	if (t.baseSha) {
		const made = await makeDiff(d, handle, t.baseSha, sha);
		if (made) await keepDiff(d.db, t.threadId, { since: t.baseSha, head: sha, ...made });
	}
	return { seq, sha, message };
}

/**
 * A git bundle of the checkout goes to Objects; PostgreSQL keeps only the row that finds it. The next sandbox of the thread is restored from it (git-checkout.ts), so what an idle sandbox held isn't lost.
 * Commit first (`checkpointWorkspace`): a bundle holds commits, not an edited tree.
 */
export async function autosaveWorkspace(d: CheckpointDeps & { objects: { put(key: string, body: Uint8Array, o: { contentType: string }): Promise<unknown> } }, t: ThreadRow): Promise<void> {
	const handle = t.workspaceRef as ComputeHandle | null;
	if (!handle) return;
	const exec = (cmd: string[]) => d.compute.exec(handle, cmd, { cwd: d.repoDir ?? REPO_DIR, timeoutMs: 120_000 });
	const r = await exec(["sh", "-c", "git bundle create ../autosave.bundle HEAD >&2 && base64 -w0 ../autosave.bundle"]);
	if (r.code !== 0) return;
	const bytes = Buffer.from(r.stdout, "base64");
	const head = (await exec(["git", "rev-parse", "HEAD"])).stdout.trim();
	const key = `forge/${t.threadId}/autosave/${head}.bundle`;
	await d.objects.put(key, bytes, { contentType: "application/x-git-bundle" });
	await d.db.query("insert into pim_forge.forge_autosaves (thread_id, head_sha, object_key, bytes) values ($1,$2,$3,$4) on conflict (thread_id) do update set head_sha = $2, object_key = $3, bytes = $4, at = now()", [t.threadId, head, key, bytes.length]);
}
