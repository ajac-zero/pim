// The conformance suite every workspace backend must pass. A backend's test file calls `runConformanceSuite` with a way to make a fresh provider; passing the same cases is what shows the loop is not tied to one backend. Cases that depend on an optional capability are registered as skipped, with the reason in their name, so a skip is always visible.

import { afterEach, describe, expect, it } from "vitest";
import { type ExecEvent, type Workspace, WorkspaceCapacityError, WorkspaceNotFoundError, type WorkspaceProvider, type WorkspaceRef, type WorkspaceSpec, WorkspaceUnsupportedError } from "./types";

export type ConformanceOptions = {
	/** Fields of the spec to replace, such as the image a real backend needs. */
	spec?: Partial<Omit<WorkspaceSpec, "sessionId">>;
	/** Proves the backend enforces a resource limit: it should make a workspace with a small limit and fail unless going past it is refused. Without it the limit case is skipped. */
	checkLimit?: (provider: WorkspaceProvider, spec: WorkspaceSpec) => Promise<void>;
	/** A URL on a host in `allow` and one outside it, for the egress case. Defaults to made-up hosts, which suits only backends that do not really connect. */
	egress?: { allow: string; allowedUrl: string; blockedUrl: string };
	/** Starts a background process in a workspace and tells whether it is still there, to prove a suspend ends processes and keeps files. Without it that part of the suspend case is skipped. */
	process?: { start: (workspace: Workspace) => Promise<void>; alive: (workspace: Workspace) => Promise<boolean> };
};

const decode = (data: Uint8Array) => new TextDecoder().decode(data);
const encode = (text: string) => new TextEncoder().encode(text);

/** Runs a command to its end and gathers what it printed. */
async function run(workspace: Workspace, cmd: string[], o: { timeoutMs?: number; signal?: AbortSignal; stdin?: string } = {}) {
	const events: ExecEvent[] = [];
	for await (const event of workspace.exec(cmd, { timeoutMs: 10_000, ...o })) events.push(event);
	const exits = events.filter((event) => event.type === "exit");
	expect(exits).toHaveLength(1);
	expect(events[events.length - 1]).toBe(exits[0]);
	const text = (type: "stdout" | "stderr") => events.map((event) => (event.type === type ? event.data : "")).join("");
	return { stdout: text("stdout"), stderr: text("stderr"), exit: exits[0] as Extract<ExecEvent, { type: "exit" }> };
}

export function runConformanceSuite(name: string, makeProvider: () => WorkspaceProvider, opts: ConformanceOptions = {}): void {
	const capabilities = makeProvider().capabilities;
	const created: { provider: WorkspaceProvider; ref: WorkspaceRef }[] = [];
	let sessions = 0;

	const specFor = (overrides: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
		sessionId: `conformance-${++sessions}`,
		image: "default",
		repo: { url: "https://example.test/repo.git", ref: "main", branch: "work" },
		limits: { cpu: 1, memMiB: 256, diskMiB: 64, pids: 64, wallClockMin: 5 },
		egress: { allow: [] },
		gitAuth: { mode: "none" },
		...opts.spec,
		...overrides,
	});

	async function open(provider = makeProvider(), overrides: Partial<WorkspaceSpec> = {}) {
		const spec = specFor(overrides);
		const ref = await provider.create(spec);
		created.push({ provider, ref });
		const workspace = await provider.get(ref);
		if (!workspace) throw new Error("A workspace that was just created could not be opened");
		return { provider, spec, ref, workspace };
	}

	// Gated cases are skipped with their reason in the name, never passed silently.
	const gated = (enabled: boolean, reason: string, title: string, body: () => Promise<void>) => (enabled ? it(title, body) : it.skip(`${title} (skipped: ${reason})`, body));

	afterEach(async () => {
		for (const { provider, ref } of created.splice(0)) await provider.destroy(ref);
	});

	describe(`workspace conformance: ${name}`, () => {
		it("creates idempotently per session and destroys idempotently", async () => {
			const { provider, spec, ref } = await open();
			expect(await provider.create(spec)).toEqual(ref);
			expect(await provider.list({ sessionId: spec.sessionId })).toHaveLength(1);
			expect(await (await provider.get(ref))?.status()).toMatchObject({ state: "running" });
			await provider.destroy(ref);
			await provider.destroy(ref);
			expect(await provider.get(ref)).toBeNull();
			expect(await provider.list({ sessionId: spec.sessionId })).toEqual([]);
		});

		it("lists workspaces and narrows by session", async () => {
			const first = await open();
			const second = await open(first.provider);
			const all = (await first.provider.list()).map((info) => info.ref.id);
			expect(all).toEqual(expect.arrayContaining([first.ref.id, second.ref.id]));
			expect((await first.provider.list({ sessionId: second.spec.sessionId })).map((info) => info.ref.id)).toEqual([second.ref.id]);
		});

		it("streams stdout and stderr and reports the exit code", async () => {
			const { workspace } = await open();
			const result = await run(workspace, ["sh", "-c", "echo out; echo err >&2; exit 3"]);
			expect(result.stdout).toBe("out\n");
			expect(result.stderr).toBe("err\n");
			expect(result.exit).toMatchObject({ code: 3 });
			expect(result.exit.timedOut).toBeFalsy();
			expect((await run(workspace, ["echo", "hi"])).exit.code).toBe(0);
		});

		it("passes stdin to the command", async () => {
			const { workspace } = await open();
			expect((await run(workspace, ["cat"], { stdin: "piped" })).stdout).toBe("piped");
		});

		it("kills a command that outlives its timeout and reports timedOut", async () => {
			const { workspace } = await open();
			const started = Date.now();
			const { exit } = await run(workspace, ["sleep", "30"], { timeoutMs: 200 });
			expect(exit).toMatchObject({ code: null, timedOut: true });
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		it("kills a command when its signal aborts, without reporting timedOut", async () => {
			const { workspace } = await open();
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 100);
			const started = Date.now();
			const { exit } = await run(workspace, ["sleep", "30"], { signal: controller.signal });
			expect(exit.code).toBeNull();
			expect(exit.timedOut).toBeFalsy();
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		it("round-trips files, binary data and modes, making parent directories", async () => {
			const { workspace } = await open();
			const binary = new Uint8Array([0, 255, 1, 254, 128, 10, 13]);
			await workspace.writeFile("/workspace/a/b/blob.bin", binary, 0o755);
			expect(Array.from(await workspace.readFile("a/b/blob.bin"))).toEqual(Array.from(binary));
			expect((await workspace.stat("/workspace/a/b/blob.bin")).mode & 0o777).toBe(0o755);
			await workspace.writeFile("note.txt", encode("héllo"));
			expect(decode(await workspace.readFile("/workspace/note.txt"))).toBe("héllo");
			expect((await run(workspace, ["cat", "note.txt"])).stdout).toBe("héllo");
		});

		it("lists, stats and removes", async () => {
			const { workspace } = await open();
			await workspace.writeFile("d/one.txt", encode("1"));
			await workspace.writeFile("d/two.txt", encode("22"));
			expect((await workspace.list("d")).map((entry) => entry.name)).toEqual(["one.txt", "two.txt"]);
			expect(await workspace.stat("d/two.txt")).toMatchObject({ type: "file", size: 2 });
			expect(await workspace.stat("d")).toMatchObject({ type: "dir" });
			await workspace.remove("d/one.txt");
			await expect(workspace.stat("d/one.txt")).rejects.toThrow();
			await expect(workspace.readFile("d/one.txt")).rejects.toThrow();
			await workspace.remove("d");
			await expect(workspace.list("d")).rejects.toThrow();
			await expect(workspace.remove("d")).rejects.toThrow();
		});

		it("rejects paths that leave /workspace", async () => {
			const { workspace } = await open();
			for (const path of ["/etc/passwd", "../etc/passwd", "/workspace/../etc/passwd", "a/../../x", "/workspace/.."]) {
				await expect(workspace.readFile(path), path).rejects.toThrow();
				await expect(workspace.writeFile(path, encode("x")), path).rejects.toThrow();
				await expect(workspace.stat(path), path).rejects.toThrow();
				await expect(workspace.remove(path), path).rejects.toThrow();
			}
			await expect(workspace.list("/")).rejects.toThrow();
			await workspace.writeFile("inside/../ok.txt", encode("fine"));
			expect(decode(await workspace.readFile("/workspace/ok.txt"))).toBe("fine");
		});

		it("rejects access through a symlink that points outside /workspace", async () => {
			const { workspace } = await open();
			expect((await run(workspace, ["ln", "-s", "/etc", "escape"])).exit.code).toBe(0);
			expect((await run(workspace, ["ln", "-s", "/etc/hostname", "escape-file"])).exit.code).toBe(0);
			await expect(workspace.readFile("escape/hostname")).rejects.toThrow();
			await expect(workspace.readFile("escape-file")).rejects.toThrow();
			await expect(workspace.writeFile("escape/planted", encode("x"))).rejects.toThrow();
			await expect(workspace.list("escape")).rejects.toThrow();
			// A link inside the workspace is fine, and removing a link leaves its target.
			await workspace.writeFile("real.txt", encode("real"));
			await run(workspace, ["ln", "-s", "real.txt", "inner"]);
			expect(decode(await workspace.readFile("inner"))).toBe("real");
			await workspace.remove("inner");
			expect(decode(await workspace.readFile("real.txt"))).toBe("real");
		});

		gated(opts.checkLimit !== undefined, "the suite was given no checkLimit hook", "enforces resource limits", async () => {
			const provider = makeProvider();
			await opts.checkLimit?.(provider, specFor());
		});

		gated(capabilities.egressAllowlist, "the provider does not enforce an egress allowlist", "refuses hosts outside the egress allowlist", async () => {
			const egress = opts.egress ?? { allow: "allowed.test", allowedUrl: "http://allowed.test/", blockedUrl: "http://blocked.test/" };
			const { workspace } = await open(makeProvider(), { egress: { allow: [egress.allow] } });
			expect((await run(workspace, ["curl", "-sS", egress.allowedUrl])).exit.code).toBe(0);
			expect((await run(workspace, ["curl", "-sS", egress.blockedUrl])).exit.code).not.toBe(0);
		});

		gated(capabilities.snapshot, "the provider cannot snapshot", "restores a snapshot", async () => {
			const { workspace } = await open();
			await workspace.writeFile("keep.txt", encode("before"));
			const snapshot = await workspace.snapshot();
			await workspace.writeFile("keep.txt", encode("after"));
			await workspace.writeFile("extra.txt", encode("new"));
			await workspace.restore(snapshot);
			expect(decode(await workspace.readFile("keep.txt"))).toBe("before");
			await expect(workspace.readFile("extra.txt")).rejects.toThrow();
		});

		gated(capabilities.environmentSnapshots, "the provider keeps no environment snapshots", "keeps environment snapshots per person and restores one into a new workspace", async () => {
			const provider = makeProvider();
			const repo = "acme/demo";
			const ada = { userId: "ada", repo };
			const key = "0123456789abcdef".repeat(4);
			const { ref, workspace } = await open(provider, { environment: ada });
			await workspace.writeFile("repo/node_modules/dep/index.js", encode("installed"));
			expect(await provider.snapshotEnvironment(ref, { ...ada, key })).toMatchObject({ key, repo });
			// The same key again is the snapshot already kept.
			expect(await provider.snapshotEnvironment(ref, { ...ada, key })).toMatchObject({ key, repo });
			expect((await provider.listEnvironments(ada)).map((s) => s.key)).toEqual([key]);
			// Another person sees none of it, can't snapshot a workspace that isn't theirs, restore from it or delete it.
			const bob = { userId: "bob", repo };
			expect(await provider.listEnvironments(bob)).toEqual([]);
			await expect(provider.snapshotEnvironment(ref, { ...bob, key })).rejects.toThrow();
			await expect(provider.create(specFor({ environment: { ...bob, restoreFrom: key } }))).rejects.toThrow();
			expect(await provider.deleteEnvironment("bob", key)).toBe(false);
			// A new workspace of the same person starts from it; one of another repository can't.
			const restored = await open(provider, { environment: { ...ada, restoreFrom: key } });
			expect(decode(await restored.workspace.readFile("repo/node_modules/dep/index.js"))).toBe("installed");
			await expect(provider.create(specFor({ environment: { userId: "ada", repo: "acme/other", restoreFrom: key } }))).rejects.toThrow();
			expect(await provider.deleteEnvironment("ada", key)).toBe(true);
			expect(await provider.listEnvironments(ada)).toEqual([]);
			await expect(provider.create(specFor({ environment: { ...ada, restoreFrom: key } }))).rejects.toThrow();
		});

		it("moves between running and stopped, keeping files", async () => {
			const { workspace } = await open();
			await workspace.writeFile("kept.txt", encode("still here"));
			await workspace.stop();
			expect((await workspace.status()).state).toBe("stopped");
			await workspace.stop();
			await workspace.start();
			expect((await workspace.status()).state).toBe("running");
			expect(decode(await workspace.readFile("kept.txt"))).toBe("still here");
			expect((await run(workspace, ["echo", "back"])).stdout).toBe("back\n");
		});

		it("reports a destroyed workspace as gone and keeps its volume on request", async () => {
			const { provider, spec, ref, workspace } = await open();
			await workspace.writeFile("volume.txt", encode("kept"));
			await provider.destroy(ref, { keepVolume: true });
			expect((await workspace.status()).state).toBe("gone");
			expect(await provider.get(ref)).toBeNull();
			const again = await provider.create(spec);
			created.push({ provider, ref: again });
			expect(decode(await (await provider.get(again))!.readFile("volume.txt"))).toBe("kept");
		});

		it("declares how long sessions last, whether it needs keepalives, and whether it suspends", () => {
			const { sessionMaxMin, keepAlive, suspendResume, egressInjection } = capabilities;
			expect(sessionMaxMin === null || (Number.isFinite(sessionMaxMin) && sessionMaxMin > 0)).toBe(true);
			expect([typeof keepAlive, typeof suspendResume, typeof egressInjection]).toEqual(["boolean", "boolean", "boolean"]);
		});

		gated(capabilities.suspendResume, "the provider can't suspend", "suspends a workspace keeping files and losing processes, and resumes it as one session", async () => {
			const { provider, spec, ref, workspace } = await open();
			await workspace.writeFile("kept.txt", encode("survives"));
			if (opts.process) {
				await opts.process.start(workspace);
				expect(await opts.process.alive(workspace)).toBe(true);
			}
			await provider.suspend(ref);
			expect((await (await provider.get(ref))?.status())?.state).toBe("stopped");
			// Suspending a suspended workspace does nothing.
			await provider.suspend(ref);
			const back = await provider.resumeOrCreate(ref, spec);
			expect(back).toEqual({ ref, resumed: true });
			const resumed = (await provider.get(back.ref))!;
			expect((await resumed.status()).state).toBe("running");
			expect(decode(await resumed.readFile("kept.txt"))).toBe("survives");
			if (opts.process) expect(await opts.process.alive(resumed)).toBe(false);
			expect((await run(resumed, ["echo", "again"])).stdout).toBe("again\n");
			// A running workspace is returned as it is.
			expect(await provider.resumeOrCreate(ref, spec)).toEqual({ ref, resumed: true });
		});

		gated(capabilities.suspendResume, "the provider can't suspend", "makes a workspace from the kept volume when the suspended one is gone", async () => {
			const { provider, spec, ref, workspace } = await open();
			await workspace.writeFile("volume.txt", encode("kept"));
			await provider.destroy(ref, { keepVolume: true });
			const made = await provider.resumeOrCreate(ref, spec);
			created.push({ provider, ref: made.ref });
			expect(made.resumed).toBe(false);
			expect(decode(await (await provider.get(made.ref))!.readFile("volume.txt"))).toBe("kept");
		});

		gated(!capabilities.suspendResume, "the provider suspends", "refuses to suspend, and resumeOrCreate returns the workspace it has", async () => {
			const { provider, spec, ref } = await open();
			await expect(provider.suspend(ref)).rejects.toBeInstanceOf(WorkspaceUnsupportedError);
			expect(await provider.resumeOrCreate(ref, spec)).toEqual({ ref, resumed: true });
		});

		it("takes keepalives for a workspace that exists, and refuses one that doesn't", async () => {
			const { provider, ref } = await open();
			await provider.keepAlive(ref);
			await provider.destroy(ref);
			if (capabilities.keepAlive) await expect(provider.keepAlive(ref)).rejects.toBeInstanceOf(WorkspaceNotFoundError);
			else await provider.keepAlive(ref);
		});

		gated(capabilities.egressInjection, "the provider doesn't inject credentials", "replaces the egress policy of a workspace", async () => {
			const { provider, ref } = await open();
			await provider.setEgress(ref, { allow: ["example.test"], inject: [{ host: "example.test", headers: { authorization: "Bearer x" } }] });
			await provider.destroy(ref);
			await expect(provider.setEgress(ref, { allow: [] })).rejects.toBeInstanceOf(WorkspaceNotFoundError);
		});

		gated(!capabilities.egressInjection, "the provider injects credentials", "refuses to replace an egress policy it can't inject", async () => {
			const { provider, ref } = await open();
			await expect(provider.setEgress(ref, { allow: [] })).rejects.toBeInstanceOf(WorkspaceUnsupportedError);
		});

		gated(capabilities.maxConcurrent !== undefined, "the provider declares no maxConcurrent", "refuses a workspace past its capacity", async () => {
			const provider = makeProvider();
			const max = provider.capabilities.maxConcurrent ?? 0;
			const first = await open(provider);
			for (let i = 1; i < max; i++) await open(provider);
			await expect(provider.create(specFor())).rejects.toBeInstanceOf(WorkspaceCapacityError);
			// Asking again for a session that already has a workspace is not a new one.
			expect(await provider.create(first.spec)).toEqual(first.ref);
			await provider.destroy(first.ref);
			await open(provider);
		});
	});
}
