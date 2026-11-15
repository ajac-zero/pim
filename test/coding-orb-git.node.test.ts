import { describe, expect, it } from "vitest";
import { FakeRefReader } from "../src/coding/orb/fake-refs";
import {
	checkRefs,
	compareRefs,
	describeRefReport,
	diffStat,
	MAX_ORB_DIFF_CHARS,
	MAX_REPORT_COMMITS,
	orbDiff,
	snapshotRefs,
	type RefReader,
	type RefSnapshot,
} from "../src/coding/orb/git-check";
import type { RepoRef } from "../src/coding/git-broker/broker";

// The ref checks (src/coding/orb/git-check.ts) are pure logic over an
// injected reader, so they run here against the in-memory fake
// (src/coding/orb/fake-refs.ts): no real remote and no network anywhere,
// so what a real reader would answer from a live repository — GitHub's
// advertisement, a real git's commits and diffs — is not verified here.

const REPO: RepoRef = { owner: "ada", name: "app", fullName: "ada/app" };
const AMP = "Amp <amp@ampcode.test>";
const ADA = "Ada <ada@example.test>";

/** A repository at rest — its default branch and any branches named — with the snapshot a thread takes before a turn. */
async function atRest(o: { branches?: readonly string[]; defaultBranch?: string } = {}) {
	const reader = new FakeRefReader();
	const remote = reader.repo(REPO.owner, REPO.name, { defaultBranch: o.defaultBranch });
	for (const branch of o.branches ?? []) remote.branch(branch);
	const before = await snapshotRefs(reader, REPO);
	return { reader, remote, before };
}

/** The report of one turn: the refs as they are now against the snapshot before it. */
const after = async (reader: RefReader, before: RefSnapshot, orbAuthor: string | null = null) => {
	const report = await compareRefs(reader, before, await snapshotRefs(reader, REPO));
	return { report, text: describeRefReport(report, { orbAuthor }) };
};

const short = (sha: string) => sha.slice(0, 7);

describe("snapshotRefs", () => {
	it("reads the repository's branches by name, without git's ref prefix", async () => {
		const { reader, remote, before } = await atRest({ branches: ["pim/t1"] });
		// What the reader answers is the raw read, with full ref names; the snapshot pares it.
		expect([...(await reader.snapshot(REPO)).refs.keys()]).toEqual(["refs/heads/main", "refs/heads/pim/t1"]);
		expect(before.defaultBranch).toBe("main");
		expect([...before.branches]).toEqual([
			["main", remote.head("main")!],
			["pim/t1", remote.head("pim/t1")!],
		]);
	});

	it("refuses a reader's answer that names a ref as something that isn't a commit", async () => {
		const reader = new FakeRefReader();
		reader.repo(REPO.owner, REPO.name);
		const lying: RefReader = {
			snapshot: async () => ({ refs: new Map([["refs/heads/main", "main"]]), defaultBranch: "main" }),
			resolve: (repo, ref) => reader.resolve(repo, ref),
			isAncestor: (repo, base, head) => reader.isAncestor(repo, base, head),
			commits: (repo, base, head) => reader.commits(repo, base, head),
			diff: (repo, base, head) => reader.diff(repo, base, head),
		};
		await expect(snapshotRefs(lying, REPO)).rejects.toThrow("isn't a commit id");
	});
});

describe("compareRefs", () => {
	it("reports nothing when no ref moved", async () => {
		const { reader, before } = await atRest({ branches: ["pim/t1"] });
		const { report, text } = await after(reader, before);
		expect(report).toMatchObject({
			repo: "ada/app",
			forcePushed: false,
			defaultBranch: { branch: "main", moved: false, state: null, commitCount: 0, commits: [], truncated: false },
			branches: [],
		});
		expect(text).toBe("No branch of the repository moved.");
	});

	it("reports a push to the default branch, with the commits it moved by", async () => {
		const { reader, remote, before } = await atRest();
		const base = before.branches.get("main")!;
		const pushed = remote.commit("main", { author: AMP, message: "Ship it" });
		const { report, text } = await after(reader, before, AMP);
		expect(report.defaultBranch).toEqual({
			branch: "main",
			before: base,
			after: pushed,
			moved: true,
			state: "moved",
			commits: [{ sha: pushed, author: AMP, message: "Ship it" }],
			truncated: false,
			commitCount: 1,
			forcePushed: false,
		});
		expect(report.branches).toEqual([]);
		expect(report.forcePushed).toBe(false);
		// The wording says what Pim can know: it found the move afterwards, and whose commits they are.
		expect(text).toBe(
			`The orb pushed 1 commit to main (${short(base)}..${short(pushed)}). Pim detected this afterwards; it cannot prevent the orb's own pushes.`,
		);
		expect(describeRefReport(report)).toBe(
			`main moved from ${short(base)} to ${short(pushed)} with 1 new commit by ${AMP} — not necessarily the orb's. ` +
				"Pim detected this afterwards; it cannot prevent the orb's own pushes.",
		);
	});

	it("reports a push to the thread's own branch and none to the default one", async () => {
		const { reader, remote, before } = await atRest({ branches: ["pim/t1"] });
		const base = before.branches.get("pim/t1")!;
		remote.commit("pim/t1", { author: AMP, message: "Fix the test" });
		const head = remote.commit("pim/t1", { author: AMP, message: "Tidy up" });
		const { report, text } = await after(reader, before, AMP);
		expect(report.defaultBranch.moved).toBe(false);
		expect(report.branches).toEqual([
			{
				branch: "pim/t1",
				before: base,
				after: head,
				moved: true,
				state: "moved",
				commits: report.branches[0]!.commits,
				truncated: false,
				commitCount: 2,
				forcePushed: false,
			},
		]);
		expect(report.branches[0]!.commits.map((commit) => commit.message)).toEqual(["Fix the test", "Tidy up"]);
		expect(text).toBe(`The orb pushed 2 commits to pim/t1 (${short(base)}..${short(head)}).`);
	});

	it("reports a force push: a ref whose new commit doesn't have the old one in its history", async () => {
		const { reader, remote } = await atRest();
		const base = remote.head("main")!;
		const wrong = remote.commit("main", { author: AMP, message: "Wrong take" });
		const before = await snapshotRefs(reader, REPO);
		// The orb rewrites history: a new commit made on the base, not on the branch's head, and main moved to it.
		const rewritten = remote.commit("main", { author: AMP, message: "Redone right", parent: base });
		const { report, text } = await after(reader, before, AMP);
		expect(report.defaultBranch).toMatchObject({ before: wrong, after: rewritten, moved: true, forcePushed: true });
		expect(report.forcePushed).toBe(true);
		expect(report.defaultBranch.commits.map((commit) => commit.message)).toEqual(["Redone right"]);
		expect(text).toBe(
			`The orb pushed 1 commit to main (${short(wrong)}..${short(rewritten)}). ` +
				"Pim detected this afterwards; it cannot prevent the orb's own pushes. " +
				"Force-push detected on main.",
		);
	});

	it("reports a branch pushed back to a commit it already had", async () => {
		const { reader, remote } = await atRest({ branches: ["pim/t1"] });
		const base = remote.head("pim/t1")!;
		const tooFar = remote.commit("pim/t1", { author: AMP, message: "A step too far" });
		const before = await snapshotRefs(reader, REPO);
		remote.push("pim/t1", base);
		const { report, text } = await after(reader, before);
		expect(report.branches[0]).toMatchObject({ branch: "pim/t1", before: tooFar, after: base, moved: true, state: "moved", commitCount: 0, forcePushed: true });
		expect(text).toBe(`pim/t1 moved from ${short(tooFar)} to ${short(base)}. Force-push detected on pim/t1.`);
	});

	it("reports a new branch and a deleted one, with no commits to count for either", async () => {
		const { reader, remote, before } = await atRest({ branches: ["feature", "pim/t1"] });
		remote.remove("feature");
		const made = remote.commit("pim/t2", { author: AMP, message: "The thread's own branch" });
		const { report, text } = await after(reader, before);
		expect(report.branches).toEqual([
			{ branch: "feature", before: before.branches.get("feature")!, after: null, moved: true, state: "deleted", commits: [], truncated: false, commitCount: 0, forcePushed: false },
			{ branch: "pim/t2", before: null, after: made, moved: true, state: "new", commits: [], truncated: false, commitCount: 0, forcePushed: false },
		]);
		expect(text).toBe(`The branch feature was deleted. New branch pim/t2 at ${short(made)}.`);
	});

	it("caps the commit list and says it was truncated", async () => {
		const { reader, remote, before } = await atRest();
		const base = before.branches.get("main")!;
		const first = remote.commit("main", { author: AMP, message: "First of many" });
		for (let made = 2; made <= MAX_REPORT_COMMITS + 10; made++) remote.commit("main", { author: AMP, message: `Change ${made}` });
		const { report, text } = await after(reader, before, AMP);
		expect(report.defaultBranch.commitCount).toBe(MAX_REPORT_COMMITS + 10);
		expect(report.defaultBranch.commits).toHaveLength(MAX_REPORT_COMMITS);
		expect(report.defaultBranch.truncated).toBe(true);
		expect(report.defaultBranch.commits[0]).toMatchObject({ sha: first, message: "First of many" });
		expect(text).toBe(
			`The orb pushed ${MAX_REPORT_COMMITS + 10} commits to main (${short(base)}..${short(report.defaultBranch.after!)}). ` +
				"Pim detected this afterwards; it cannot prevent the orb's own pushes.",
		);
	});

	it("reports several pushes in one turn as the one move they add up to", async () => {
		const { reader, remote, before } = await atRest({ branches: ["pim/t1"] });
		const branchBase = before.branches.get("pim/t1")!;
		remote.commit("pim/t1", { author: AMP, message: "First push" });
		const toMain = remote.commit("main", { author: AMP, message: "A push to main" });
		const branchHead = remote.commit("pim/t1", { author: AMP, message: "Second push" });
		const { report, text } = await after(reader, before, AMP);
		expect(report.defaultBranch).toMatchObject({ moved: true, after: toMain, commitCount: 1 });
		expect(report.branches).toEqual([
			expect.objectContaining({ branch: "pim/t1", before: branchBase, after: branchHead, commitCount: 2, forcePushed: false }),
		]);
		expect(report.branches[0]!.commits.map((commit) => commit.message)).toEqual(["First push", "Second push"]);
		expect(text).toBe(
			`The orb pushed 1 commit to main (${short(before.branches.get("main")!)}..${short(toMain)}). ` +
				"Pim detected this afterwards; it cannot prevent the orb's own pushes. " +
				`The orb pushed 2 commits to pim/t1 (${short(branchBase)}..${short(branchHead)}).`,
		);
	});

	it("reports a push by someone else to the default branch without calling it the orb's", async () => {
		const { reader, remote, before } = await atRest({ branches: ["pim/t1"] });
		const mainBase = before.branches.get("main")!;
		const branchBase = before.branches.get("pim/t1")!;
		// The orb works on its own branch while someone else pushes to main.
		const byTheOrb = remote.commit("pim/t1", { author: AMP, message: "The orb's work" });
		const byAda = remote.commit("main", { author: ADA, message: "Someone else's fix" });
		const { report, text } = await after(reader, before, AMP);
		expect(report.defaultBranch).toMatchObject({ moved: true, after: byAda, commitCount: 1 });
		// The report says who made the commits; it doesn't say who pushed them.
		expect(report.defaultBranch.commits).toEqual([{ sha: byAda, author: ADA, message: "Someone else's fix" }]);
		expect(text).toBe(
			`main moved from ${short(mainBase)} to ${short(byAda)} with 1 new commit by ${ADA} — not necessarily the orb's. ` +
				"Pim detected this afterwards; it cannot prevent the orb's own pushes. " +
				`The orb pushed 1 commit to pim/t1 (${short(branchBase)}..${short(byTheOrb)}).`,
		);
	});

	it("names the authors of a default-branch move even when the thread can't say who the orb commits as", async () => {
		const { reader, remote, before } = await atRest();
		const base = before.branches.get("main")!;
		const pushed = remote.commit("main", { author: AMP, message: "By the orb, but Pim can't tell" });
		const { text } = await after(reader, before);
		expect(text).toBe(
			`main moved from ${short(base)} to ${short(pushed)} with 1 new commit by ${AMP} — not necessarily the orb's. ` +
				"Pim detected this afterwards; it cannot prevent the orb's own pushes.",
		);
	});

	it("sums up branches past the few it names", async () => {
		const { reader, remote, before } = await atRest();
		for (let made = 1; made <= 5; made++) remote.commit(`feature/${made}`, { author: AMP, message: `Branch ${made}` });
		const { report, text } = await after(reader, before);
		expect(report.branches).toHaveLength(5);
		expect(text).toBe(
			[
				`New branch feature/1 at ${short(report.branches[0]!.after!)}.`,
				`New branch feature/2 at ${short(report.branches[1]!.after!)}.`,
				`New branch feature/3 at ${short(report.branches[2]!.after!)}.`,
				"And 2 more branches moved.",
			].join(" "),
		);
	});

	it("refuses to compare snapshots of two repositories", async () => {
		const reader = new FakeRefReader();
		reader.repo(REPO.owner, REPO.name);
		reader.repo("bob", "lib");
		const theirs = await snapshotRefs(reader, { owner: "bob", name: "lib", fullName: "bob/lib" });
		const ours = await snapshotRefs(reader, REPO);
		await expect(compareRefs(reader, ours, theirs)).rejects.toThrow("bob/lib");
	});
});

describe("orbDiff", () => {
	it("diffs what the orb pushed to the default branch, from the thread's base commit", async () => {
		const { reader, remote, before } = await atRest();
		const base = before.branches.get("main")!;
		const pushed = remote.commit("main", { author: AMP, message: "Ship it", patch: "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1,2 @@\n+shipped\n-shelved\n" });
		const ofIt = await orbDiff(reader, REPO, base, "main");
		expect(ofIt).toEqual({
			base,
			ref: "main",
			head: pushed,
			diff: "diff --git a/app.txt b/app.txt\n--- a/app.txt\n+++ b/app.txt\n@@ -1 +1,2 @@\n+shipped\n-shelved\n",
			truncated: false,
			stat: { files: 1, additions: 1, deletions: 1 },
		});
	});

	it("diffs a branch, named with or without git's ref prefix, and a commit id just as well", async () => {
		const { reader, remote, before } = await atRest({ branches: ["pim/t1"] });
		const base = before.branches.get("main")!;
		remote.commit("pim/t1", { author: AMP, message: "Fix the test" });
		const head = remote.commit("pim/t1", { author: AMP, message: "Tidy up" });
		const ofBranch = await orbDiff(reader, REPO, base, "pim/t1");
		expect(ofBranch).toMatchObject({ ref: "pim/t1", head });
		const ofPrefixed = await orbDiff(reader, REPO, base, "refs/heads/pim/t1");
		expect(ofPrefixed).toEqual({ ...ofBranch!, ref: "refs/heads/pim/t1" });
		expect(await orbDiff(reader, REPO, base, head)).toEqual({ ...ofBranch!, ref: head });
	});

	it("answers null for a ref the repository no longer has, and an empty diff for one at the base", async () => {
		const { reader, remote, before } = await atRest({ branches: ["gone"] });
		const base = before.branches.get("main")!;
		remote.remove("gone");
		expect(await orbDiff(reader, REPO, base, "gone")).toBeNull();
		expect(await orbDiff(reader, REPO, base, "main")).toEqual({ base, ref: "main", head: base, diff: "", truncated: false, stat: { files: 0, additions: 0, deletions: 0 } });
	});

	it("cuts a diff past its cap and counts the numbers of the whole of it", async () => {
		const { reader, remote, before } = await atRest();
		const base = before.branches.get("main")!;
		const lines = Array.from({ length: MAX_ORB_DIFF_CHARS }, (_, at) => `+line ${at}\n`);
		const pushed = remote.commit("main", { author: AMP, message: "A big one", patch: `diff --git a/big.txt b/big.txt\n${lines.join("")}` });
		const ofIt = await orbDiff(reader, REPO, base, "main");
		expect(ofIt).toMatchObject({ head: pushed, truncated: true });
		expect(ofIt!.diff).toHaveLength(MAX_ORB_DIFF_CHARS);
		expect(ofIt!.diff.startsWith("diff --git a/big.txt b/big.txt\n")).toBe(true);
		expect(ofIt!.stat).toEqual({ files: 1, additions: MAX_ORB_DIFF_CHARS, deletions: 0 });
	});

	it("refuses a base commit that isn't a commit id", async () => {
		const { reader } = await atRest();
		await expect(orbDiff(reader, REPO, "not-a-commit", "main")).rejects.toThrow("must be a commit id");
	});
});

describe("diffStat", () => {
	it("counts the files a diff touches and the lines it adds and removes", () => {
		const diff = [
			"diff --git a/one.txt b/one.txt",
			"--- a/one.txt",
			"+++ b/one.txt",
			"@@ -1,2 +1,3 @@",
			" context line",
			"+added",
			"-removed",
			"diff --git a/two.txt b/two.txt",
			"--- a/two.txt",
			"+++ b/two.txt",
			"@@ -1 +0 @@",
			"-all of it",
			"+a line that starts with pluses",
		].join("\n");
		expect(diffStat(diff)).toEqual({ files: 2, additions: 2, deletions: 2 });
		expect(diffStat("")).toEqual({ files: 0, additions: 0, deletions: 0 });
	});
});

describe("checkRefs", () => {
	it("reads the refs as they are now and answers the report with the text for the thread's notice", async () => {
		const { reader, remote, before } = await atRest();
		remote.commit("main", { author: AMP, message: "Ship it" });
		const checked = await checkRefs(reader, before, { orbAuthor: AMP });
		expect(checked.report).toEqual((await compareRefs(reader, before, await snapshotRefs(reader, REPO))));
		expect(checked.text).toBe(describeRefReport(checked.report, { orbAuthor: AMP }));
		expect(checked.text).toContain("The orb pushed 1 commit to main");
	});
});
