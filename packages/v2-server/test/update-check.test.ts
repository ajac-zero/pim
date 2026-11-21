// The update check: what it asks the registry (and when it must not), and when a published image counts as an update.
import { describe, expect, it } from "vitest";
import type { Db } from "@pim/v2-app/db";
import { checkForUpdate, CHECK_EVERY_MS, RETRY_AFTER_MS, releaseView, updateAvailable } from "../src/update-check.ts";

/** instance_settings as a map, which is all the check uses of the database. */
function fakeDb() {
	const rows = new Map<string, unknown>();
	const db = { anonymous: async (fn: (tx: any) => unknown) => fn({ query: async (sql: string, params: any[]) => (/^SELECT/.test(sql) ? { rows: rows.has(params[0]) ? [{ value: rows.get(params[0]) }] : [] } : (rows.set(params[0], JSON.parse(params[1])), { rows: [] })) }) } as unknown as Db;
	return { db, rows };
}

/** GHCR's anonymous API for one multi-platform tag: a grant, an index with an attestation first, the image, its config with the labels. */
function registry(labels: Record<string, string>, calls: string[] = []) {
	const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers });
	const fetcher = (async (url: string) => {
		calls.push(url);
		if (url.startsWith("https://ghcr.io/token?")) return json({ token: "grant" });
		if (url.endsWith("/manifests/stable") || url.endsWith("/manifests/edge")) return json({ manifests: [{ digest: "sha256:att", platform: { os: "unknown", architecture: "unknown" } }, { digest: "sha256:img", platform: { os: "linux", architecture: "amd64" } }] }, { "docker-content-digest": "sha256:index" });
		if (url.endsWith("/manifests/sha256:img")) return json({ config: { digest: "sha256:cfg" } });
		if (url.endsWith("/blobs/sha256:cfg")) return json({ config: { Labels: labels } });
		return new Response("", { status: 404 });
	}) as unknown as typeof fetch;
	return fetcher;
}

describe("update check", () => {
	const env = { PIM_VERSION: "1.2.0", PIM_REVISION: "a".repeat(40) };
	const labels = { "org.opencontainers.image.version": "1.3.0", "org.opencontainers.image.revision": "b".repeat(40) };

	it("reads the channel's tag from the registry and keeps it, then leaves the registry alone until the answer is old", async () => {
		const { db, rows } = fakeDb();
		const calls: string[] = [];
		const first = await checkForUpdate(db, env, { now: 1_000, fetcher: registry(labels, calls) });
		expect(first).toMatchObject({ channel: "stable", checkedAt: 1_000, error: null, latest: { version: "1.3.0", revision: "b".repeat(40), digest: "sha256:index" } });
		expect(calls[0]).toContain("repository:ajac-zero/pim:pull");
		expect(calls).toContain("https://ghcr.io/v2/ajac-zero/pim/manifests/sha256:img");
		expect(rows.get("update_check")).toEqual(first);
		const asked = calls.length;
		expect(await checkForUpdate(db, env, { now: 1_000 + CHECK_EVERY_MS - 1, fetcher: registry(labels, calls) })).toBeNull();
		expect(calls.length).toBe(asked);
		expect(await checkForUpdate(db, env, { now: 1_000 + CHECK_EVERY_MS, fetcher: registry(labels, calls) })).not.toBeNull();
		// "Check now" asks whatever the age of the answer.
		expect(await checkForUpdate(db, env, { now: 2_000, fetcher: registry(labels, calls), force: true })).toMatchObject({ checkedAt: 2_000 });
		expect(calls.length).toBeGreaterThan(asked);
		// Another channel is asked at once.
		expect(await checkForUpdate(db, { ...env, PIM_CHANNEL: "edge" }, { now: 1_001 + CHECK_EVERY_MS, fetcher: registry(labels, calls) })).toMatchObject({ channel: "edge" });
	});

	it("makes no request at all with PIM_UPDATE_CHECK=off, or for a local build", async () => {
		const { db, rows } = fakeDb();
		const calls: string[] = [];
		expect(await checkForUpdate(db, { ...env, PIM_UPDATE_CHECK: "off" }, { fetcher: registry(labels, calls) })).toBeNull();
		expect(await checkForUpdate(db, { PIM_VERSION: "dev" }, { fetcher: registry(labels, calls) })).toBeNull();
		expect(calls).toEqual([]);
		expect(rows.size).toBe(0);
		// And what the screen is told is "off", with nothing found, even if a record from before is there.
		expect(releaseView({ ...env, PIM_UPDATE_CHECK: "off" }, { channel: "stable", checkedAt: 1, latest: { version: "9.0.0", revision: null, digest: null }, error: null })).toMatchObject({ check: "off", available: false, latest: null });
	});

	it("keeps the last answer when the registry fails, and tries again sooner than for a good answer", async () => {
		const { db } = fakeDb();
		await checkForUpdate(db, env, { now: 0, fetcher: registry(labels) });
		const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		const failed = await checkForUpdate(db, env, { now: CHECK_EVERY_MS, fetcher: down });
		expect(failed).toMatchObject({ error: expect.stringContaining("503"), latest: { version: "1.3.0" } });
		expect(await checkForUpdate(db, env, { now: CHECK_EVERY_MS + RETRY_AFTER_MS - 1, fetcher: down })).toBeNull();
		expect(await checkForUpdate(db, env, { now: CHECK_EVERY_MS + RETRY_AFTER_MS, fetcher: registry(labels) })).toMatchObject({ error: null });
	});

	it("offers a newer version on stable and a different commit on edge, and never an older or the same one", () => {
		const run = (version: string, revision = "unknown") => ({ version, revision, channel: "stable" });
		const pub = (version: string | null, revision: string | null = null) => ({ version, revision, digest: null });
		expect(updateAvailable(run("1.2.0"), pub("1.2.1"))).toBe(true);
		expect(updateAvailable(run("1.2.9"), pub("1.10.0"))).toBe(true); // not a string comparison
		expect(updateAvailable(run("1.2.0"), pub("1.2.0", "x"))).toBe(false);
		expect(updateAvailable(run("2.0.0"), pub("1.9.9"))).toBe(false);
		expect(updateAvailable(run("edge", "a".repeat(40)), pub("edge", "b".repeat(40)))).toBe(true);
		expect(updateAvailable(run("edge", "a".repeat(40)), pub("edge", "a".repeat(12)))).toBe(false); // sha-<12> against the full commit
		expect(updateAvailable(run("dev"), pub("edge", "b".repeat(40)))).toBe(false); // a local build is not told to update
		expect(updateAvailable(run("1.2.0"), null)).toBe(false);
	});

	it("links the release notes of a version, or the commit of an edge image", () => {
		expect(releaseView(env, { channel: "stable", checkedAt: 5, error: null, latest: { version: "1.3.0", revision: "b".repeat(40), digest: null } }).latest?.notesUrl).toBe("https://github.com/ajac-zero/pim/releases/tag/v1.3.0");
		expect(releaseView({ ...env, PIM_CHANNEL: "edge" }, { channel: "edge", checkedAt: 5, error: null, latest: { version: "edge", revision: "b".repeat(40), digest: null } }).latest?.notesUrl).toBe(`https://github.com/ajac-zero/pim/commit/${"b".repeat(40)}`);
	});
});
