// What ties a permission to a connector's tool: the digest it was chosen under, and what a different digest does to the choice.
import { describe, expect, it } from "vitest";
import { choiceChanged, toolDefinition } from "@pim/v2-app/tool-permissions";
import { resolvePermission } from "../src/connector-tools.ts";

const tool = { name: "update", description: "Update a page", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } };
const row = (permission: "off" | "ask" | "on", definition: string | null) => ({ audience: "agent:a", app: "c", tool: "update", permission, definition });

describe("tool definitions and permissions", () => {
	it("digests a tool by what it says, whatever the order of its keys", () => {
		expect(toolDefinition(tool)).toBe(toolDefinition({ annotations: tool.annotations, inputSchema: { properties: { id: { type: "string" } }, type: "object" }, description: tool.description }));
		expect(toolDefinition({ ...tool, description: "Update a page, and delete it" })).not.toBe(toolDefinition(tool));
		expect(toolDefinition({ ...tool, annotations: { destructiveHint: false } })).not.toBe(toolDefinition(tool));
	});

	it("downgrades On to Ask for the owner only when the digest differs, and a person's re-choice under the new digest holds", () => {
		const was = toolDefinition(tool);
		const now = toolDefinition({ ...tool, description: "changed" });
		expect(resolvePermission("c", tool, [row("on", was)], "a")).toEqual({ permission: "on", chosen: "on", changed: false });
		expect(resolvePermission("c", { ...tool, description: "changed" }, [row("on", was)], "a")).toEqual({ permission: "ask", chosen: "on", changed: true });
		expect(resolvePermission("c", { ...tool, description: "changed" }, [row("on", now)], "a")).toEqual({ permission: "on", chosen: "on", changed: false });
		// Ask and Off stay as chosen, and a choice with no digest is trusted.
		expect(resolvePermission("c", { ...tool, description: "changed" }, [row("ask", was)], "a")).toMatchObject({ permission: "ask", changed: false });
		expect(resolvePermission("c", { ...tool, description: "changed" }, [row("off", was)], "a")).toMatchObject({ permission: "off", changed: false });
		expect(resolvePermission("c", { ...tool, description: "changed" }, [row("on", null)], "a")).toMatchObject({ permission: "on", changed: false });
	});

	it("takes anything but Off from a circle's guests when the tool changed", () => {
		expect(choiceChanged({ permission: "ask", definition: "x" }, "y", false)).toBe(true);
		expect(choiceChanged({ permission: "off", definition: "x" }, "y", false)).toBe(false);
		expect(choiceChanged({ permission: "ask", definition: "x" }, "y", true)).toBe(false);
	});
});
