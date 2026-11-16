import { describe, expect, it } from "vitest";
import { CachingVaultBackend } from "../src/vault/read-cache";
import type { VaultBackend } from "../src/vault/vault";

function backend() {
	const reads: string[] = [];
	let release: (() => void) | null = null;
	let hold: Promise<void> | null = null;
	const sealed = new Map<string, number>();
	const inner: VaultBackend = {
		status: async () => [],
		read: async (user, harness) => {
			reads.push(`${user}/${harness}`);
			if (hold) await hold;
			const version = sealed.get(`${user}/${harness}`) ?? 0;
			return { version, sealed: version ? new Uint8Array([version]) : null };
		},
		write: async (user, harness, _sealed, _n, expected) => {
			const version = sealed.get(`${user}/${harness}`) ?? 0;
			if (version !== expected) return { ok: false, version };
			sealed.set(`${user}/${harness}`, version + 1);
			return { ok: true, version: version + 1 };
		},
		delete: async (user, harness) => {
			sealed.delete(`${user}/${harness}`);
			return { harness: harness as "amp", connected: false, updatedAt: null, byteLength: null, version: 0 };
		},
	};
	return { inner, reads, sealed, pause: () => (hold = new Promise<void>((resolve) => (release = resolve))), resume: () => { release?.(); hold = null; } };
}

describe("CachingVaultBackend", () => {
	it("reads an entry once within the TTL, and again after it", async () => {
		const b = backend();
		b.sealed.set("u/amp", 1);
		let now = 0;
		const cache = new CachingVaultBackend(b.inner, 1000, 10, () => now);
		await cache.read("u", "amp");
		now = 999;
		await cache.read("u", "amp");
		expect(b.reads).toHaveLength(1);
		now = 1000;
		await cache.read("u", "amp");
		expect(b.reads).toHaveLength(2);
	});

	it("keeps people and harnesses apart", async () => {
		const b = backend();
		b.sealed.set("u/amp", 1);
		b.sealed.set("v/amp", 2);
		b.sealed.set("u/claude-code", 3);
		const cache = new CachingVaultBackend(b.inner);
		expect((await cache.read("u", "amp")).version).toBe(1);
		expect((await cache.read("v", "amp")).version).toBe(2);
		expect((await cache.read("u", "claude-code" as never)).version).toBe(3);
		expect((await cache.read("u", "amp")).version).toBe(1);
		expect(b.reads).toHaveLength(3);
	});

	it("shares one read among concurrent callers", async () => {
		const b = backend();
		b.sealed.set("u/amp", 1);
		b.pause();
		const cache = new CachingVaultBackend(b.inner);
		const all = Promise.all([cache.read("u", "amp"), cache.read("u", "amp"), cache.read("u", "amp")]);
		b.resume();
		expect((await all).map((record) => record.version)).toEqual([1, 1, 1]);
		expect(b.reads).toHaveLength(1);
	});

	it("forgets an entry when it is written, deleted or invalidated, and doesn't keep a read that began before", async () => {
		const b = backend();
		b.sealed.set("u/amp", 1);
		const cache = new CachingVaultBackend(b.inner);
		await cache.read("u", "amp");
		await cache.write("u", "amp", new Uint8Array(), 0, 1);
		expect((await cache.read("u", "amp")).version).toBe(2);
		await cache.delete("u", "amp");
		expect((await cache.read("u", "amp")).sealed).toBeNull();
		b.sealed.set("u/amp", 5);
		await cache.read("u", "amp");
		cache.invalidate("u", "amp");
		b.sealed.set("u/amp", 6);
		expect((await cache.read("u", "amp")).version).toBe(6);
		// A read in flight when the key is rotated does not outlive the rotation.
		b.pause();
		const slow = cache.read("u", "amp");
		cache.invalidate("u");
		b.resume();
		await slow;
		b.sealed.set("u/amp", 7);
		expect((await cache.read("u", "amp")).version).toBe(7);
	});

	it("never keeps an entry that holds nothing, so connecting is seen at once", async () => {
		const b = backend();
		const cache = new CachingVaultBackend(b.inner);
		expect((await cache.read("u", "amp")).sealed).toBeNull();
		b.sealed.set("u/amp", 1);
		expect((await cache.read("u", "amp")).sealed).not.toBeNull();
	});

	it("reads fresh when asked, and keeps no more than its bound, dropping the least recently used", async () => {
		const b = backend();
		for (const user of ["a", "b", "c"]) b.sealed.set(`${user}/amp`, 1);
		const cache = new CachingVaultBackend(b.inner, 60_000, 2);
		await cache.read("a", "amp");
		await cache.read("b", "amp");
		await cache.read("a", "amp");
		await cache.read("c", "amp");
		expect(cache.size).toBe(2);
		b.reads.length = 0;
		await cache.read("a", "amp");
		await cache.read("c", "amp");
		expect(b.reads).toEqual([]);
		await cache.read("b", "amp");
		expect(b.reads).toEqual(["b/amp"]);
		await cache.read("a", "amp", { fresh: true });
		expect(b.reads).toEqual(["b/amp", "a/amp"]);
	});
});
