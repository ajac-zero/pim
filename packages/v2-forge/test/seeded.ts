import { WorkspaceAgentComputeProvider } from "../src/workspace-agent";
import type { ComputeHandle, ComputeSpec } from "../src/compute";

/** What the manager's clone leaves: the repository's checkout directory. */
export class Seeded extends WorkspaceAgentComputeProvider {
	override async create(tag: string, spec: ComputeSpec): Promise<ComputeHandle> {
		const h = await super.create(tag, spec);
		await (await this.workspace(h)).writeFile("/workspace/repo/.keep", new Uint8Array());
		return h;
	}
}
