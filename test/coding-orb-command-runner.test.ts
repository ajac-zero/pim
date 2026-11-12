import { describe, expect, it, vi } from "vitest";
import { AmpCliOrbClient } from "../src/coding/orb/amp-cli";
import { SandboxCommandRunner } from "../src/coding/orb/command-runner";
import { ampOrbClients } from "../src/coding/orb/registry";
import { OrbAuthError, OrbUnreachableError } from "../src/coding/orb/types";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { workspaceRegistry } from "../src/coding/workspace/registry";
import type { ExecEvent, ExecOptions } from "../src/coding/workspace/types";
import { FakeCommandRunner } from "./fake-command-runner";

const TOKEN = "sgamp_runner_contract_secret";
const START = { project: "https://example.test/repo.git", prompt: "Fix it", mode: null, title: null, idempotencyKey: "turn-1" };
const keys = () => {
	const values = new Map<string, string>();
	return { get: async (key: string) => values.get(key) ?? null, set: async (key: string, value: string) => { values.set(key, value); } };
};

function sandbox(exec: (argv: string[], options: ExecOptions) => AsyncIterable<ExecEvent>) {
	const compose = new FakeWorkspaceProvider({ id: "compose" });
	const cloudflare = new FakeWorkspaceProvider({ id: "cloudflare" });
	const create = vi.spyOn(compose, "create");
	const destroy = vi.spyOn(compose, "destroy");
	const cloudCreate = vi.spyOn(cloudflare, "create");
	const get = compose.get.bind(compose);
	vi.spyOn(compose, "get").mockImplementation(async (ref) => {
		const workspace = (await get(ref))!;
		vi.spyOn(workspace, "exec").mockImplementation(exec);
		vi.spyOn(workspace, "writeFile").mockImplementation(() => { throw new Error("Must not write files"); });
		return workspace;
	});
	const loadApiKey = vi.fn(async (): Promise<string | null> => TOKEN);
	// Cloudflare is deliberately the default: this runner must never use it.
	const providers = () => workspaceRegistry([cloudflare, compose]);
	return { runner: new SandboxCommandRunner({ providers, loadApiKey }), compose, cloudflare, create, destroy, cloudCreate, loadApiKey, providers };
}

async function collect(events: AsyncIterable<ExecEvent>) {
	const out: ExecEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

describe("Amp control sandbox runner", () => {
	it("pins to compose, execs argv with the vault key only in env, and destroys the repository-free sandbox", async () => {
		const exec = vi.fn(async function* (_argv: string[], _options: ExecOptions): AsyncGenerator<ExecEvent> {
			yield { type: "stdout", data: "attached\n" };
			yield { type: "stderr", data: "warning\n" };
			yield { type: "exit", code: 7 };
		});
		const s = sandbox(exec);
		const argv = ["amp", "-ox", "--execute=Fix it"];
		expect(await collect(s.runner.run(argv).events)).toEqual([
			{ type: "stdout", data: "attached\n" }, { type: "stderr", data: "warning\n" }, { type: "exit", code: 7 },
		]);
		expect(s.cloudCreate).not.toHaveBeenCalled();
		expect(s.create).toHaveBeenCalledOnce();
		const spec = s.create.mock.calls[0]![0];
		expect(spec.sessionId).toMatch(/^amp-orb-/);
		expect(spec.repo.url).toBe("");
		expect(spec.environment).toBeUndefined();
		expect(JSON.stringify(spec)).not.toContain(TOKEN);
		expect(exec.mock.calls[0]![0]).toEqual(argv);
		expect(exec.mock.calls[0]![1]).toMatchObject({ cwd: "/workspace", env: { HOME: "/workspace", AMP_API_KEY: TOKEN, AMP_SKIP_UPDATE_CHECK: "1" } });
		expect(s.destroy).toHaveBeenCalledOnce();
	});

	it("redacts both output streams even when every possible token boundary splits exec chunks", async () => {
		for (let split = 1; split < TOKEN.length; split++) {
			const s = sandbox(async function* () {
				for (const type of ["stdout", "stderr"] as const) {
					yield { type, data: `before ${TOKEN.slice(0, split)}` };
					yield { type, data: `${TOKEN.slice(split)} after` };
				}
				yield { type: "exit", code: 0 };
			});
			const events = await collect(s.runner.run(["amp"]).events);
			for (const type of ["stdout", "stderr"] as const) {
				expect(events.filter((e) => e.type === type).map((e) => "data" in e ? e.data : "").join("")).toBe("before [redacted] after");
			}
		}
	});

	it("reports a missing vault key as typed auth failure without making a sandbox", async () => {
		const s = sandbox(async function* () { yield { type: "exit", code: 0 }; });
		s.loadApiKey.mockResolvedValue(null);
		const client = new AmpCliOrbClient({ runner: s.runner, keys: keys() });
		await expect(client.start(START)).rejects.toBeInstanceOf(OrbAuthError);
		expect(s.create).not.toHaveBeenCalled();
	});

	it("does not fall back when compose is unavailable", async () => {
		const cloudflare = new FakeWorkspaceProvider({ id: "cloudflare" });
		const create = vi.spyOn(cloudflare, "create");
		const runner = new SandboxCommandRunner({ providers: () => workspaceRegistry([cloudflare]), loadApiKey: async () => TOKEN });
		const client = new AmpCliOrbClient({ runner, keys: keys() });
		await expect(client.start(START)).rejects.toBeInstanceOf(OrbUnreachableError);
		expect(create).not.toHaveBeenCalled();
	});

	it("hides backend exceptions that might repeat the exec environment and cleans up", async () => {
		const s = sandbox(async function* () { throw new Error(`request env AMP_API_KEY=${TOKEN}`); });
		const events = await collect(s.runner.run(["amp"]).events);
		expect(JSON.stringify(events)).not.toContain(TOKEN);
		expect(events.at(-1)).toEqual({ type: "exit", code: 1 });
		expect(s.destroy).toHaveBeenCalledOnce();
	});

	it("kills an attached command through exec's signal and destroys its sandbox", async () => {
		let attached!: () => void;
		const ready = new Promise<void>((resolve) => { attached = resolve; });
		const s = sandbox(async function* (_argv, options) {
			const killed = new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
			attached();
			await killed;
			yield { type: "exit", code: null, signal: "SIGTERM" };
		});
		const command = s.runner.run(["amp"]);
		const events = collect(command.events);
		await ready;
		command.kill();
		expect((await events).at(-1)).toEqual({ type: "exit", code: null, signal: "SIGTERM" });
		expect(s.destroy).toHaveBeenCalledOnce();
	});

	it("does not provision a command killed before iteration", async () => {
		const s = sandbox(async function* () { yield { type: "exit", code: 0 }; });
		const command = s.runner.run(["amp"]);
		command.kill();
		expect(await collect(command.events)).toEqual([{ type: "exit", code: null, signal: "SIGTERM" }]);
		expect(s.loadApiKey).not.toHaveBeenCalled();
		expect(s.create).not.toHaveBeenCalled();
	});
});

describe("default Amp orb registration", () => {
	it("is available without a flag, reuses the live client for polls, and keeps start keys across factory restarts", async () => {
		const runner = new FakeCommandRunner();
		const options = { runner, keys: keys(), providers: () => workspaceRegistry([]), loadApiKey: async () => TOKEN };
		const context = { space: "ada", threadId: "coding-1", providerId: "amp-cli" };
		const factory = ampOrbClients(options);
		const client = (await factory(context))!;
		const orb = await client.start(START);
		expect(await factory(context)).toBe(client);
		expect((await client.state(orb.threadId)).state).toBe("working");
		const restarted = (await ampOrbClients(options)(context))!;
		expect(await restarted.start(START)).toEqual(orb);
		expect(runner.commands).toHaveLength(1);
		expect(await factory({ ...context, providerId: "unknown" })).toBeNull();
		await client.stop(orb.threadId);
	});

	it("uses the production runner by default and reads the key for the requesting space", async () => {
		const s = sandbox(async function* () { yield { type: "exit", code: 0 }; });
		const loadApiKey = vi.fn(async () => null);
		const factory = ampOrbClients({ providers: s.providers, keys: keys(), loadApiKey });
		const client = (await factory({ space: "ada", threadId: "coding-1", providerId: "amp-cli" }))!;
		await expect(client.start(START)).rejects.toBeInstanceOf(OrbAuthError);
		expect(loadApiKey).toHaveBeenCalledWith("ada");
		expect(s.create).not.toHaveBeenCalled();
	});
});
