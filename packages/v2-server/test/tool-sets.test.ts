// Which tools an agent has: one tool for what used to be several, none for what only a person does, and none of the owner's agent-management tools for an agent working a task.
import { describe, expect, it } from "vitest";
import { createCodingTools } from "@pim/coding/tools/index";
import { ADMIN_TOOL_NAMES } from "../src/admin-tools.ts";
import { pimExtension, WORKER_HIDDEN } from "../src/agent-tools.ts";
import { HOSTOPS_TOOL_NAMES, hostopsTools } from "../src/hostops/tools.ts";

const registered = (pimExtension({ ownerId: "o_".padEnd(28, "0"), partitionId: "", runtime: {} } as never, []).tools as unknown as { name: string }[]).map((t) => t.name);

describe("the tools of a Pim agent", () => {
	it("has one tool to read a coding thread, one to stop it, and none to push, open a pull request or merge", () => {
		expect(registered.filter((n) => n.startsWith("coding_")).sort()).toEqual(["coding_inspect", "coding_start", "coding_steer", "coding_stop"]);
	});

	it("has one tool for triggers, scheduled tasks and connector watches, apart from the person's grant for a computer source", () => {
		expect(registered.filter((n) => /trigger|schedul|watch|connector_event/.test(n)).sort()).toEqual(["trigger", "trigger_computer_grant"]);
	});

	it("reads another chat, and the part of a group chat before it joined, with one tool", () => {
		expect(registered).toContain("read_chat");
		expect(registered).not.toContain("chat_history");
	});

	it("has no tool twice, and every tool an agent handed a task never has exists", () => {
		expect(new Set(registered).size).toBe(registered.length);
		for (const name of WORKER_HIDDEN) expect(registered).toContain(name);
	});

	it("names every deployment tool an agent that is not the admin's majordomo or Pimbot is not offered", () => {
		expect([...ADMIN_TOOL_NAMES].sort()).toEqual(registered.filter((n) => /^(admin_|ui_(routes|read|write|audit)|pim_(diagnostics|health))/.test(n)).sort());
		expect([...HOSTOPS_TOOL_NAMES].sort()).toEqual(hostopsTools({ ownerId: "o_", partitionId: "", app: undefined, chatOf: async () => null }).map((t) => (t as unknown as { name: string }).name).sort());
		expect(HOSTOPS_TOOL_NAMES).toHaveLength(11);
		expect(registered).toEqual(expect.arrayContaining(["guest_tools", "guest_call"]));
	});

	it("gives a coding thread's own agent, in its workspace, no trigger, delegation or agent-management tool", () => {
		const names = createCodingTools({} as never).map((t) => (t as unknown as { name: string }).name);
		expect(names.length).toBeGreaterThan(0);
		for (const hidden of [...WORKER_HIDDEN, "coding_start", "coding_steer", "coding_inspect", "coding_stop"]) expect(names).not.toContain(hidden);
	});
});
