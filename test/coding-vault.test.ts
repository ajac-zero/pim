import { getAgentByName } from "agents";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { codingScheduler } from "../src/coding/scheduler-do";
import { codingThreadId } from "../src/coding/threads";
import { ArchiveError, type ArchiveFile, MAX_ARCHIVE_BYTES, MAX_ARCHIVE_FILES, packArchive, unpackArchive } from "../src/coding/vault/archive";
import { openBlob, sealBlob, VaultUnreadableError, vaultKey } from "../src/coding/vault/crypto";
import { HARNESS_FILES } from "../src/coding/vault/harnesses";
import { harnessEnv, restoreHarnessCredentials, VaultOwnershipError, writeBackHarnessCredentials } from "../src/coding/vault/inject";
import { MAX_SEALED_BYTES } from "../src/coding/vault/store";
import { CodingVault, codingVault, type Ownership, spaceVaultBackend, threadOwnership } from "../src/coding/vault/vault";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import type { WorkspaceSpec } from "../src/coding/workspace/types";
import { api, apiUrl, OWNER, TOKEN } from "./helpers";

// The coding vault: the sealed archive of a harness CLI's login, kept in each person's own space and put only into
// their own workspaces. The login's bytes carry MARKER, which must never reach a response or a log line.

const MARKER = "sk-VAULT-MARKER-7f3a9c";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const AUTH = { path: "auth.json", mode: 0o600, data: encoder.encode(`{"tokens":{"access_token":"${MARKER}"}}`) };
const CONFIG = { path: "config.toml", mode: 0o644, data: encoder.encode('model = "gpt-5-codex"\n') };
const CODEX = HARNESS_FILES.codex.files;
const text = (file: ArchiveFile | undefined) => (file ? decoder.decode(file.data) : undefined);

/** Another person on this Pim, with a token for their own space. */
let other = "";
let otherToken = "";

beforeAll(async () => {
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username: "other", ip: "192.0.2.2", claim: { window: true }, policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 } });
	if (!registered.ok) throw new Error(registered.error);
	other = registered.account.ownerId;
	await directory.activate(other);
	await (await getAgentByName(env.Pim, other)).provision({ ownerId: other, username: "other" });
	otherToken = (await env.Auth.getByName(other).createToken(other, "tests", Date.now())).token;
});

// Everything written to the console while a test runs, to check that no login's bytes are logged.
let logged: string[] = [];
beforeEach(() => {
	logged = [];
	for (const method of ["log", "info", "warn", "error", "debug"] as const) {
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? `${arg.name}: ${arg.message}` : JSON.stringify(arg))).join(" "));
		});
	}
});

afterEach(async () => {
	expect(logged.join("\n")).not.toContain(MARKER);
	vi.restoreAllMocks();
	for (const user of [OWNER, other]) for (const harness of ["codex", "claude-code"] as const) await codingVault(env).delete(user, harness);
});

describe("sealing", () => {
	const secret = crypto.getRandomValues(new Uint8Array(32));
	const plaintext = packArchive([AUTH], CODEX);

	it("opens what it sealed, for the same person and harness, and seals with a fresh nonce each time", async () => {
		const key = await vaultKey(secret);
		const one = await sealBlob(key, { userId: "ada", harness: "codex" }, plaintext);
		const two = await sealBlob(key, { userId: "ada", harness: "codex" }, plaintext);
		expect(one).not.toEqual(two);
		expect(decoder.decode(one)).not.toContain(MARKER);
		expect(await openBlob(key, { userId: "ada", harness: "codex" }, one)).toEqual(plaintext);
		expect(await openBlob(await vaultKey(secret), { userId: "ada", harness: "codex" }, two)).toEqual(plaintext);
	});

	it("refuses a blob for another person or harness, edited anywhere, or under another key", async () => {
		const key = await vaultKey(secret);
		const sealed = await sealBlob(key, { userId: "ada", harness: "codex" }, plaintext);
		const refused = (promise: Promise<unknown>) => expect(promise).rejects.toBeInstanceOf(VaultUnreadableError);
		await refused(openBlob(key, { userId: "bob", harness: "codex" }, sealed));
		await refused(openBlob(key, { userId: "ada", harness: "claude-code" }, sealed));
		// A person id that only differs where a naive join would blur it.
		await refused(openBlob(key, { userId: "ada\ncodex", harness: "codex" }, sealed));
		for (const at of [1, 12, 13, sealed.byteLength - 1]) {
			const edited = sealed.slice();
			edited[at]! ^= 1;
			await refused(openBlob(key, { userId: "ada", harness: "codex" }, edited));
		}
		const reformatted = sealed.slice();
		reformatted[0] = 2;
		await refused(openBlob(key, { userId: "ada", harness: "codex" }, reformatted));
		await refused(openBlob(key, { userId: "ada", harness: "codex" }, sealed.slice(0, 20)));
		const otherKey = new Uint8Array(secret);
		otherKey[0]! ^= 1;
		await refused(openBlob(await vaultKey(otherKey), { userId: "ada", harness: "codex" }, sealed));
	});
});

describe("archives", () => {
	it("pack the same files to the same bytes in any order, and unpack them as they were", () => {
		const packed = packArchive([CONFIG, AUTH], CODEX);
		expect(packArchive([AUTH, CONFIG], CODEX)).toEqual(packed);
		const files = unpackArchive(packed, CODEX);
		expect(files.map((file) => [file.path, file.mode, text(file)])).toEqual([
			["auth.json", 0o600, text(AUTH)],
			["config.toml", 0o644, text(CONFIG)],
		]);
	});

	it("refuse paths that leave the directory, aren't plain, or aren't on the list", () => {
		const bad = ["/etc/passwd", "../auth.json", "a/../auth.json", "./auth.json", "a//b", "a/", "a\\b", "a\u0000b", "x".repeat(256), ""];
		for (const path of bad) expect(() => packArchive([{ ...AUTH, path }]), path).toThrow(ArchiveError);
		expect(() => packArchive([{ ...AUTH, path: "sessions/rollout.jsonl" }], CODEX)).toThrow(ArchiveError);
		expect(() => packArchive([{ ...AUTH, path: ".claude.json" }], CODEX)).toThrow(ArchiveError);
		// Without an allowlist, a nested relative path is fine.
		expect(unpackArchive(packArchive([{ ...AUTH, path: "a/b.json" }]))[0]!.path).toBe("a/b.json");
	});

	it("refuse symlinks, directories, duplicates, odd modes, and too many or too big files", () => {
		expect(() => packArchive([{ ...AUTH, type: "symlink" }], CODEX)).toThrow(ArchiveError);
		expect(() => packArchive([{ ...AUTH, type: "dir" }], CODEX)).toThrow(ArchiveError);
		expect(() => packArchive([AUTH, AUTH], CODEX)).toThrow(ArchiveError);
		expect(() => packArchive([{ ...AUTH, mode: 0o4755 }], CODEX)).toThrow(ArchiveError);
		expect(() => packArchive([{ ...AUTH, mode: -1 }], CODEX)).toThrow(ArchiveError);
		const many = Array.from({ length: MAX_ARCHIVE_FILES + 1 }, (_, i) => ({ path: `f${i}`, mode: 0o600, data: new Uint8Array(1) }));
		expect(() => packArchive(many)).toThrow(ArchiveError);
		expect(() => packArchive(many.slice(0, MAX_ARCHIVE_FILES))).not.toThrow();
		// Just under the cap packs; one byte more doesn't.
		const header = 7 + 8 + "auth.json".length;
		expect(packArchive([{ ...AUTH, data: new Uint8Array(MAX_ARCHIVE_BYTES - header) }], CODEX).byteLength).toBe(MAX_ARCHIVE_BYTES);
		expect(() => packArchive([{ ...AUTH, data: new Uint8Array(MAX_ARCHIVE_BYTES - header + 1) }], CODEX)).toThrow(ArchiveError);
	});

	/** An archive written by hand, as a hostile one would be. */
	function handmade(entries: { path: Uint8Array | string; mode?: number; size?: number; data?: Uint8Array }[], options: { count?: number; format?: number; trailing?: number } = {}): Uint8Array {
		const parts: number[] = [0x50, 0x43, 0x56, 0x41, options.format ?? 1, 0, options.count ?? entries.length];
		for (const entry of entries) {
			const path = typeof entry.path === "string" ? encoder.encode(entry.path) : entry.path;
			const data = entry.data ?? new Uint8Array(2);
			const size = entry.size ?? data.byteLength;
			const mode = entry.mode ?? 0o600;
			parts.push(path.byteLength >> 8, path.byteLength & 0xff, ...path, mode >> 8, mode & 0xff, (size >>> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff, ...data);
		}
		for (let i = 0; i < (options.trailing ?? 0); i++) parts.push(0);
		return new Uint8Array(parts);
	}

	it("refuse hostile bytes when unpacking", () => {
		expect(unpackArchive(handmade([{ path: "auth.json" }]), CODEX)[0]!.path).toBe("auth.json");
		const refused = (bytes: Uint8Array, allowed: readonly string[] | undefined = CODEX) => expect(() => unpackArchive(bytes, allowed)).toThrow(ArchiveError);
		refused(handmade([{ path: "../auth.json" }]), undefined);
		refused(handmade([{ path: "/workspace/.bashrc" }]), undefined);
		refused(handmade([{ path: ".bashrc" }]));
		refused(handmade([{ path: new Uint8Array([0xc3, 0x28]) }]), undefined);
		refused(handmade([{ path: "auth.json" }, { path: "auth.json" }]));
		refused(handmade([{ path: "auth.json", mode: 0o4755 }]));
		refused(handmade([{ path: "auth.json", size: 0xffffffff }]));
		refused(handmade([{ path: "auth.json" }], { count: 2 }));
		refused(handmade([{ path: "auth.json" }], { trailing: 1 }));
		refused(handmade([{ path: "auth.json" }], { format: 2 }));
		refused(handmade([], { count: MAX_ARCHIVE_FILES + 1 }));
		refused(new Uint8Array([1, 2, 3]));
		refused(new Uint8Array(MAX_ARCHIVE_BYTES + 1));
		const good = handmade([{ path: "auth.json" }, { path: "config.toml" }]);
		for (let length = 0; length < good.byteLength; length++) refused(good.slice(0, length));
	});
});

describe("the vault", () => {
	it("keeps a sealed archive in the person's space, with what can be said of it without opening it", async () => {
		const vault = codingVault(env);
		const start = (await vault.load(OWNER, "codex")).version;
		expect(await vault.save(OWNER, "codex", [AUTH, CONFIG], start)).toEqual({ ok: true, version: start + 1 });
		const status = (await vault.status(OWNER)).find((entry) => entry.harness === "codex")!;
		expect(status).toMatchObject({ connected: true, byteLength: packArchive([AUTH, CONFIG]).byteLength, version: start + 1 });
		expect(status.updatedAt).toBeGreaterThan(Date.now() - 60_000);
		expect((await vault.status(OWNER)).find((entry) => entry.harness === "claude-code")).toMatchObject({ connected: false, byteLength: null });
		// The space holds ciphertext only.
		const record = await spaceVaultBackend(env).read(OWNER, "codex");
		expect(decoder.decode(record.sealed!)).not.toContain(MARKER);
		const loaded = await vault.load(OWNER, "codex");
		expect(loaded.unreadable).toBe(false);
		expect(loaded.files?.map(text)).toEqual([text(AUTH), text(CONFIG)]);
		// The other person's space has nothing of it.
		expect(await vault.load(other, "codex")).toEqual({ version: 0, files: null, unreadable: false });
	});

	it("refuses an archive over the cap, and a sealed blob too big or of the wrong size", async () => {
		const vault = codingVault(env);
		await expect(vault.save(OWNER, "codex", [{ ...AUTH, data: new Uint8Array(MAX_ARCHIVE_BYTES) }], 0)).rejects.toBeInstanceOf(ArchiveError);
		const backend = spaceVaultBackend(env);
		await expect(backend.write(OWNER, "codex", new Uint8Array(MAX_SEALED_BYTES + 1), MAX_SEALED_BYTES + 1 - 29, 0)).rejects.toThrow();
		await expect(backend.write(OWNER, "codex", new Uint8Array(100), 10, 0)).rejects.toThrow();
		expect((await vault.status(OWNER)).every((entry) => !entry.connected)).toBe(true);
	});

	it("refuses a write based on an older version, and never repeats a version after a disconnect", async () => {
		const vault = codingVault(env);
		const start = (await vault.load(OWNER, "codex")).version;
		expect(await vault.save(OWNER, "codex", [AUTH], start)).toEqual({ ok: true, version: start + 1 });
		expect(await vault.save(OWNER, "codex", [CONFIG], start)).toEqual({ ok: false, version: start + 1 });
		expect((await vault.delete(OWNER, "codex")).connected).toBe(false);
		// A write based on the deleted login doesn't bring it back.
		expect(await vault.save(OWNER, "codex", [AUTH], start + 1)).toEqual({ ok: false, version: start + 2 });
		expect((await vault.load(OWNER, "codex")).files).toBeNull();
		// Disconnecting what isn't connected changes nothing.
		expect((await vault.delete(OWNER, "codex")).version).toBe(start + 2);
	});

	it("treats an entry that doesn't open as the person's as none, so another person's blob is never restored", async () => {
		const real = spaceVaultBackend(env);
		await codingVault(env).save(OWNER, "codex", [AUTH], (await real.read(OWNER, "codex")).version);
		// A backend that misroutes: whoever asks gets OWNER's sealed blob.
		const misrouted = new CodingVault({ ...real, read: (_user, harness) => real.read(OWNER, harness) }, codingVault(env).key);
		expect(await misrouted.load(other, "codex")).toMatchObject({ files: null, unreadable: true });
		// The same blob filed as another harness doesn't open either.
		const swapped = new CodingVault({ ...real, read: (user) => real.read(user, "codex") }, codingVault(env).key);
		expect(await swapped.load(OWNER, "claude-code")).toMatchObject({ files: null, unreadable: true });
		expect(logged.some((line) => line.includes("pim.coding.vault_unreadable"))).toBe(true);
	});
});

describe("harness workspaces", () => {
	const spec = (sessionId: string): WorkspaceSpec => ({
		sessionId,
		image: "pim-workspace:test",
		repo: { url: "https://example.test/repo.git", ref: "main", branch: "main" },
		limits: { cpu: 1, memMiB: 512, diskMiB: 64, pids: 64, wallClockMin: 10 },
		egress: { allow: [] },
		gitAuth: { mode: "none" },
	});

	/** A thread of `user`'s, registered in their space's list as starting one does, and a workspace for it. */
	async function threadOf(user: string, provider: FakeWorkspaceProvider) {
		const threadId = await codingThreadId(user, crypto.randomUUID());
		await codingScheduler(env, user).registerThread({ threadId, createdBy: { type: "person" }, parent: null, chat: null, harness: "pi", task: "t", repo: "https://github.com/acme/demo", ref: "main", budgetUsd: 1, createdAt: Date.now() });
		const ref = await provider.create(spec(threadId));
		return { userId: user, ref, workspace: (await provider.get(ref))! };
	}

	const owns = () => threadOwnership(env);
	const read = async (target: { workspace: { readFile(p: string): Promise<Uint8Array> } }, path: string) => decoder.decode(await target.workspace.readFile(path));

	it("puts the login in the CLI's config directory for the owner alone, keeps what the CLI changed, and clears it afterwards", async () => {
		const vault = codingVault(env);
		const provider = new FakeWorkspaceProvider();
		const target = await threadOf(OWNER, provider);
		const base = (await vault.load(OWNER, "codex")).version;
		await vault.save(OWNER, "codex", [AUTH, CONFIG], base);
		expect(harnessEnv("codex")).toEqual({ CODEX_HOME: "/workspace/.codex" });
		const restored = await restoreHarnessCredentials(vault, owns(), target, "codex");
		expect(restored).toMatchObject({ connected: true, version: base + 1, sessionId: target.ref.sessionId });
		expect(await read(target, "/workspace/.codex/auth.json")).toBe(text(AUTH));
		// config.toml was 0644 in the archive, and is written for its owner alone.
		expect((await target.workspace.list("/workspace/.codex")).map((file) => [file.name, file.mode])).toEqual([
			["auth.json", 0o600],
			["config.toml", 0o600],
		]);
		// Nothing changed: nothing written.
		expect(await writeBackHarnessCredentials(vault, owns(), restored, target, { scrub: false })).toEqual({ outcome: "unchanged", version: base + 1 });
		// The CLI refreshed its token, and wrote a session log, which isn't kept.
		const refreshed = `{"tokens":{"access_token":"${MARKER}-refreshed"}}`;
		await target.workspace.writeFile("/workspace/.codex/auth.json", encoder.encode(refreshed), 0o600);
		await target.workspace.writeFile("/workspace/.codex/sessions/rollout.jsonl", encoder.encode("{}"), 0o600);
		expect(await writeBackHarnessCredentials(vault, owns(), restored, target)).toEqual({ outcome: "saved", version: base + 2 });
		expect((await vault.load(OWNER, "codex")).files?.map((file) => file.path)).toEqual(["auth.json", "config.toml"]);
		expect(text((await vault.load(OWNER, "codex")).files?.[0])).toBe(refreshed);
		// Scrubbed: the login is gone from the workspace, the CLI's session log stays.
		expect((await target.workspace.list("/workspace/.codex")).map((file) => file.name)).toEqual(["sessions"]);
	});

	it("never puts one person's login in another person's workspace", async () => {
		const vault = codingVault(env);
		const provider = new FakeWorkspaceProvider();
		await vault.save(OWNER, "codex", [AUTH], (await vault.load(OWNER, "codex")).version);
		const theirs = await threadOf(other, provider);
		// Claiming OWNER for the other person's workspace is refused, and nothing is written.
		await expect(restoreHarnessCredentials(vault, owns(), { ...theirs, userId: OWNER }, "codex")).rejects.toBeInstanceOf(VaultOwnershipError);
		expect((await theirs.workspace.list("/workspace")).map((file) => file.name)).not.toContain(".codex");
		// As themselves, they get their own vault, which is empty.
		const restored = await restoreHarnessCredentials(vault, owns(), theirs, "codex");
		expect(restored).toMatchObject({ connected: false, userId: other });
		// A workspace whose session isn't any thread of OWNER's is refused too.
		const stray = new FakeWorkspaceProvider();
		const ref = await stray.create(spec(crypto.randomUUID()));
		await expect(restoreHarnessCredentials(vault, owns(), { userId: OWNER, ref, workspace: (await stray.get(ref))! }, "codex")).rejects.toBeInstanceOf(VaultOwnershipError);
		// Writing back what the other person's workspace holds into OWNER's vault is refused.
		const mine = await threadOf(OWNER, provider);
		const minesRestored = await restoreHarnessCredentials(vault, owns(), mine, "codex");
		await theirs.workspace.writeFile("/workspace/.codex/auth.json", encoder.encode("{}"), 0o600);
		await expect(writeBackHarnessCredentials(vault, owns(), minesRestored, theirs)).rejects.toBeInstanceOf(VaultOwnershipError);
		await expect(writeBackHarnessCredentials(vault, owns(), minesRestored, { ...theirs, userId: OWNER })).rejects.toBeInstanceOf(VaultOwnershipError);
		expect(text((await vault.load(OWNER, "codex")).files?.[0])).toBe(text(AUTH));
	});

	it("lets the first write-back win when two workspaces refresh the same login, and drops one after a disconnect", async () => {
		const vault = codingVault(env);
		const provider = new FakeWorkspaceProvider();
		const base = (await vault.load(OWNER, "codex")).version;
		await vault.save(OWNER, "codex", [AUTH], base);
		const [one, two] = [await threadOf(OWNER, provider), await threadOf(OWNER, provider)];
		const [restoredOne, restoredTwo] = [await restoreHarnessCredentials(vault, owns(), one, "codex"), await restoreHarnessCredentials(vault, owns(), two, "codex")];
		await one.workspace.writeFile("/workspace/.codex/auth.json", encoder.encode('{"from":"one"}'), 0o600);
		await two.workspace.writeFile("/workspace/.codex/auth.json", encoder.encode('{"from":"two"}'), 0o600);
		expect(await writeBackHarnessCredentials(vault, owns(), restoredOne, one)).toEqual({ outcome: "saved", version: base + 2 });
		// The second read the login before the first wrote: it doesn't overwrite the newer one.
		expect(await writeBackHarnessCredentials(vault, owns(), restoredTwo, two)).toEqual({ outcome: "conflict", version: base + 2 });
		expect(text((await vault.load(OWNER, "codex")).files?.[0])).toBe('{"from":"one"}');
		// Disconnected while a run was under way: its write-back doesn't bring the login back.
		const restoredAgain = await restoreHarnessCredentials(vault, owns(), one, "codex");
		await vault.delete(OWNER, "codex");
		await one.workspace.writeFile("/workspace/.codex/auth.json", encoder.encode('{"from":"late"}'), 0o600);
		expect((await writeBackHarnessCredentials(vault, owns(), restoredAgain, one)).outcome).toBe("conflict");
		expect((await vault.status(OWNER)).find((entry) => entry.harness === "codex")?.connected).toBe(false);
		// A run that started with nothing, and signed in, keeps its new login.
		const fresh = await restoreHarnessCredentials(vault, owns(), two, "codex");
		expect(fresh.connected).toBe(false);
		await two.workspace.writeFile("/workspace/.codex/auth.json", encoder.encode('{"from":"login"}'), 0o600);
		expect((await writeBackHarnessCredentials(vault, owns(), fresh, two)).outcome).toBe("saved");
		expect(text((await vault.load(OWNER, "codex")).files?.[0])).toBe('{"from":"login"}');
	});

	it("never writes through or keeps a symlink", async () => {
		const vault = codingVault(env);
		const provider = new FakeWorkspaceProvider();
		const target = await threadOf(OWNER, provider);
		await vault.save(OWNER, "codex", [AUTH], (await vault.load(OWNER, "codex")).version);
		const run = async (command: string[]) => {
			for await (const event of target.workspace.exec(command, { timeoutMs: 1000 })) if (event.type === "exit") expect(event.code).toBe(0);
		};
		// Something in the workspace pointed auth.json into the repository before the run.
		await target.workspace.writeFile("/workspace/repo/leak.txt", encoder.encode("repo file"));
		await run(["ln", "-s", "/workspace/repo/leak.txt", "/workspace/.codex/auth.json"]);
		const restored = await restoreHarnessCredentials(vault, owns(), target, "codex");
		expect(await read(target, "/workspace/repo/leak.txt")).toBe("repo file");
		expect((await target.workspace.list("/workspace/.codex")).find((file) => file.name === "auth.json")?.type).toBe("file");
		// And during it: the write-back keeps nothing, and the link is removed.
		await target.workspace.remove("/workspace/.codex/auth.json");
		await run(["ln", "-s", "/workspace/repo/leak.txt", "/workspace/.codex/auth.json"]);
		expect((await writeBackHarnessCredentials(vault, owns(), restored, target)).outcome).toBe("refused");
		expect(text((await vault.load(OWNER, "codex")).files?.[0])).toBe(text(AUTH));
		expect(await target.workspace.list("/workspace/.codex")).toEqual([]);
		expect(await read(target, "/workspace/repo/leak.txt")).toBe("repo file");
		// A config directory that is itself a link is replaced by a real one.
		await target.workspace.remove("/workspace/.codex");
		await run(["ln", "-s", "/workspace/repo", "/workspace/.codex"]);
		await restoreHarnessCredentials(vault, owns(), target, "codex");
		expect((await target.workspace.list("/workspace")).find((file) => file.name === ".codex")?.type).toBe("dir");
		expect((await target.workspace.list("/workspace/repo")).map((file) => file.name)).toEqual(["leak.txt"]);
	});
});

describe("the API", () => {
	const asOther = (path: string, init: RequestInit = {}) =>
		exports.default.fetch(new Request(apiUrl(path), { ...init, headers: { Authorization: `Bearer ${otherToken}`, "content-type": "application/json" } }));

	it("says whether each harness is connected, never what it holds, and disconnects only the person's own", async () => {
		const vault = codingVault(env);
		await vault.save(OWNER, "codex", [AUTH, CONFIG], (await vault.load(OWNER, "codex")).version);
		const raw = await exports.default.fetch(new Request(apiUrl("/coding/vault"), { headers: { Authorization: `Bearer ${TOKEN}` } }));
		const body = await raw.text();
		expect(raw.status).toBe(200);
		expect(body).not.toContain(MARKER);
		const { harnesses } = JSON.parse(body) as { harnesses: Record<string, unknown>[] };
		expect(harnesses.map((entry) => Object.keys(entry).sort())).toEqual([
			["byteLength", "connected", "harness", "updatedAt"],
			["byteLength", "connected", "harness", "updatedAt"],
		]);
		expect(harnesses).toMatchObject([
			{ harness: "claude-code", connected: false, byteLength: null },
			{ harness: "codex", connected: true, byteLength: packArchive([AUTH, CONFIG]).byteLength },
		]);
		expect((await api("/coding/vault/codex")).body).toMatchObject({ harness: "codex", connected: true });
		expect((await api("/coding/vault/gemini")).status).toBe(404);

		// The other person sees and disconnects only their own.
		expect(((await (await asOther("/coding/vault/codex")).json()) as { connected: boolean }).connected).toBe(false);
		expect((await asOther("/coding/vault/codex", { method: "DELETE" })).status).toBe(200);
		expect((await api("/coding/vault/codex")).body.connected).toBe(true);

		const deleted = await api("/coding/vault/codex", { method: "DELETE" });
		expect(deleted).toMatchObject({ status: 200, body: { harness: "codex", connected: false, byteLength: null } });
		expect((await vault.load(OWNER, "codex")).files).toBeNull();
		// No route writes or reads a login's contents.
		expect((await api("/coding/vault/codex", { method: "PUT", body: "{}" })).status).toBe(405);
		expect((await api("/coding/vault/codex/blob")).status).toBe(404);
	});
});
