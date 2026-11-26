#!/usr/bin/env node
// Which version `stable` (and each `X.Y` alias) names, decided by version precedence and not by the order releases finish publishing in (publish.yml, the `release` job).
//
// A release tag `vX.Y.Z` publishes its images as `X.Y.Z` and nothing else. What `stable` and `X.Y` point at is then worked out from every version that has been published, from scratch,
// each time: `stable` is the highest published version, `X.Y` the highest published patch of that minor. Because the answer does not depend on which run asked, releases that finish out of
// order, or a run that was replaced while it waited, all arrive at the same tags.
//
// `stable` never moves to a lower version by itself: if it is on a version higher than the one this would choose, that is refused (and the run fails), because it can only mean an earlier
// release was rolled back by hand or the registry was changed, and a person must say so. An explicit rollback (`rollback_stable_to` in Publish) records a pin, `<target>@<highest published version then>`:
// `stable` stays on the target until a version above that highest is published, which releases normally again.
//
//   node scripts/release-order.mjs reconcile '<json: { "published": ["1.2.0"], "current": "1.2.0"|null, "pin": "1.1.0@1.2.0"|null }>'
import { pathToFileURL } from "node:url";

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;

/** Precedence of two `X.Y.Z` versions, numerically (1.10.0 is above 1.9.0): negative, zero or positive. */
export function compare(a, b) {
	const x = VERSION.exec(a);
	const y = VERSION.exec(b);
	if (!x || !y) throw new Error(`not a release version: ${!x ? a : b}`);
	for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
	return 0;
}

const highest = (versions) => versions.reduce((best, v) => (best === null || compare(v, best) > 0 ? v : best), null);
const minorOf = (v) => v.split(".").slice(0, 2).join(".");

/**
 * What `stable` and the `X.Y` aliases should name. `published` is every version whose images all exist; `current` the version `stable` is on now (null when none, or when it is on an image that
 * is no published version); `pin` an explicit rollback, `<target>@<above>`.
 * `action` says what happens to `stable` (set, keep or refuse); the `X.Y` aliases are set to `minors` unless it refuses.
 * @returns {{ action: "set" | "keep" | "refuse", stable: string | null, minors: Record<string, string>, why: string }}
 */
export function reconcile({ published, current = null, pin = null }) {
	const versions = [...new Set(published.filter((v) => VERSION.test(v)))];
	if (!versions.length) return { action: "keep", stable: null, minors: {}, why: "no release is published" };
	const top = highest(versions);
	const [target, above] = pin ? pin.split("@") : [null, null];
	// A pin holds only while nothing above what was the highest when it was made has been published.
	const pinned = target && above && VERSION.test(target) && versions.includes(target) && !versions.some((v) => compare(v, above) > 0);
	const stable = pinned ? target : top;
	const minors = {};
	for (const v of versions) if (!minors[minorOf(v)] || compare(v, minors[minorOf(v)]) > 0) minors[minorOf(v)] = v;
	if (pinned) minors[minorOf(target)] = target;
	if (current && VERSION.test(current) && compare(stable, current) < 0) {
		return { action: "refuse", stable: current, minors, why: `stable is on ${current}, above ${stable}: moving it down is a rollback, which is explicit (Publish's rollback_stable_to)` };
	}
	return { action: current === stable ? "keep" : "set", stable, minors, why: pinned ? `stable is held on ${target} by a rollback until a version above ${above} is published` : `${top} is the highest published version` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, json] = process.argv.slice(2);
	if (command !== "reconcile" || !json) throw new Error("usage: release-order.mjs reconcile '<json>'");
	const result = reconcile(JSON.parse(json));
	console.error(`${result.action}: ${result.why}`);
	console.log(JSON.stringify(result));
}
