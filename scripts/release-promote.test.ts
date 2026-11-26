import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bootstrapEdge, promoteEdge } from "./edge-promote.mjs";
import { FakeDocker } from "./fake-docker.ts";
import { IMAGE_NAMES, RegistryError, registry } from "./registry.mjs";
import { PIN_LABEL, promoteStable, rollbackStable } from "./release-promote.mjs";

const BASE = "ghcr.io/o";
const at = (d: FakeDocker, ref: string, name = "pim") => d.tags.get(`${BASE}/${name}:${ref}`);
const publishVersion = (d: FakeDocker, v: string) => {
	for (const n of IMAGE_NAMES) d.publish(`${BASE}/${n}:${v}`, `sha256:${n}-${v}`, { "org.opencontainers.image.version": v });
};
const all = () => true;

describe("the registry adapter", () => {
	it("reads digests and labels of single and multi-platform images, and tells a missing tag from an outage", () => {
		const d = new FakeDocker();
		const reg = registry(d.run);
		d.publish(`${BASE}/pim:1.0.0`, "sha256:a", { "dev.pim.image-identity": "abc" });
		expect(reg.digest(`${BASE}/pim:1.0.0`)).toBe("sha256:a");
		expect(reg.label(`${BASE}/pim:1.0.0`, "dev.pim.image-identity")).toBe("abc");
		expect(reg.label(`${BASE}/pim:1.0.0`, "nope")).toBeNull();
		reg.writeRecord(`${BASE}/pim:rec`, "x.y", "v");
		expect(reg.label(`${BASE}/pim:rec`, "x.y")).toBe("v");
		expect(reg.digest(`${BASE}/pim:missing`)).toBeNull();
		expect(reg.exists(`${BASE}/pim:missing`)).toBe(false);
		d.outage = true;
		expect(() => reg.digest(`${BASE}/pim:1.0.0`)).toThrow(RegistryError);
		expect(() => reg.exists(`${BASE}/pim:missing`)).toThrow(RegistryError);
		expect(() => reg.label(`${BASE}/pim:1.0.0`, "x")).toThrow(RegistryError);
	});

	it("does not take an answer it cannot read for a missing image", () => {
		const garbage = registry(() => "not json");
		expect(() => garbage.digest("x")).toThrow(RegistryError);
		const noManifest = registry(() => "{}");
		expect(() => noManifest.exists("x")).toThrow(RegistryError);
	});
});

describe("stable and X.Y", () => {
	it("end on the highest versions whatever order the releases finish in, for all three images", () => {
		const d = new FakeDocker();
		const reg = registry(d.run);
		const tags: string[] = [];
		for (const v of ["1.2.0", "1.10.0", "1.9.3"]) {
			publishVersion(d, v);
			tags.push(`v${v}`);
			promoteStable({ owner: "o", tags, qualified: all, reg });
		}
		for (const n of IMAGE_NAMES) {
			expect(at(d, "stable", n)).toBe(`sha256:${n}-1.10.0`);
			expect(at(d, "1.9", n)).toBe(`sha256:${n}-1.9.3`);
		}
	});

	it("promotes only releases that are complete and qualified, and never an earlier failed release just because its images exist", () => {
		const d = new FakeDocker();
		const reg = registry(d.run);
		publishVersion(d, "1.0.0");
		publishVersion(d, "1.1.0"); // CI failed on its commit
		d.publish(`${BASE}/pim:1.2.0`, "sha256:pim-1.2.0"); // the other two images never arrived
		const tags = ["v1.0.0", "v1.1.0", "v1.2.0"];
		promoteStable({ owner: "o", tags, qualified: (v) => v !== "1.1.0", reg });
		expect(at(d, "stable")).toBe("sha256:pim-1.0.0");
		expect(at(d, "1.1")).toBeUndefined();
		expect(at(d, "1.2")).toBeUndefined();
		// a later release that qualified moves stable past the failed one
		publishVersion(d, "1.3.0");
		promoteStable({ owner: "o", tags: [...tags, "v1.3.0"], qualified: (v) => v !== "1.1.0", reg });
		expect(at(d, "stable")).toBe("sha256:pim-1.3.0");
		expect(at(d, "1.1")).toBeUndefined();
	});

	it("does not infer which release stable is on from the digests of images reused between releases", () => {
		// 1.0.1 is qualified; 2.0.0 is not, and both reuse 1.0.0's web and computer images.
		const publish = (d: FakeDocker, v: string) => {
			d.publish(`${BASE}/pim:${v}`, `sha256:pim-${v}`);
			for (const n of ["pim-web", "pim-computer"]) d.publish(`${BASE}/${n}:${v}`, `sha256:${n}-shared`);
		};
		const tags = ["v1.0.0", "v1.0.1", "v2.0.0"];
		const qualified = (v: string) => v !== "2.0.0";
		const setup = () => {
			const d = new FakeDocker();
			const reg = registry(d.run);
			publish(d, "1.0.0");
			promoteStable({ owner: "o", tags: ["v1.0.0"], qualified, reg });
			publish(d, "1.0.1");
			publish(d, "2.0.0");
			return { d, reg };
		};
		const probe = setup();
		const before = probe.d.writes;
		const result = promoteStable({ owner: "o", tags, qualified, reg: probe.reg });
		expect(result).toMatchObject({ action: "set", stable: "1.0.1" });
		expect(at(probe.d, "stable")).toBe("sha256:pim-1.0.1");
		const writes = probe.d.writes - before;
		// a partial newer promotion, stopped at any write, is finished by the next run, and never lands on the unqualified release
		for (let n = 1; n <= writes; n++) {
			const { d, reg } = setup();
			d.failWrite = d.writes + n;
			expect(() => promoteStable({ owner: "o", tags, qualified, reg })).toThrow();
			expect(promoteStable({ owner: "o", tags, qualified, reg }).action, `write ${n}`).not.toBe("refuse");
			expect(at(d, "stable"), `write ${n}`).toBe("sha256:pim-1.0.1");
			expect(at(d, "2.0")).toBeUndefined();
		}
		// stable on the backend of 1.0.1 with the unqualified 2.0.0 sharing the web image: nothing to do, nothing refused
		expect(promoteStable({ owner: "o", tags, qualified, reg: probe.reg }).action).toBe("keep");
	});

	it("refuses to move stable down by itself, and a stable it cannot identify", () => {
		const d = new FakeDocker();
		const reg = registry(d.run);
		publishVersion(d, "1.0.0");
		publishVersion(d, "1.1.0");
		for (const n of IMAGE_NAMES) d.tags.set(`${BASE}/${n}:stable`, `sha256:${n}-1.1.0`);
		// 1.1.0 stopped being qualified: stable is above what is eligible
		expect(promoteStable({ owner: "o", tags: ["v1.0.0", "v1.1.0"], qualified: (v) => v === "1.0.0", reg }).action).toBe("refuse");
		expect(at(d, "stable")).toBe("sha256:pim-1.1.0");
		d.tags.set(`${BASE}/pim:stable`, "sha256:something-else");
		expect(promoteStable({ owner: "o", tags: ["v1.0.0", "v1.1.0"], qualified: all, reg }).action).toBe("refuse");
		expect(at(d, "stable")).toBe("sha256:something-else");
	});

	it("does not take a registry outage for a registry with no releases", () => {
		const d = new FakeDocker();
		publishVersion(d, "1.0.0");
		d.outage = true;
		expect(() => promoteStable({ owner: "o", tags: ["v1.0.0"], qualified: all, reg: registry(d.run) })).toThrow(RegistryError);
		expect(d.writes).toBe(0);
	});

	it("is finished by the next run after a failure at any alias write, whichever role it stopped at", () => {
		const setup = () => {
			const d = new FakeDocker();
			publishVersion(d, "1.0.0");
			publishVersion(d, "1.1.0");
			const reg = registry(d.run);
			promoteStable({ owner: "o", tags: ["v1.0.0"], qualified: all, reg });
			return { d, reg };
		};
		const probe = setup();
		const before = probe.d.writes;
		promoteStable({ owner: "o", tags: ["v1.0.0", "v1.1.0"], qualified: all, reg: probe.reg });
		const writes = probe.d.writes - before;
		expect(writes).toBeGreaterThan(IMAGE_NAMES.length);
		for (let n = 1; n <= writes; n++) {
			const { d, reg } = setup();
			d.failWrite = d.writes + n;
			expect(() => promoteStable({ owner: "o", tags: ["v1.0.0", "v1.1.0"], qualified: all, reg }), `write ${n}`).toThrow();
			// stopped halfway: the backend's stable may be ahead of the web app's, which is exactly what the next run must repair
			promoteStable({ owner: "o", tags: ["v1.0.0", "v1.1.0"], qualified: all, reg });
			for (const name of IMAGE_NAMES) {
				expect(at(d, "stable", name), `${name} after failing at write ${n}`).toBe(`sha256:${name}-1.1.0`);
				expect(at(d, "1.1", name)).toBe(`sha256:${name}-1.1.0`);
			}
		}
	});

	it("completes an interrupted rollback from any write, and a plain release run does not undo it", () => {
		const tags = ["v1.0.0", "v1.1.0"];
		const setup = () => {
			const d = new FakeDocker();
			publishVersion(d, "1.0.0");
			publishVersion(d, "1.1.0");
			const reg = registry(d.run);
			promoteStable({ owner: "o", tags, qualified: all, reg });
			return { d, reg };
		};
		const probe = setup();
		const before = probe.d.writes;
		rollbackStable({ owner: "o", version: "1.0.0", tags, qualified: all, reg: probe.reg });
		const writes = probe.d.writes - before;
		expect(probe.reg.label(`${BASE}/pim:stable-pin`, PIN_LABEL)).toBe("1.0.0@1.1.0");
		for (let n = 1; n <= writes; n++) {
			const { d, reg } = setup();
			d.failWrite = d.writes + n;
			expect(() => rollbackStable({ owner: "o", version: "1.0.0", tags, qualified: all, reg }), `write ${n}`).toThrow();
			if (n === 1) {
				// the pin was not written: nothing changed, and a release run leaves stable where it was
				promoteStable({ owner: "o", tags, qualified: all, reg });
				expect(at(d, "stable")).toBe("sha256:pim-1.1.0");
				continue;
			}
			// the pin is written: a plain reconcile finishes the rollback instead of refusing or moving back up
			expect(promoteStable({ owner: "o", tags, qualified: all, reg }).action, `write ${n}`).not.toBe("refuse");
			for (const name of IMAGE_NAMES) expect(at(d, "stable", name), `${name} after failing at write ${n}`).toBe(`sha256:${name}-1.0.0`);
		}
	});

	it("holds a rollback until a higher version is released, and refuses one to an ineligible version", () => {
		const d = new FakeDocker();
		const reg = registry(d.run);
		const tags = ["v1.0.0", "v1.1.0"];
		publishVersion(d, "1.0.0");
		publishVersion(d, "1.1.0");
		promoteStable({ owner: "o", tags, qualified: all, reg });
		expect(() => rollbackStable({ owner: "o", version: "1.0.0", tags, qualified: (v) => v !== "1.0.0", reg })).toThrow(/not an eligible release/);
		expect(() => rollbackStable({ owner: "o", version: "0.9.0", tags, qualified: all, reg })).toThrow(/not an eligible release/);
		rollbackStable({ owner: "o", version: "1.0.0", tags, qualified: all, reg });
		expect(promoteStable({ owner: "o", tags, qualified: all, reg }).action).toBe("keep");
		publishVersion(d, "1.2.0");
		promoteStable({ owner: "o", tags: [...tags, "v1.2.0"], qualified: all, reg });
		expect(at(d, "stable")).toBe("sha256:pim-1.2.0");
	});
});

describe("edge", () => {
	const commit = (c: string) => c.repeat(40);
	const [A, B, C] = [commit("a"), commit("b"), commit("c")];
	const order = [A, B, C];
	// History is the line A, B, C.
	const decide = (sha: string, promoted: string | undefined, _cwd: unknown, edgeExists: boolean) => {
		if (!promoted) return edgeExists ? { action: "refuse", why: "no record" } : { action: "promote", why: "first" };
		if (promoted === sha) return { action: "skip", why: "same" };
		return order.indexOf(sha) > order.indexOf(promoted) ? { action: "promote", why: "newer" } : { action: "skip", why: "older" };
	};
	const images = (d: FakeDocker) => {
		for (const c of order) for (const n of IMAGE_NAMES) d.publish(`${BASE}/${n}:sha-${c.slice(0, 12)}`, `sha256:${n}-${c[0]}`);
	};
	const edges = (d: FakeDocker) => IMAGE_NAMES.map((n) => at(d, "edge", n));
	const promote = (d: FakeDocker, sha: string) => promoteEdge({ owner: "o", sha, reg: registry(d.run), decide });

	it("promotes forward, and skips an older commit that finishes later", () => {
		const d = new FakeDocker();
		images(d);
		expect(promote(d, B).action).toBe("promoted");
		expect(promote(d, A).action).toBe("skipped");
		expect(edges(d)).toEqual(IMAGE_NAMES.map((n) => `sha256:${n}-b`));
	});

	it("moves nothing, and writes nothing, when an image for the commit is missing", () => {
		const d = new FakeDocker();
		images(d);
		d.tags.delete(`${BASE}/pim-web:sha-${A.slice(0, 12)}`);
		expect(() => promote(d, A)).toThrow(/does not exist/);
		expect(d.writes).toBe(0);
	});

	it("never moves back after a failure at any write of a promotion, and the next run of any commit finishes it", () => {
		const setup = () => {
			const d = new FakeDocker();
			images(d);
			promote(d, B);
			return d;
		};
		const probe = setup();
		const before = probe.writes;
		promote(probe, C);
		const writes = probe.writes - before;
		expect(writes).toBe(1 + IMAGE_NAMES.length + 1); // intent, three aliases, the finished record
		for (let n = 1; n <= writes; n++) {
			const d = setup();
			d.failWrite = d.writes + n;
			expect(() => promote(d, C), `write ${n}`).toThrow();
			// an older run arrives in between
			promote(d, A);
			for (const edge of edges(d)) expect(edge, `after failing at write ${n}`).not.toMatch(/-a$/);
			if (n > 1) expect(edges(d), `intent was written at ${n}`).toEqual(IMAGE_NAMES.map((name) => `sha256:${name}-c`));
			promote(d, C);
			expect(edges(d)).toEqual(IMAGE_NAMES.map((name) => `sha256:${name}-c`));
			expect(registry(d.run).label(`${BASE}/pim:edge-commit`, "dev.pim.edge-commit")).toBe(C);
		}
	});

	it("does not take an outage for an edge that was never promoted", () => {
		const d = new FakeDocker();
		images(d);
		d.outage = true;
		expect(() => promote(d, B)).toThrow(RegistryError);
		expect(d.writes).toBe(0);
	});

	it("refuses to guess when edge exists without a record", () => {
		const d = new FakeDocker();
		images(d);
		d.tags.set(`${BASE}/pim:edge`, "sha256:old");
		expect(promote(d, B).action).toBe("refused");
		expect(d.writes).toBe(0);
	});

	it("bootstrap needs an edge, no record or intent, and a full commit in history", () => {
		const none = new FakeDocker();
		expect(() => bootstrapEdge({ owner: "o", commit: A, head: "HEAD", reg: registry(none.run) })).toThrow(/no edge/);
		const d = new FakeDocker();
		d.tags.set(`${BASE}/pim:edge`, "x");
		expect(() => bootstrapEdge({ owner: "o", commit: "short", head: "HEAD", reg: registry(d.run) })).toThrow(/full commit/);
		expect(() => bootstrapEdge({ owner: "o", commit: C, head: "HEAD", reg: registry(d.run) })).toThrow(/not in the history/);
		const head = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
		bootstrapEdge({ owner: "o", commit: head, head, reg: registry(d.run) });
		expect(registry(d.run).label(`${BASE}/pim:edge-commit`, "dev.pim.edge-commit")).toBe(head);
		expect(() => bootstrapEdge({ owner: "o", commit: head, head, reg: registry(d.run) })).toThrow(/already has/);
		const intentOnly = new FakeDocker();
		intentOnly.tags.set(`${BASE}/pim:edge`, "x");
		registry(intentOnly.run).writeRecord(`${BASE}/pim:edge-intent`, "dev.pim.edge-intent", A);
		expect(() => bootstrapEdge({ owner: "o", commit: head, head, reg: registry(intentOnly.run) })).toThrow(/already has/);
	});
});
