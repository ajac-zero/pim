// What an Amp thread pushed, found as v1 found it: Pim never sees the orb's git, so what the agent said it pushed (a branch the host has, or a commit it has) is what its diff, pull request and merge follow.
import { checkBranch } from "@pim/coding/git-broker/broker";
import { type OrbMessage } from "@pim/coding/orb/types";
import { type Db } from "./db";
import { type GitHost } from "./ports";
import { type ThreadRow } from "./store";

/** What an orb message says, with the steps it took: a push is more often in a command or its output than in the agent's words. */
export const orbMessageText = (m: OrbMessage): string =>
	[m.text, ...(m.parts ?? []).map((p) => (p.type === "toolCall" ? JSON.stringify(p.arguments) : p.type === "toolResult" ? p.text : ""))]
		.filter(Boolean)
		.join("\n")
		.slice(0, 20_000);

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The branch or commit the agent said it pushed, newest message first: a branch the host has, other than the one the thread started from (the default branch, or the one it started on, only when the agent showed a push to it
 * with `-> name`), else a commit the host has, of the few the messages name. Null when there is none.
 */
export async function pushedByAgent(o: { texts: readonly string[]; branches: ReadonlyMap<string, string>; from: string | null; defaultBranch: string; baseRef: string | null; resolveCommit?: (ref: string) => Promise<string | null> }): Promise<string | null> {
	const names = [...o.branches.keys()].sort((a, b) => b.length - a.length);
	const mentions = (text: string, name: string) => text.includes(name) && new RegExp(`(?<![A-Za-z0-9._/-])${escaped(name)}(?![A-Za-z0-9._/-])`).test(text);
	for (const text of o.texts) {
		for (const name of names) {
			if (o.branches.get(name) === o.from || !mentions(text, name)) continue;
			if ((name === o.defaultBranch || name === o.baseRef) && !text.includes(`-> ${name}`)) continue;
			return name;
		}
	}
	let checked = 0;
	for (const text of o.texts) {
		if (!/push|origin|HEAD/i.test(text)) continue;
		for (const candidate of text.match(/(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g) ?? []) {
			if (!/\d/.test(candidate) || o.from?.startsWith(candidate) || checked >= 3) continue;
			checked++;
			const sha = await o.resolveCommit?.(candidate).catch(() => null);
			if (sha && sha !== o.from) return sha;
		}
	}
	return null;
}

/** A commit ID, which names no branch: a thread's diff may follow one, but no write is ever made to it. */
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Why a branch the orb is said to have pushed may not be followed by this thread, or null when it may. An Amp thread chooses its own branch names, so Pim does not name them; what keeps it
 * from following someone else's branch, or from merging into anything it did not make, is what the thread itself shows: the name is an ordinary valid branch that is not the default branch
 * (`checkBranch`), it did not exist on the git host when the thread began (`orb.baseline`, taken before the thread was started), and no other thread, of anyone, follows it. A thread whose
 * baseline could not be taken follows nothing.
 */
export async function refuseOrbBranch(c: { db: Db; git?: GitHost | undefined }, t: ThreadRow, branch: string): Promise<string | null> {
	if (COMMIT.test(branch)) return null;
	try {
		checkBranch(branch, c.git ? await c.git.defaultBranch(t.repo) : null);
	} catch (error) {
		return error instanceof Error ? error.message : "that isn't a branch Pim may follow";
	}
	const baseline = t.orb?.baseline;
	if (!Array.isArray(baseline)) return "the branches that existed when this thread began are not known";
	if (baseline.includes(branch) && branch !== t.orb?.branch) return `${branch} existed before this thread began`;
	const taken = await c.db.query("select 1 from pim_forge.forge_threads where thread_id <> $1 and lower(repo) = lower($2) and (branch = $3 or orb ->> 'branch' = $3) limit 1", [t.threadId, t.repo, branch]);
	return taken.rows.length ? `${branch} belongs to another thread` : null;
}
