// `stable` and the `X.Y` aliases follow version precedence, not the order releases finish publishing in (scripts/release-order.mjs).
import { describe, expect, it } from "vitest";
// @ts-expect-error: plain JavaScript module
import { compare, reconcile } from "./release-order.mjs";

type Result = { action: "set" | "keep" | "refuse"; stable: string | null; minors: Record<string, string>; why: string };

/** The registry's tags as the release job leaves them: it reconciles from the published versions each time it runs, whichever release triggered it. */
function registry() {
	const published: string[] = [];
	const tags: { stable: string | null; minors: Record<string, string>; pin: string | null } = { stable: null, minors: {}, pin: null };
	const refused: string[] = [];
	const publish = (version: string) => void published.push(version);
	const run = (): Result => {
		const result: Result = reconcile({ published, current: tags.stable, pin: tags.pin });
		if (result.action === "refuse") refused.push(result.why);
		else {
			// `stable` moves only on "set", but the aliases follow the highest patch of each minor whatever happens to stable.
			if (result.action === "set") tags.stable = result.stable;
			tags.minors = { ...tags.minors, ...result.minors };
		}
		return result;
	};
	/** `rollback_stable_to`: the target must be published, and is held until something above the highest published version is. */
	const rollback = (target: string) => {
		const top = [...published].sort(compare).at(-1)!;
		tags.pin = `${target}@${top}`;
		tags.stable = target;
		tags.minors = { ...tags.minors, [target.split(".").slice(0, 2).join(".")]: target };
	};
	return { published, tags, refused, publish, run, rollback };
}

const permutations = <T>(items: T[]): T[][] => (items.length <= 1 ? [items] : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));

describe("version precedence", () => {
	it("compares numerically, not as text or by when a version was published", () => {
		expect(compare("1.10.0", "1.9.0")).toBeGreaterThan(0);
		expect(compare("2.0.0", "1.99.99")).toBeGreaterThan(0);
		expect(compare("1.2.3", "1.2.3")).toBe(0);
		expect(["1.2.0", "1.10.0", "1.9.5", "0.99.0"].sort(compare)).toEqual(["0.99.0", "1.2.0", "1.9.5", "1.10.0"]);
		expect(() => compare("1.2", "1.2.0")).toThrow(/not a release version/);
		expect(() => compare("1.2.0-rc1", "1.2.0")).toThrow(/not a release version/);
	});
});

describe("stable follows the highest published version", () => {
	it("ends on the highest version and the highest patch of each minor, however releases finish and however often the job runs", () => {
		const versions = ["1.2.0", "1.2.1", "1.3.0", "1.10.0"];
		for (const order of permutations(versions)) {
			const r = registry();
			for (const version of order) {
				r.publish(version);
				r.run();
				// It never goes down while a release is published: a hotfix finishing after a later release cannot take stable back.
				expect(r.refused, order.join(",")).toEqual([]);
			}
			r.run();
			expect(r.tags.stable, order.join(",")).toBe("1.10.0");
			expect(r.tags.minors).toEqual({ "1.2": "1.2.1", "1.3": "1.3.0", "1.10": "1.10.0" });
		}
	});

	it("is the same when a run was replaced while it waited: any later run reaches the same tags", () => {
		const r = registry();
		for (const v of ["1.4.0", "1.4.1", "1.5.0"]) r.publish(v);
		// Only the newest run executed.
		expect(r.run()).toMatchObject({ action: "set", stable: "1.5.0" });
		expect(r.tags.minors).toEqual({ "1.4": "1.4.1", "1.5": "1.5.0" });
		expect(r.run().action).toBe("keep");
	});

	it("refuses to move stable down by itself, and says why", () => {
		const r = registry();
		r.publish("1.2.0");
		r.publish("1.3.0");
		r.run();
		// Something put stable on a version above what is published as the highest (a registry edited by hand, or a release removed).
		const out: Result = reconcile({ published: ["1.2.0"], current: "1.3.0", pin: null });
		expect(out.action).toBe("refuse");
		expect(out.stable).toBe("1.3.0");
		expect(out.why).toMatch(/rollback/);
	});

	it("keeps an explicit rollback until a newer release is published, then releases normally", () => {
		const r = registry();
		for (const v of ["1.2.0", "1.3.0"]) r.publish(v);
		r.run();
		expect(r.tags.stable).toBe("1.3.0");
		// 1.3.0 is bad: stable goes back to 1.2.0 on purpose. The job running again (for any reason) leaves it there, and the 1.3 alias is not touched.
		r.rollback("1.2.0");
		expect(r.run()).toMatchObject({ action: "keep", stable: "1.2.0" });
		r.publish("1.2.1");
		expect(r.run()).toMatchObject({ action: "keep", stable: "1.2.0" });
		// A patch of the bad release published late does not release either: it is not above what was the highest when the rollback was made.
		r.publish("1.3.0");
		expect(r.run().stable).toBe("1.2.0");
		// 1.3.1 is above it: the rollback ends and stable follows the highest again.
		r.publish("1.3.1");
		expect(r.run()).toMatchObject({ action: "set", stable: "1.3.1" });
		expect(r.refused).toEqual([]);
	});

	it("ignores a pin whose target is not published, and starts when nothing is published", () => {
		expect(reconcile({ published: ["1.0.0", "1.1.0"], current: "1.1.0", pin: "0.9.0@1.1.0" })).toMatchObject({ action: "keep", stable: "1.1.0" });
		expect(reconcile({ published: [], current: null, pin: null })).toMatchObject({ action: "keep", stable: null });
		expect(reconcile({ published: ["1.0.0"], current: null, pin: null })).toMatchObject({ action: "set", stable: "1.0.0", minors: { "1.0": "1.0.0" } });
		// What is not a release version is not a candidate.
		expect(reconcile({ published: ["1.0.0", "edge", "sha-abc", "1.1"], current: null, pin: null }).stable).toBe("1.0.0");
	});
});
