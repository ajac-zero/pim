import { ControlCoordinator } from "../src/computer-control-runtime";
import { bridgeFor, PROVIDER_KEY } from "../src/cua";

/**
 * The preview's one-shot Cua fixture: it makes one space of a local preview
 * (wrangler.preview.jsonc, never deployed) use an operator's Cua computer, so
 * a bridge can be qualified against a real Pim. It does for that one space
 * what only tests do otherwise (docs/cua-bridge.md, "What is not done"):
 * stores the space's marker, enables its control state, and gives the agent
 * a lease. Nothing in `src/` calls it, and it adds no route, RPC method,
 * tool or setting: the preview's `Pim` runs it from its constructor, before
 * the space answers anything or sets up its agents' tools.
 *
 * It runs only when the preview's private environment opts in, with
 * `PREVIEW_CUA_FIXTURE=seed`, and names the space, by owner ID, in
 * `PREVIEW_CUA_FIXTURE_OWNER`; every other space is left as it is. The
 * space's bridge stays in the preview's `CUA_BRIDGES`, and nothing of it is
 * stored or logged.
 *
 * It seeds a space once, and only a fresh one. Before it changes anything it
 * checks that the space is provisioned for its owner, that `CUA_BRIDGES` has
 * a usable bridge for exactly that owner, and that the space holds no marker,
 * no control state (of any kind, readable or not), no paired computer and no
 * Sprite. A refusal there changes nothing, and is checked again at the next
 * start. Then, in this order:
 *
 * 1. `FIXTURE_KEY` is stored as `seeding`, and waited on until it is on disk.
 *    From here on the fixture never runs for this space again.
 * 2. In one transaction: the marker, the control state (enabled, then resumed
 *    under `LEASE_ID`), and `FIXTURE_KEY` as `seeded`. Either all of it is
 *    stored or none of it, so the space is either seeded or as it was.
 *
 * At a later start, `seeded` does nothing: the space's marker and control
 * state are its own from then on, whatever they have become (an unknown
 * request, a blocked state, the person in control). Nothing is re-enabled,
 * resumed, renewed or repaired. `seeding` means an earlier start stopped or
 * failed between the two steps: nothing is done, and the space keeps no
 * marker and no control state, so it reaches no operator's computer. The
 * operator starts again with a fresh preview (see docs/cua-bridge.md).
 *
 * The transaction writes through its own `ControlCoordinator`, never the
 * space's: if a write fails, that coordinator latches and is dropped with
 * the transaction, and the space's own coordinator, made later, reads only
 * what was stored. If step 1 can't be stored, nothing else is, and the next
 * start tries again, as before any change.
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
	/** Resolves once what was written is on disk. */
	sync(): Promise<void>;
};

export type FixtureResult =
	/** Not opted in, or another space: nothing was read or written. */
	| { outcome: "off" | "other-space" }
	/** This start seeded the space. */
	| { outcome: "seeded" }
	/** An earlier start seeded it, or began to: nothing was done. */
	| { outcome: "already-seeded" | "interrupted" }
	/** Refused before any change. */
	| { outcome: "refused"; reason: "owner" | "record" | "space" | "bridge" | "marker" | "control" | "computer" }
	/** Failed while changing the space: `record` with nothing stored, or `seed` with only `seeding` stored. */
	| { outcome: "failed"; reason: "record" | "seed" };

/** Seeds `space` if the preview's environment names it, once; never throws. */
export async function seedCuaFixture(space: FixtureSpace, env: Record<string, unknown>): Promise<FixtureResult> {
	if (env.PREVIEW_CUA_FIXTURE !== "seed") return { outcome: "off" };
	const owner = env.PREVIEW_CUA_FIXTURE_OWNER;
	const result = await seed(space, owner, env.CUA_BRIDGES);
	if (result.outcome === "other-space") return result;
	// Fixed words and the space's own name only: never the bridge, its token, or what was thrown.
	const line = JSON.stringify({ event: "preview.cua_fixture", space: space.name ?? null, ...result });
	if (result.outcome === "seeded" || result.outcome === "already-seeded") console.log(line);
	else console.warn(line);
	return result;
}

async function seed(space: FixtureSpace, owner: unknown, bridges: unknown): Promise<FixtureResult> {
	if (typeof owner !== "string" || !OWNER.test(owner)) return { outcome: "refused", reason: "owner" };
	if (space.name !== owner) return { outcome: "other-space" };
	const { meta } = space;
	try {
		const record = meta.meta(FIXTURE_KEY);
		if (record === "seeded") return { outcome: "already-seeded" };
		if (record === "seeding") return { outcome: "interrupted" };
		if (record !== undefined) return { outcome: "refused", reason: "record" };
		if (!provisioned(meta.meta(PROFILE_KEY), owner)) return { outcome: "refused", reason: "space" };
		if (!usable(bridges, owner)) return { outcome: "refused", reason: "bridge" };
		if (meta.meta(PROVIDER_KEY) !== undefined) return { outcome: "refused", reason: "marker" };
		if (meta.meta(CONTROL_KEY) !== undefined) return { outcome: "refused", reason: "control" };
		if (COMPUTER_KEYS.some((key) => meta.meta(key) !== undefined)) return { outcome: "refused", reason: "computer" };
	} catch {
		// Storage that can't be read is refused like a conflict: nothing is written.
		return { outcome: "refused", reason: "record" };
	}

	try {
		meta.setMeta(FIXTURE_KEY, "seeding");
		await space.sync();
	} catch {
		return { outcome: "failed", reason: "record" };
	}

	try {
		space.transaction(() => {
			// Checked again in the transaction, so it changes nothing it didn't check.
			if (meta.meta(FIXTURE_KEY) !== "seeding" || meta.meta(PROVIDER_KEY) !== undefined || meta.meta(CONTROL_KEY) !== undefined) throw new Error("changed");
			meta.setMeta(PROVIDER_KEY, JSON.stringify({ provider: "cua", space: owner }));
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
