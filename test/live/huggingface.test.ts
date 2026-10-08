import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { api, post, say, toolUse } from "../helpers";
import { faux } from "../worker";

/**
 * Live check against a real third-party MCP server: Hugging Face's
 * (huggingface.co/mcp), which serves skills over the MCP Skills extension
 * without sign-in. Run with `pnpm test:live`; it needs the network, and its
 * catalog may change, so it asserts shapes and behavior, not exact content.
 */

const HF = "https://huggingface.co/mcp";

describe("Hugging Face MCP server (live)", () => {
	it("connects, with its tools", async () => {
		const { status, body } = await post("/mcp", { name: "Hugging Face", url: HF });
		expect(status, JSON.stringify(body)).toBe(201);
		expect(body).toMatchObject({ id: "hugging_face", state: "ready" });
		const [app] = (await api("/mcp")).body.servers;
		expect(app.tools.length).toBeGreaterThan(0);
		expect(app.tools.every((tool: { name: string }) => tool.name.startsWith("hugging_face_"))).toBe(true);
	});

	it("reads its skills, with digests for every file", async () => {
		const { skills } = (await api("/mcp/hugging_face/skills")).body;
		expect(skills.length).toBeGreaterThan(0);
		const cli = skills.find((skill: { name: string }) => skill.name === "hf-cli");
		expect(cli).toMatchObject({ uri: "skill://hf-cli/SKILL.md", description: expect.any(String) });
		expect(cli.files).toContainEqual({ uri: "skill://hf-cli/SKILL.md", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), size: expect.any(Number) });
		// It does not implement Events: the probe finds none, and nothing breaks.
		expect((await api("/mcp/hugging_face/events")).body.events).toEqual([]);
	});

	it("lists its skills in the prompt and loads one, verified against its digest", async () => {
		let system = "";
		let results = "";
		faux.setResponses([
			(context) => {
				system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
				return toolUse("read_skill", { app: "Hugging Face", skill: "hf-cli" });
			},
			(context: { messages: Message[] }) => {
				results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("Loaded.");
			},
		]);
		await say("How do I download a model with the hf CLI?");
		expect(system).toContain("Skills from Hugging Face (load with read_skill):\\n- hf-cli: ");
		expect(results).toContain('Skill \\"hf-cli\\" from the app Hugging Face (skill://hf-cli/SKILL.md).');
		expect(results).toContain("name: hf-cli");
		expect(results).not.toContain("does not match the digest");
	});
});
