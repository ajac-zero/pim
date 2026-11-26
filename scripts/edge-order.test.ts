// `edge` never moves backwards, whatever order pushes to main finish in and however images are reused between commits (scripts/edge-order.mjs).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript module
import { decide, decideInRepo } from "./edge-order.mjs";

/** A linear history of commits, each with the identity of the web and the backend image it releases (what the identity of its inputs is: equal identities are one image). */
function history(releases: { web: string; backend: string }[]) {
	const dir = mkdtempSync(path.join(tmpdir(), "pim-edge-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } }).trim();
	git("init", "-q", "-b", "main");
	const commits = releases.map((_, i) => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, "file"), String(i));
		git("add", "-A");
		git("commit", "-q", "-m", `commit ${i}`);
		return git("rev-parse", "HEAD");
	});
	return { dir, commits, releases, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The registry as the workflows leave it. Building an image tags it `input-<identity>` and labels it with the commit that built it; a commit whose identity exists is tagged onto that
 * image and builds nothing; promoting `edge` points it at the commit's tag. `labelBased` is how the promotion was decided before (by the build label of the image edge points at);
 * `byCommit` is how it is decided now (by the commit that last promoted).
 */
function registry(h: ReturnType<typeof history>, mode: "labelBased" | "byCommit") {
	const images: Record<string, { builtAt: string }> = {};
	const sha: Record<string, Record<string, string>> = {};
	const edge: Record<string, string | undefined> = {};
	let promoted: string | undefined;
	const publish = (i: number) => {
		for (const kind of ["web", "backend"] as const) {
			const id = `${kind}:${h.releases[i]![kind]}`;
			images[id] ??= { builtAt: h.commits[i]! };
			(sha[h.commits[i]!] ??= {})[kind] = id;
		}
	};
	const promote = (i: number) => {
		const commit = h.commits[i]!;
		const isAncestor = (a: string, b: string) => {
			try {
				execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: h.dir, stdio: "ignore" });
				return true;
			} catch {
				return false;
			}
		};
		if (mode === "byCommit") {
			if (decideInRepo(commit, promoted, h.dir).action !== "promote") return;
			promoted = commit;
		} else {
			// The old rule, per image: leave edge alone when the commit is an ancestor of the commit that built the image edge points at.
			const skip = (kind: "web" | "backend") => edge[kind] !== undefined && isAncestor(commit, images[edge[kind]!]!.builtAt);
			for (const kind of ["web", "backend"] as const) if (!skip(kind)) edge[kind] = sha[commit]![kind];
			return;
		}
		for (const kind of ["web", "backend"] as const) edge[kind] = sha[commit]![kind];
	};
	return { publish, promote, edge };
}

const orders = (n: number): number[][] => (n <= 1 ? [[0]] : orders(n - 1).flatMap((p) => Array.from({ length: p.length + 1 }, (_, at) => [...p.slice(0, at), n - 1, ...p.slice(at)])));

describe("edge only moves forward", () => {
	it("decides from the commit that last promoted, not from an image", () => {
		const parents = new Map([["c", "b"], ["b", "a"], ["a", undefined]]);
		const isAncestor = (x: string, y: string) => { for (let at: string | undefined = y; at; at = parents.get(at)) if (at === x) return true; return false; };
		const known = (c: string) => parents.has(c);
		const d = (sha: string, promoted?: string) => decide({ sha, promoted, isAncestor, known }).action;
		expect(d("b")).toBe("promote");
		expect(d("b", "a")).toBe("promote");
		expect(d("b", "b")).toBe("skip");
		expect(d("a", "c")).toBe("skip");
		expect(d("b", "c")).toBe("skip");
		// A promoted commit that history no longer holds (main was rewritten) is replaced; one on another line of history is left to a person.
		expect(d("b", "zzz")).toBe("promote");
		const forked = decide({ sha: "x", promoted: "y", isAncestor: () => false, known: () => true });
		expect(forked.action).toBe("skip");
		// No record while `edge` already exists says nothing about where it stands: refused, never assumed to be the start. With no `edge` at all, the first promotion starts the record.
		expect(decide({ sha: "b", promoted: undefined, isAncestor, known, edgeExists: true }).action).toBe("refuse");
		expect(decide({ sha: "b", promoted: undefined, isAncestor, known, edgeExists: false }).action).toBe("promote");
		expect(decide({ sha: "b", promoted: "a", isAncestor, known, edgeExists: true }).action).toBe("promote");
	});

	// A web change, another, and a revert to the first: the third commit's web image is the first one's, reused, with the label of the commit that built it.
	const reverts = [{ web: "w1", backend: "b1" }, { web: "w2", backend: "b1" }, { web: "w1", backend: "b1" }];

	it("shows the old rule move edge backwards when an image is reused and the pushes finish out of order", () => {
		const h = history(reverts);
		try {
			const r = registry(h, "labelBased");
			for (const i of [0, 1, 2]) r.publish(i);
			// Commit 2 (the revert) is promoted first, then commit 1, which finished late.
			r.promote(2);
			r.promote(1);
			// Edge now serves commit 1's interface although commit 2 came after it: the revert is undone.
			expect(r.edge.web).toBe("web:w2");
		} finally {
			h.cleanup();
		}
	});

	it("never moves edge to the content of an older commit, in any order the pushes finish in, with images reused between commits", () => {
		// Six commits whose web and backend images change and are reused, including a revert and an unchanged commit.
		const releases = [{ web: "w1", backend: "b1" }, { web: "w2", backend: "b1" }, { web: "w2", backend: "b2" }, { web: "w1", backend: "b2" }, { web: "w1", backend: "b2" }, { web: "w3", backend: "b1" }];
		const h = history(releases);
		try {
			for (const order of orders(5).slice(0, 120)) {
				const r = registry(h, "byCommit");
				for (let i = 0; i < releases.length; i++) r.publish(i);
				const seen = order.map((i) => i);
				let newest = -1;
				for (const i of seen) {
					r.promote(i);
					newest = Math.max(newest, i);
					// Edge always serves the content of the newest commit promoted so far, whatever arrived since.
					expect(r.edge.web, `after ${seen.slice(0, seen.indexOf(i) + 1)}`).toBe(`web:${releases[newest]!.web}`);
					expect(r.edge.backend).toBe(`backend:${releases[newest]!.backend}`);
				}
			}
			// The revert case from above, in both orders.
			const g = history(reverts);
			try {
				for (const order of [[2, 1], [1, 2], [2, 0, 1], [0, 2, 1]]) {
					const r = registry(g, "byCommit");
					for (let i = 0; i < reverts.length; i++) r.publish(i);
					for (const i of order) r.promote(i);
					expect(r.edge.web).toBe("web:w1");
				}
			} finally {
				g.cleanup();
			}
		} finally {
			h.cleanup();
		}
	});

	it("reads real history: an older commit is skipped, a newer one promoted, a commit the history does not hold is replaced", () => {
		const h = history([{ web: "a", backend: "a" }, { web: "b", backend: "b" }, { web: "c", backend: "c" }]);
		try {
			const [a, b, c] = h.commits as [string, string, string];
			expect(decideInRepo(b, undefined, h.dir).action).toBe("promote");
			expect(decideInRepo(a, c, h.dir).action).toBe("skip");
			expect(decideInRepo(b, c, h.dir).action).toBe("skip");
			expect(decideInRepo(c, b, h.dir).action).toBe("promote");
			expect(decideInRepo(c, c, h.dir).action).toBe("skip");
			expect(decideInRepo(c, "1".repeat(40), h.dir).action).toBe("promote");
			expect(decideInRepo(c, undefined, h.dir, true).action).toBe("refuse");
		} finally {
			h.cleanup();
		}
	});
});
