import { expect } from "vitest";
import { runConformanceSuite } from "../src/coding/workspace/conformance";
import { FakeWorkspaceProvider } from "../src/coding/workspace/fake";
import { WorkspaceLimitError } from "../src/coding/workspace/types";

// The fake is pure logic, so these run in the Worker pool like the scheduler's tests but touch no binding.

runConformanceSuite("fake", () => new FakeWorkspaceProvider({ maxConcurrent: 3 }), {
	checkLimit: async (provider, spec) => {
		const ref = await provider.create({ ...spec, limits: { ...spec.limits, diskMiB: 1 } });
		const workspace = await provider.get(ref);
		await expect(workspace?.writeFile("big.bin", new Uint8Array(2 * 1024 * 1024))).rejects.toBeInstanceOf(WorkspaceLimitError);
		await provider.destroy(ref);
	},
});
