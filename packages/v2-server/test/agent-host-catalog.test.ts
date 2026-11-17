// The Runner keeps a partition resident while chats in it are active. A provider whose address changes in the meantime (an imported one pointed at a reachable host, a
// key rotated) must be what the next message runs on, not what the partition was opened with: a stale address failed every call with "Connection error" and never
// reached the server.
import { describe, expect, it } from "vitest";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { createAgentHost } from "../src/agent-host.ts";

describe("the agent host's model catalog", () => {
	it("follows a provider changed while the partition is resident", async () => {
		let url = "http://127.0.0.1:1/v1";
		const db = {
			read: async (_owner: string, sql: string) => {
				if (sql.includes("runner_providers")) return { rows: [{ p: [{ id: "pv_a", kind: "openai_compatible", config: { name: "A", url, models: [{ id: "m" }] }, secret: null }] }] };
				if (sql.includes("runner_context")) return { rows: [{ c: { username: "ada", agent: null, skills: [], goals: [], memories: [], contacts: [], fallbacks: [] } }] };
				return { rows: [] };
			},
		} as unknown as RuntimeDb;
		const host = createAgentHost({ db, env: {} });
		const options = await host.harnessOptions({ ownerId: "o_ada", partitionId: "p1" } as never);
		const models = options.models as { getModel(provider: string, id: string): { baseUrl: string } | undefined };
		expect(models.getModel("pv_a", "m")?.baseUrl).toBe("http://127.0.0.1:1/v1");
		url = "http://172.18.0.1:9/v1";
		// The next message in the chat sets its model, and sees the provider as it is now.
		expect(await host.chatAgent("o_ada", null as never)).toMatchObject({ model: expect.objectContaining({ provider: "pv_a" }) });
		expect(models.getModel("pv_a", "m")?.baseUrl).toBe("http://172.18.0.1:9/v1");
	});
});
