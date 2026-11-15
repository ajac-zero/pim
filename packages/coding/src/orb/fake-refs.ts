// An in-memory RefReader (./git-check.ts) for tests: repositories with
// linear histories, scripted commit by commit the way pushes, branches and
// force pushes move a real one. No network anywhere — the reader's answers
// are only what the test told the fake, so what a real reader does with a
// real token is not verified here.

import type { RepoRef } from "../git-broker/broker";
import type { OrbCommit, RefReader } from "./git-check";

/** One commit the fake holds, with the parent it was made on and the patch it carries. */
export type FakeCommit = OrbCommit & {
	/** The commit it was made on, or null for the first one on its line. */
	readonly parent: string | null;
	/** The commit's part of a diff, as its whole patch; made from its message when absent. */
	readonly patch: string;
};

/** What a scripted commit is made with. */
export type FakeCommitOptions = {
	/** Its author, as git reports one; null when the test means a reader that can't say. */
	readonly author?: string | null;
	/** Its message; numbered when absent. */
	readonly message?: string;
	/** Its whole patch, as its part of a diff; made from its message when absent. */
	readonly patch?: string;
	/**
	 * The commit to make it on: the branch's head unless given, or the
	 * first commit when the branch doesn't exist. Making it on anything but
	 * the head is how a test scripts a force push, which rewrites history.
	 */
	readonly parent?: string | null;
};

/** A commit id the fake hands out, as git's: hex digits, unique per commit it makes. */
const shaOf = (made: number) => made.toString(16).padStart(40, "0");

/**
 * One repository the fake serves, scripted by a test. Its history is
 * linear — every commit one parent, no merges — which is all the
 * `RefReader` interface asks of a remote.
 */
export class FakeRemote {
	readonly #commits = new Map<string, FakeCommit>();
	readonly #branches = new Map<string, string>();
	readonly #defaultBranch: string;
	#made = 0;

	/** The repository starts with its default branch at one commit, as a repository with nothing done to it yet. */
	constructor(defaultBranch: string) {
		this.#defaultBranch = defaultBranch;
		this.commit(defaultBranch, { message: "Initial commit" });
	}

	/** The repository's default branch. */
	get defaultBranch(): string {
		return this.#defaultBranch;
	}

	/** Its branches, by name, at the commits they name. */
	branches(): ReadonlyMap<string, string> {
		return this.#branches;
	}

	/**
	 * A commit made on `branch` and pushed to it: the branch's head is its
	 * parent unless `parent` says otherwise, and the branch moves to the
	 * commit — a new branch when it didn't exist. Returns the commit's id.
	 */
	commit(branch: string, o: FakeCommitOptions = {}): string {
		const sha = shaOf(++this.#made);
		const parent = o.parent !== undefined ? o.parent : this.#branches.get(branch) ?? null;
		const message = o.message ?? `Commit ${this.#made}`;
		this.#commits.set(sha, {
			sha,
			author: o.author ?? null,
			message,
			parent,
			patch: o.patch ?? `diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1,2 @@\n+${message}\n`,
		});
		this.#branches.set(branch, sha);
		return sha;
	}

	/** Moves `branch` to a commit already made, or makes it at one: a push that lands where the test says, new branch included. */
	push(branch: string, sha: string): void {
		this.#branches.set(branch, sha);
	}

	/** Makes a branch at a commit, at the default branch's head when absent, as someone branching would. */
	branch(branch: string, from?: string): void {
		this.#branches.set(branch, from ?? this.#branches.get(this.#defaultBranch)!);
	}

	/** Deletes a branch, as a push that removes it would. */
	remove(branch: string): void {
		this.#branches.delete(branch);
	}

	/** The commit `branch` is at, or null when the fake doesn't have it. */
	head(branch: string): string | null {
		return this.#branches.get(branch) ?? null;
	}

	/** Every commit reachable from `sha`, itself first, until the fake runs out of parents. */
	#lineage(sha: string): string[] {
		const line: string[] = [];
		for (let at: string | null = sha; at !== null; ) {
			const commit = this.#commits.get(at);
			if (!commit) break;
			line.push(at);
			at = commit.parent;
		}
		return line;
	}

	/** Whether `base` is in `head`'s history, itself included. */
	descends(base: string, head: string): boolean {
		return this.#lineage(head).includes(base);
	}

	/** The commits `head` has that `base` doesn't, oldest first: the fake's whole answer to `commits`. */
	between(base: string, head: string): FakeCommit[] {
		const gone = new Set(this.#lineage(base));
		const gained: FakeCommit[] = [];
		for (const sha of this.#lineage(head)) {
			if (gone.has(sha)) break;
			gained.push(this.#commits.get(sha)!);
		}
		return gained.reverse();
	}
}

/**
 * The `RefReader` over scripted remotes: one per repository a test makes
 * with `repo`. Its snapshots answer as a read of the remote would, with
 * full ref names; its diffs are the patches of the commits between, as the
 * test gave or synthesized them.
 */
export class FakeRefReader implements RefReader {
	readonly #remotes = new Map<string, FakeRemote>();

	/** Makes the repository `owner/name` with its default branch, and returns what the test scripts it with. */
	repo(owner: string, name: string, o: { defaultBranch?: string } = {}): FakeRemote {
		const remote = new FakeRemote(o.defaultBranch ?? "main");
		this.#remotes.set(`${owner}/${name}`, remote);
		return remote;
	}

	async snapshot(repo: RepoRef): Promise<{ readonly refs: ReadonlyMap<string, string>; readonly defaultBranch: string }> {
		const remote = this.#of(repo);
		return {
			refs: new Map([...remote.branches()].map(([branch, sha]) => [`refs/heads/${branch}`, sha])),
			defaultBranch: remote.defaultBranch,
		};
	}

	async resolve(repo: RepoRef, ref: string): Promise<string | null> {
		const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		return this.#of(repo).head(branch);
	}

	async isAncestor(repo: RepoRef, base: string, head: string): Promise<boolean> {
		return base === head || this.#of(repo).descends(base, head);
	}

	async commits(repo: RepoRef, base: string, head: string): Promise<readonly OrbCommit[]> {
		// What the reader answers is only what git would say of a commit, not the fake's own extras.
		return this.#of(repo)
			.between(base, head)
			.map(({ sha, author, message }) => ({ sha, author, message }));
	}

	async diff(repo: RepoRef, base: string, head: string): Promise<string> {
		return this.#of(repo)
			.between(base, head)
			.map((commit) => commit.patch)
			.join("");
	}

	#of(repo: RepoRef): FakeRemote {
		const remote = this.#remotes.get(repo.fullName);
		if (!remote) throw new Error(`The fake serves no repository ${repo.fullName}`);
		return remote;
	}
}

