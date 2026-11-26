import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bootstrapEdge, promoteEdge } from "./edge-promote.mjs";
import { IMAGE_NAMES } from "./registry.mjs";
import { PIN_LABEL, promoteStable, rollbackStable } from "./release-promote.mjs";

// A registry in memory with the interface scripts/registry.mjs gives: tags point at digests, and a record is an image of its own with one label.
function fakeRegistry(initial: Record<string, string> = {}) {
	const tags = new Map<string, string>(Object.entries(initial));
	const labels = new Map<string, string>();
	return {
		tags,
		digest: (ref: string) => tags.get(ref) ?? null,
		exists: (ref: string) => tags.has(ref),
		label: (ref: string, name: string) => labels.get(`${ref}#${name}`) ?? null,
		tag: (from: string, ...to: string[]) => {
			if (!tags.has(from)) throw new Error(`no such image ${from}`);
			for (const t of to) tags.set(t, tags.get(from) as string);
		},
		writeRecord: (ref: string, name: string, value: string) => {
			tags.set(ref, `record:${ref}:${value}`);
			labels.set(`${ref}#${name}`, value);
		},
	};
}
type Reg = ReturnType<typeof fakeRegistry>;
const OWNER = "o";
const publish = (reg: Reg, v: string) => {
	for (const n of IMAGE_NAMES) reg.tags.set(`ghcr.io/${OWNER}/${n}:${v}`, `sha256:${n}-${v}`);
};
const at = (reg: Reg, ref: string, name = "pim") => reg.digest(`ghcr.io/${OWNER}/${name}:${ref}`);

describe("stable and X.Y", () => {
	it("end on the highest versions whatever order the releases finish in, for all three images", () => {
		const reg = fakeRegistry();
		const tags: string[] = [];
		for (const v of ["1.2.0", "1.10.0", "1.9.3"]) {
			publish(reg, v);
			tags.push(`v${v}`);
			promoteStable({ owner: OWNER, tags, reg });
		}
		for (const n of IMAGE_NAMES) {
			expect(at(reg, "stable", n)).toBe(`sha256:${n}-1.10.0`);
			expect(at(reg, "1.9", n)).toBe(`sha256:${n}-1.9.3`);
		}
	});

	it("does not take a release whose images are not all there", () => {
		const reg = fakeRegistry();
		publish(reg, "1.0.0");
		reg.tags.set(`ghcr.io/${OWNER}/pim:1.1.0`, "sha256:pim-1.1.0");
		promoteStable({ owner: OWNER, tags: ["v1.0.0", "v1.1.0"], reg });
		expect(at(reg, "stable")).toBe("sha256:pim-1.0.0");
	});

	it("refuses to move stable down by itself", () => {
		const reg = fakeRegistry();
		publish(reg, "1.0.0");
		reg.tags.set(`ghcr.io/${OWNER}/pim:stable`, "sha256:pim-1.0.0");
		publish(reg, "1.1.0");
		reg.tags.set(`ghcr.io/${OWNER}/pim:stable`, "sha256:pim-1.1.0");
		// 1.1.0 was unpublished (its tag removed): stable is above the highest published version
		expect(promoteStable({ owner: OWNER, tags: ["v1.0.0"], reg }).action).toBe("refuse");
		expect(at(reg, "stable")).toBe("sha256:pim-1.1.0");
	});

	it("rolls back only on request, holds, and releases normally once a higher version exists", () => {
		const reg = fakeRegistry();
		const tags = ["v1.0.0", "v1.1.0"];
		publish(reg, "1.0.0");
		publish(reg, "1.1.0");
		promoteStable({ owner: OWNER, tags, reg });
		expect(at(reg, "stable")).toBe("sha256:pim-1.1.0");
		expect(rollbackStable({ owner: OWNER, version: "1.0.0", tags, reg }).action).toBe("set");
		expect(at(reg, "stable")).toBe("sha256:pim-1.0.0");
		expect(reg.label("ghcr.io/o/pim:stable-pin", PIN_LABEL)).toBe("1.0.0@1.1.0");
		// a later run for the newer release does not undo it
		expect(promoteStable({ owner: OWNER, tags, reg }).action).toBe("keep");
		expect(at(reg, "stable")).toBe("sha256:pim-1.0.0");
		publish(reg, "1.2.0");
		promoteStable({ owner: OWNER, tags: [...tags, "v1.2.0"], reg });
		expect(at(reg, "stable")).toBe("sha256:pim-1.2.0");
	});

	it("refuses a rollback to something unpublished and leaves stable alone", () => {
		const reg = fakeRegistry();
		publish(reg, "1.0.0");
		promoteStable({ owner: OWNER, tags: ["v1.0.0"], reg });
		expect(() => rollbackStable({ owner: OWNER, version: "0.9.0", tags: ["v1.0.0"], reg })).toThrow(/not a published release/);
		expect(at(reg, "stable")).toBe("sha256:pim-1.0.0");
	});
});

describe("edge", () => {
	const A = "a".repeat(40);
	const B = "b".repeat(40);
	const sha = (reg: Reg, c: string) => {
		for (const n of IMAGE_NAMES) reg.tags.set(`ghcr.io/${OWNER}/${n}:sha-${c.slice(0, 12)}`, `sha256:${n}-${c.slice(0, 4)}`);
	};
	// History: A is before B.
	const decide = (commit: string, promoted: string | undefined, _cwd: unknown, edgeExists: boolean) => {
		if (!promoted) return edgeExists ? { action: "refuse", why: "no record" } : { action: "promote", why: "first" };
		if (promoted === commit) return { action: "skip", why: "same" };
		return promoted === B ? { action: "skip", why: "older" } : { action: "promote", why: "newer" };
	};

	it("promotes forward, and skips an older commit that finishes later", () => {
		const reg = fakeRegistry();
		sha(reg, A);
		sha(reg, B);
		expect(promoteEdge({ owner: OWNER, sha: B, reg, decide }).action).toBe("promoted");
		expect(promoteEdge({ owner: OWNER, sha: A, reg, decide }).action).toBe("skipped");
		expect(at(reg, "edge")).toBe("sha256:pim-bbbb");
	});

	it("moves nothing, and writes no record, when an image for the commit is missing", () => {
		const reg = fakeRegistry();
		sha(reg, A);
		reg.tags.delete(`ghcr.io/${OWNER}/pim-web:sha-${A.slice(0, 12)}`);
		expect(() => promoteEdge({ owner: OWNER, sha: A, reg, decide })).toThrow(/does not exist/);
		expect(reg.exists(`ghcr.io/${OWNER}/pim:edge`)).toBe(false);
		expect(reg.exists(`ghcr.io/${OWNER}/pim:edge-commit`)).toBe(false);
	});

	it("refuses to guess when edge exists without a record", () => {
		const reg = fakeRegistry({ [`ghcr.io/${OWNER}/pim:edge`]: "sha256:old" });
		sha(reg, B);
		expect(promoteEdge({ owner: OWNER, sha: B, reg, decide }).action).toBe("refused");
		expect(at(reg, "edge")).toBe("sha256:old");
	});

	it("bootstrap needs an edge, no existing record and a full commit in history", () => {
		expect(() => bootstrapEdge({ owner: OWNER, commit: A, head: "HEAD", reg: fakeRegistry() })).toThrow(/no edge/);
		const reg = fakeRegistry({ [`ghcr.io/${OWNER}/pim:edge`]: "x" });
		expect(() => bootstrapEdge({ owner: OWNER, commit: "short", head: "HEAD", reg })).toThrow(/full commit/);
		expect(() => bootstrapEdge({ owner: OWNER, commit: "c".repeat(40), head: "HEAD", reg })).toThrow(/not in the history/);
		reg.writeRecord(`ghcr.io/${OWNER}/pim:edge-commit`, "dev.pim.edge-commit", A);
		expect(() => bootstrapEdge({ owner: OWNER, commit: A, head: "HEAD", reg })).toThrow(/exists/);
	});

	it("bootstrap writes the record for a commit in history", () => {
		const reg = fakeRegistry({ [`ghcr.io/${OWNER}/pim:edge`]: "x" });
		const head = "git rev-parse HEAD";
		const commit = execSync(head, { encoding: "utf8" }).trim();
		bootstrapEdge({ owner: OWNER, commit, head: commit, reg });
		expect(reg.label(`ghcr.io/${OWNER}/pim:edge-commit`, "dev.pim.edge-commit")).toBe(commit);
	});
});
