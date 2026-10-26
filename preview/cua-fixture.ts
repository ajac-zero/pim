import { ControlCoordinator } from "../src/computer-control-runtime";
import { bridgeFor, PROVIDER_KEY } from "../src/cua";

/**
 * The preview's one-shot Cua fixture: it makes one space of a local preview
 * (wrangler.preview.jsonc, never deployed) use an operator's Cua computer, so
 * a bridge can be qualified against a real Pim. It does for that one space
 * what only tests do otherwise (docs/cua-bridge.md): stores the space's
 * marker, enables its control state, and gives the agent a lease. Nothing in
 * `src/` calls it, and it adds no route, RPC method, tool or setting: the
 * preview's `Pim` runs it in its constructor, before the space answers
 * anything or sets up its agents' tools, and refuses to construct the space
 * at all unless `starts` says it may.
 *
 * It seeds only when the preview's private environment opts in, with
 * `PREVIEW_CUA_FIXTURE=seed`, and names the space, by owner ID, in
 * `PREVIEW_CUA_FIXTURE_OWNER`. The space's bridge stays in the preview's
 * `CUA_BRIDGES`, and nothing of it is stored or logged.
 *
 * It seeds a space once, and only a fresh one. Before it changes anything it
 * checks that the space is provisioned for its owner, that `CUA_BRIDGES` has
 * a usable bridge for exactly that owner, and that the space holds no marker,
 * no control state (of any kind, readable or not), no paired computer and no
 * Sprite. A refusal there changes nothing, and the space named doesn't start
 * while the environment names it. Then, in one synchronous turn of the
 * constructor:
 *
 * 1. `FIXTURE_KEY` is stored as `seeding`. From here on the fixture never
 *    seeds this space again.
 * 2. In one transaction: the marker, the control state (enabled, then resumed
 *    under `LEASE_ID`), and `FIXTURE_KEY` as `seeded`. If any of it fails,
 *    the transaction keeps none of it, `seeding` stays, and the space doesn't
 *    start.
 *
 * The Durable Object's storage commits a turn's writes together, so a
 * process that dies, or a commit that fails, before the turn ends stores
 * none of them; the next start then can't know a seed was tried, and is a
 * first start. That is the one failure it can't record.
 *
 * The record is checked at every start of every space, whatever the
 * environment says. `seeded` starts the space, untouched, as long as its
 * marker is still the one stored: its control state is its own from then
 * on, whatever it has become (an unknown request, a blocked state, the
 * person in control), and nothing is re-enabled, resumed, renewed or
 * repaired. `seeding`, or `seeded` without the marker, never starts again,
 * as such a space would otherwise use the default computer. Only tearing
 * down the preview's state undoes it.
 *
 * The transaction writes through its own `ControlCoordinator`, never the
 * space's: if a write fails, that coordinator latches and is dropped with
 * the transaction, and the space doesn't start, so no other coordinator
 * reads what it left.
 */

/** Where the space keeps how far the fixture got: `seeding`, then `seeded`. */
export const FIXTURE_KEY = "preview_cua_fixture";
/** The lease the fixture gives the agent: a bookkeeping name, not a credential. */
export const LEASE_ID = "preview-cua-fixture";

/** What `src/pim.ts` keeps the control state, the owner's profile, a paired computer's token and a Sprite under. */
const CONTROL_KEY = "computer_control";
const PROFILE_KEY = "owner";
const COMPUTER_KEYS = ["computer_token", "computer_machine"];

/** As `src/cua.ts` checks a bridge before it connects; `Cua.connect` checks it again on every connection. */
const OWNER = /^o_[0-9a-z]{26}$/;
const TOKEN = /^[\x21-\x7e]{32,4096}$/;

/** What the fixture reaches of the space it runs in. */
export type FixtureSpace = {
	/** The Durable Object's own name: its owner's ID. */
	readonly name: string | undefined;
	/** The space's metadata (`pim_meta`), read and written at once. */
	readonly meta: { meta(key: string): string | undefined; setMeta(key: string, value: string): void };
	/** Runs `fn` as one transaction of the space's storage: if it throws, nothing it wrote is kept. */
	transaction<T>(fn: () => T): T;
};

export type FixtureResult =
	/** Not opted in, or another space, and no record: the space starts as it always does. */
	| { outcome: "off" | "other-space" }
	/** Seeded at this start, or at an earlier one with its marker still in place: the space starts. */
	| { outcome: "seeded" | "already-seeded" }
	/** An earlier start began and didn't finish: the space doesn't start. */
	| { outcome: "interrupted" }
	/**
	 * Not seeded, and nothing changed. `owner` (the environment names no
	 * owner ID it could be) selects no space, so every space starts; for the
	 * others, the space named doesn't.
	 */
	| { outcome: "refused"; reason: "owner" | "record" | "space" | "bridge" | "marker" | "control" | "computer" }
	/** Failed while changing the space, which doesn't start: `record` with nothing stored, or `seed` with only `seeding` stored. */
	| { outcome: "failed"; reason: "record" | "seed" };

/** Whether the space may start after `result`: a space the fixture began on, or was asked to seed and didn't, never does. */
export function starts(result: FixtureResult): boolean {
	switch (result.outcome) {
		case "off":
		case "other-space":
		case "seeded":
		case "already-seeded":
			return true;
		case "refused":
			return result.reason === "owner";
		default:
			return false;
	}
}

/** Seeds `space` if the preview's environment names it, once; never throws. */
export function seedCuaFixture(space: FixtureSpace, env: Record<string, unknown>): FixtureResult {
	const result = seed(space, env);
	if (result.outcome === "off" || result.outcome === "other-space") return result;
	// Fixed words and the space's own name only: never the bridge, its token, or what was thrown.
	const line = JSON.stringify({ event: "preview.cua_fixture", space: space.name ?? null, ...result });
	if (starts(result)) console.log(line);
	else console.warn(line);
	return result;
}

function seed(space: FixtureSpace, env: Record<string, unknown>): FixtureResult {
	const { meta, name } = space;
	let record: string | undefined;
	try {
		record = meta.meta(FIXTURE_KEY);
		// A space the fixture seeded starts only with the marker it stored, whatever the environment says now.
		if (record === "seeded") return name !== undefined && meta.meta(PROVIDER_KEY) === marker(name) ? { outcome: "already-seeded" } : { outcome: "refused", reason: "marker" };
	} catch {
		return { outcome: "refused", reason: "record" };
	}
	if (record === "seeding") return { outcome: "interrupted" };
	if (record !== undefined) return { outcome: "refused", reason: "record" };

	if (env.PREVIEW_CUA_FIXTURE !== "seed") return { outcome: "off" };
	const owner = env.PREVIEW_CUA_FIXTURE_OWNER;
	if (typeof owner !== "string" || !OWNER.test(owner)) return { outcome: "refused", reason: "owner" };
	if (name !== owner) return { outcome: "other-space" };
	try {
		if (!provisioned(meta.meta(PROFILE_KEY), owner)) return { outcome: "refused", reason: "space" };
		if (!usable(env.CUA_BRIDGES, owner)) return { outcome: "refused", reason: "bridge" };
		if (meta.meta(PROVIDER_KEY) !== undefined) return { outcome: "refused", reason: "marker" };
		if (meta.meta(CONTROL_KEY) !== undefined) return { outcome: "refused", reason: "control" };
		if (COMPUTER_KEYS.some((key) => meta.meta(key) !== undefined)) return { outcome: "refused", reason: "computer" };
	} catch {
		// Storage that can't be read is refused like a conflict: nothing is written.
		return { outcome: "refused", reason: "record" };
	}

	try {
		meta.setMeta(FIXTURE_KEY, "seeding");
	} catch {
		return { outcome: "failed", reason: "record" };
	}
	try {
		space.transaction(() => {
			meta.setMeta(PROVIDER_KEY, marker(owner));
			const control = new ControlCoordinator(owner, { read: () => meta.meta(CONTROL_KEY), write: (value) => meta.setMeta(CONTROL_KEY, value) });
			control.enable();
			if (!control.apply({ type: "resume", leaseId: LEASE_ID }).ok || control.state?.owner !== "agent") throw new Error("not leased");
			meta.setMeta(FIXTURE_KEY, "seeded");
		});
	} catch {
		return { outcome: "failed", reason: "seed" };
	}
	return { outcome: "seeded" };
}

/** The marker that makes `owner`'s space use its Cua computer (`src/cua.ts`). */
const marker = (owner: string) => JSON.stringify({ provider: "cua", space: owner });

/** Whether the space is provisioned for `owner`, as `Pim.provision` records it. */
function provisioned(profile: string | undefined, owner: string): boolean {
	try {
		return profile !== undefined && (JSON.parse(profile) as { ownerId?: unknown }).ownerId === owner;
	} catch {
		return false;
	}
}

/** Whether `CUA_BRIDGES` has a bridge for exactly `owner` that `Cua.connect` would try: HTTPS with no credentials, query or fragment, and a well-formed token. */
function usable(secret: unknown, owner: string): boolean {
	let bridge: { url: string; token: string };
	try {
		bridge = bridgeFor(secret, owner);
	} catch {
		return false;
	}
	let url: URL;
	try {
		url = new URL(bridge.url);
	} catch {
		return false;
	}
	return url.protocol === "https:" && !url.username && !url.password && !bridge.url.includes("?") && !bridge.url.includes("#") && TOKEN.test(bridge.token);
}
