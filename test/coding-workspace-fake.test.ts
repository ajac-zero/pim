import { expect } from "vitest";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { type ExecEvent, type Workspace, WorkspaceLimitError } from "../src/coding/workspace/types";

// The fake is pure logic, so these run in the Worker pool like the scheduler's tests but touch no binding.

/** What a command printed. */
async function printed(events: AsyncIterable<ExecEvent>) {
	let out = "";
	for await (const event of events) if (event.type === "stdout") out += event.data;
	return out;
}

/** A background process, as the fake's `spawn` and `ps` have them. */
const process = {
	start: async (workspace: Workspace) => void (await printed(workspace.exec(["spawn", "agent"], { timeoutMs: 5_000 }))),
	alive: async (workspace: Workspace) => (await printed(workspace.exec(["ps"], { timeoutMs: 5_000 }))).includes("agent"),
};

runConformanceSuite("fake", () => new FakeWorkspaceProvider({ maxConcurrent: 3 }), {
	process,
	checkLimit: async (provider, spec) => {
		const ref = await provider.create({ ...spec, limits: { ...spec.limits, diskMiB: 1 } });
		const workspace = await provider.get(ref);
		await expect(workspace?.writeFile("big.bin", new Uint8Array(2 * 1024 * 1024))).rejects.toBeInstanceOf(WorkspaceLimitError);
		await provider.destroy(ref);
	},
});

// The fake as a backend with a session cap, keepalives and credential injection, and as one that can't suspend, as Compose and Cloudflare can't.
runConformanceSuite("fake with a session cap, keepalive and injection", () => new FakeWorkspaceProvider({ sessionMaxMin: 1, keepAlive: true, egressInjection: true }), { process });
runConformanceSuite("fake without suspend", () => new FakeWorkspaceProvider({ suspendResume: false }));
