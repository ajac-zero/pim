// What an agent-hosted thread did to a repository, as Pim finds out from
// git itself. The thread's agent runs in the vendor's cloud and may push
// with its own credentials — to a branch of its own, to another one, even
// to the repository's default branch — none of which Pim can prevent,
// because none of those pushes is Pim's (the broker never proxies
// receive-pack; ../git-broker/broker.ts). All Pim can do is look
// afterwards: read the repository's refs, compare them with what they were,
// and say what moved, whose commits moved it and whether anything rewrote
// history. Nothing here takes the agent's word: the refs, the commits and
// the diff are Pim's own reads of the repository.
//
// Every read goes through `RefReader`, the seam a later slice fills with a
// reader that reaches the repository as the broker's read path does (git's
// smart-HTTP advertisement with the GitHub App's read-only installation
// token for the refs, and the git machinery for commits and diffs). Tests
// use an in-memory fake (./fake-refs.ts). Nothing here is wired into a
// thread's loop yet: this slice is the pure module, the fake and the thin
// `checkRefs` a later slice calls around a thread's turn.

import type { RepoRef } from "../git-broker/broker";

/** The most commits one branch's report lists; more than that sets `truncated`. */
export const MAX_REPORT_COMMITS = 50;

/** The largest diff `orbDiff` returns, whole before that; the rest is cut and `truncated` says so. */
export const MAX_ORB_DIFF_CHARS = 256 * 1024;

/** A commit id as git prints it: SHA-1's 40 hex digits, or SHA-256's 64. */
const SHA = /^[0-9a-f]{40,64}$/;

/** A commit of the repository, as Pim reads it from git: who made it and what it says, never the agent's word for either. */
export type OrbCommit = {
	readonly sha: string;
	/** The commit's author, as git reports it: a name, or a name and an email address. Null when the reader can't say. */
	readonly author: string | null;
	/** The commit's message, as the reader gives it: its subject line or the whole text. */
	readonly message: string;
};

/**
 * How Pim reads a repository's refs, commits and diffs. The real one, a
 * later slice, reads through the broker's read path; tests use the
 * in-memory fake (./fake-refs.ts). Every method takes the repository, and
 * every answer is Pim's own read of the remote, never the agent's word.
 */
export interface RefReader {
	/** The repository's refs as they are now: every branch by its full ref name (`refs/heads/…`), and the repository's default branch by name. */
	snapshot(repo: RepoRef): Promise<{ readonly refs: ReadonlyMap<string, string>; readonly defaultBranch: string }>;
	/** The commit a branch or full ref names, or null when the repository doesn't have it. */
	resolve(repo: RepoRef, ref: string): Promise<string | null>;
	/** Whether every commit `base` names is in `head`'s history: a ref's move from one to the other is then forward only. */
	isAncestor(repo: RepoRef, base: string, head: string): Promise<boolean>;
	/** The commits `head` has that `base` doesn't, oldest first: what a branch moved by, with who made them. */
	commits(repo: RepoRef, base: string, head: string): Promise<readonly OrbCommit[]>;
	/** Pim's own unified diff of `head` against `base`, as `git diff` makes it, whole: `orbDiff` is what caps it. */
	diff(repo: RepoRef, base: string, head: string): Promise<string>;
}

/** The repository's refs at one moment: its branches, by name, and its default branch. What `snapshotRefs` returns and `compareRefs` takes. */
export type RefSnapshot = {
	/** The repository the refs are of. */
	readonly repo: RepoRef;
	/** The repository's default branch, by name. */
	readonly defaultBranch: string;
	/** Its branches by name (a ref's name without `refs/heads/`), each at the commit it names. */
	readonly branches: ReadonlyMap<string, string>;
};

/**
 * The repository's refs as they are now, read through `reader` and pared
 * to its branches: only `refs/heads/*`, each sha checked, named without
 * the prefix. This is one half of what a thread keeps around a turn: the
 * snapshot before it, for `compareRefs` with the one after.
 */
export async function snapshotRefs(reader: RefReader, repo: RepoRef): Promise<RefSnapshot> {
	const { refs, defaultBranch } = await reader.snapshot(repo);
	const branches = new Map<string, string>();
	for (const [ref, sha] of refs) {
		if (!ref.startsWith("refs/heads/")) continue;
		const branch = ref.slice("refs/heads/".length);
		if (branch === "" || !SHA.test(sha)) throw new Error(`The reader gave ${ref} as ${JSON.stringify(sha.slice(0, 12))}, which isn't a commit id`);
		branches.set(branch, sha);
	}
	return { repo, defaultBranch, branches };
}

/**
 * What Pim says of one branch between two snapshots. `moved` is whether it
 * moved at all — a branch that appeared or disappeared moved too — and
 * `state` is how. The commits are the ones the branch moved by, oldest
 * first and at most `MAX_REPORT_COMMITS` of them; a branch that is new has
 * no before to count them from and one that is deleted no after, so both
 * list none, and the diff to look at is the thread's own (`orbDiff`).
 */
export type BranchReport = {
	/** The branch's name, as git prints it without `refs/heads/`. */
	readonly branch: string;
	/** Where the branch was in the earlier snapshot: its commit, or null when it didn't exist. */
	readonly before: string | null;
	/** Where it is in the later one: its commit, or null when it is gone. */
	readonly after: string | null;
	/** Whether it moved at all. */
	readonly moved: boolean;
	/** How it moved, when it did; null when it didn't. */
	readonly state: "moved" | "new" | "deleted" | null;
	/** The commits it moved by, oldest first, capped at `MAX_REPORT_COMMITS`. */
	readonly commits: readonly OrbCommit[];
	/** Whether it moved by more commits than `commits` lists. */
	readonly truncated: boolean;
	/** How many commits it moved by, counted past the cap. */
	readonly commitCount: number;
	/** Whether it moved backwards: its new commit doesn't have the old one in its history. */
	readonly forcePushed: boolean;
};

/** What Pim found by comparing two snapshots of a repository's refs: the honest report of what the remote moved, and whose commits did it. */
export type RefReport = {
	/** The repository, as `owner/name`. */
	readonly repo: string;
	/** Its default branch, whose movement is the one Pim most needs to show. */
	readonly defaultBranch: BranchReport;
	/** Every other branch that moved, was made or was deleted, by name: the thread's own `pim/*` branch among them. */
	readonly branches: readonly BranchReport[];
	/** Whether any ref moved without the old commit being in the new one's history: a force push, which rewrites history rather than adding to it. */
	readonly forcePushed: boolean;
};

/**
 * What changed between two snapshots of a repository's refs: the default
 * branch and every other branch that moved, was made or was deleted, with
 * the commits each moved by and whether any move rewrote history. A branch
 * that is where it was isn't reported; nothing is inferred about who moved
 * what — the commits say their authors, and the wording of a report
 * (`describeRefReport`) is what says what Pim can't know.
 */
export async function compareRefs(reader: RefReader, before: RefSnapshot, after: RefSnapshot): Promise<RefReport> {
	if (before.repo.fullName !== after.repo.fullName) throw new Error(`Can't compare ${after.repo.fullName}'s refs with ${before.repo.fullName}'s`);
	const repo = after.repo;
	const reportOf = async (branch: string): Promise<BranchReport> => {
		const from = before.branches.get(branch) ?? null;
		const to = after.branches.get(branch) ?? null;
		const moved = from !== to;
		const state = !moved ? null : from === null ? "new" : to === null ? "deleted" : "moved";
		const gained = state === "moved" ? await reader.commits(repo, from!, to!) : [];
		const forcePushed = state === "moved" && !(await reader.isAncestor(repo, from!, to!));
		return {
			branch,
			before: from,
			after: to,
			moved,
			state,
			commits: gained.slice(0, MAX_REPORT_COMMITS),
			truncated: gained.length > MAX_REPORT_COMMITS,
			commitCount: gained.length,
			forcePushed,
		};
	};
	const defaultBranch = await reportOf(after.defaultBranch);
	const names = new Set<string>([...before.branches.keys(), ...after.branches.keys()]);
	names.delete(after.defaultBranch);
	const branches: BranchReport[] = [];
	for (const name of [...names].sort()) {
		const report = await reportOf(name);
		if (report.moved) branches.push(report);
	}
	return { repo: repo.fullName, defaultBranch, branches, forcePushed: defaultBranch.forcePushed || branches.some((branch) => branch.forcePushed) };
}

/** The numbers of a diff, counted from its text: how many files it touches and lines it adds and removes. */
export type DiffStat = {
	readonly files: number;
	readonly additions: number;
	readonly deletions: number;
};

/**
 * The numbers of a diff's text, counted as `git diff --stat` would: a file
 * per `diff --git` line, an addition per line that starts with `+` and a
 * deletion per one that starts with `-`, not counting the lines that name
 * the files. Counted from the whole diff, before any cap cuts it.
 */
export function diffStat(diff: string): DiffStat {
	let files = 0;
	let additions = 0;
	let deletions = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("diff --git ")) files++;
		else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
		else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
	}
	return { files, additions, deletions };
}

/** Pim's own diff of what an agent-hosted thread produced, read from git, never taken from the agent's word for it. */
export type OrbDiff = {
	/** The commit the diff is from: the thread's base, as Pim knows it. */
	readonly base: string;
	/** The ref the diff is to, as it was given. */
	readonly ref: string;
	/** The commit the ref is at: what the diff ends at. */
	readonly head: string;
	/** The whole `git diff` of the two, cut at `MAX_ORB_DIFF_CHARS`. */
	readonly diff: string;
	/** Whether the diff was cut. */
	readonly truncated: boolean;
	/** The numbers of the whole diff, before any cut. */
	readonly stat: DiffStat;
};

/**
 * Pim's own diff of what an agent-hosted thread produced: from the commit
 * the thread started at (`baseSha`) to `headRef` — a branch, with or
 * without `refs/heads/`, or a commit id — as the remote has it now. The
 * same call serves an orb that pushed to the repository's default branch
 * (the diff of what it pushed there) and one that pushed to a branch of
 * its own. Null when the repository no longer has `headRef`; the diff is
 * empty when the ref is at `baseSha`.
 */
export async function orbDiff(reader: RefReader, repo: RepoRef, baseSha: string, headRef: string): Promise<OrbDiff | null> {
	if (!SHA.test(baseSha)) throw new Error(`The diff's base must be a commit id, not ${JSON.stringify(baseSha.slice(0, 12))}`);
	const head = SHA.test(headRef) ? headRef : await reader.resolve(repo, headRef);
	if (head === null) return null;
	const whole = await reader.diff(repo, baseSha, head);
	const truncated = whole.length > MAX_ORB_DIFF_CHARS;
	return {
		base: baseSha,
		ref: headRef,
		head,
		diff: truncated ? whole.slice(0, MAX_ORB_DIFF_CHARS) : whole,
		truncated,
		stat: diffStat(whole),
	};
}

/** What the wording of a report is allowed to say, since Pim can't know who pushed what. */
export type DescribeOptions = {
	/**
	 * The author the thread's agent commits as, such as `Amp <amp@…>`, when
	 * the thread knows it. Commits all by it are called the orb's; any
	 * others, and absent or null, are said to be not necessarily the
	 * orb's. Null (or absent) is the honest default: the thread can't say.
	 */
	readonly orbAuthor?: string | null;
};

/** How many moved branches the wording names before it sums up the rest. */
const DESCRIBED_BRANCHES = 3;

const plural = (count: number) => (count === 1 ? "" : "s");

/** The authors of `commits`, each once, in the order they committed. */
function authors(commits: readonly OrbCommit[]): string[] {
	const named: string[] = [];
	for (const commit of commits) if (commit.author !== null && !named.includes(commit.author)) named.push(commit.author);
	return named;
}

/** Whether the wording may call `entry`'s commits the orb's: only when every one is by the author the thread knows it commits as. */
function orbDid(entry: BranchReport, o: DescribeOptions): boolean {
	return o.orbAuthor != null && o.orbAuthor !== "" && entry.commits.length > 0 && entry.commits.every((commit) => commit.author === o.orbAuthor);
}

function movement(entry: BranchReport, o: DescribeOptions, { isDefault }: { isDefault: boolean }): string {
	const short = (sha: string) => sha.slice(0, 7);
	if (entry.state === "new") return isDefault ? `The default branch ${entry.branch} is new at ${short(entry.after!)}` : `New branch ${entry.branch} at ${short(entry.after!)}`;
	if (entry.state === "deleted") return isDefault ? `The default branch ${entry.branch} is gone` : `The branch ${entry.branch} was deleted`;
	const range = `(${short(entry.before!)}..${short(entry.after!)})`;
	if (orbDid(entry, o)) return `The orb pushed ${entry.commitCount} commit${plural(entry.commitCount)} to ${entry.branch} ${range}`;
	const named = authors(entry.commits);
	const by = named.length === 0 ? "" : ` by ${named.slice(0, 3).join(", ")}${named.length > 3 ? ` and ${named.length - 3} more` : ""}`;
	const core =
		entry.commitCount === 0
			? `${entry.branch} moved from ${short(entry.before!)} to ${short(entry.after!)}`
			: `${entry.branch} moved from ${short(entry.before!)} to ${short(entry.after!)} with ${entry.commitCount} new commit${plural(entry.commitCount)}${by}`;
	// Pim can't know who pushed to the default branch: the commits say their authors, and the wording says so.
	return isDefault && named.length > 0 ? `${core} — not necessarily the orb's` : core;
}

/**
 * The short text of a report, for the thread's notice or status. It says
 * what moved and whose commits did it, never more than Pim can know: it
 * was found by reading the repository afterwards, and nothing was
 * prevented. The default branch moving, and any force push, say so in as
 * many words.
 */
export function describeRefReport(report: RefReport, o: DescribeOptions = {}): string {
	if (!report.defaultBranch.moved && report.branches.length === 0) return "No branch of the repository moved.";
	const parts: string[] = [];
	if (report.defaultBranch.moved) {
		parts.push(`${movement(report.defaultBranch, o, { isDefault: true })}.`);
		// The one thing Pim most needs to say plainly: it found this, it didn't stop it, and it couldn't have.
		parts.push("Pim detected this afterwards; it cannot prevent the orb's own pushes.");
	}
	for (const branch of report.branches.slice(0, DESCRIBED_BRANCHES)) parts.push(`${movement(branch, o, { isDefault: false })}.`);
	const more = report.branches.length - DESCRIBED_BRANCHES;
	if (more > 0) parts.push(`And ${more} more ${more === 1 ? "branch" : "branches"} moved.`);
	const forced = [report.defaultBranch, ...report.branches].filter((branch) => branch.forcePushed);
	if (forced.length > 0) parts.push(`Force-push detected on ${forced.map((branch) => branch.branch).join(", ")}.`);
	return parts.join(" ");
}

/**
 * What a turn of an agent-hosted thread did to the repository: reads the
 * refs now, compares them with the `before` snapshot and returns the
 * report with the short text for the thread's notice. This is the thin
 * function a thread's loop calls around a turn — snapshot before it,
 * `checkRefs` after it — in a later slice; nothing calls it yet.
 */
export async function checkRefs(reader: RefReader, before: RefSnapshot, o: DescribeOptions = {}): Promise<{ readonly report: RefReport; readonly text: string }> {
	const report = await compareRefs(reader, before, await snapshotRefs(reader, before.repo));
	return { report, text: describeRefReport(report, o) };
}
