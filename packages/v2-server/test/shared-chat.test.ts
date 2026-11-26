// What a chat's public copy keeps of the projected transcript: what the person said and what their agent sent them, never its reasoning, tool calls, results or images.
import { describe, expect, it } from "vitest";
import type { TranscriptMessage } from "@pim/shared/transcript";
import { sharedMessages } from "../src/shared-chat.ts";

const user = (id: string, ...parts: TranscriptMessage["parts"][number][]): TranscriptMessage => ({ id, role: "user", parts, timestamp: 1 });
const sends = (id: string, callId: string, args: object): TranscriptMessage => ({ id, role: "assistant", timestamp: 2, parts: [{ type: "thinking", text: "They want Lisbon." }, { type: "text", text: "Private working note." }, { type: "tool-call", id: callId, name: "send_to_user", arguments: args as never }] });
const result = (id: string, callId: string, text: string, error = false): TranscriptMessage => ({ id, role: "tool", timestamp: 3, parts: [{ type: "tool-result", id: callId, name: "send_to_user", content: [{ type: "text", text }], error }] });

describe("a chat's public copy", () => {
	it("keeps what the person read, with each message's widgets and no links, and nothing private", () => {
		const widgets = JSON.stringify({ sent: "Sent.", widgets: [{ id: "pim.goals/active", title: "Goals", empty: "None", kind: "progress", items: [{ title: "Lisbon", value: 0, max: 1, link: { kind: "chat", id: "secret-chat" } }] }] });
		const copy = sharedMessages([
			user("1", { type: "text", text: "Plan a trip to Lisbon" }, { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }),
			user("2", { type: "text", text: "[Delivery required] Use send_to_user to deliver your answer now. Your ordinary text is private and is not shown to the person. If sending failed, fix the call or explain the problem with a chat message." }),
			{ id: "3", role: "assistant", timestamp: 2, parts: [{ type: "tool-call", id: "c0", name: "create_goal", arguments: { title: "Visit Lisbon" } }] },
			result("4", "c0", "ok"),
			sends("5", "c1", { message: "Never sent." }),
			result("6", "c1", "Not sent: nope", true),
			sends("7", "c2", { message: "Lisbon it is.", widgets: ["pim.goals/active"] }),
			result("8", "c2", widgets),
			sends("9", "c3", { message: "An email.", channel: "email" }),
			result("10", "c3", "Sent."),
		]);
		expect(copy).toEqual([
			{ role: "user", text: "Plan a trip to Lisbon", images: 1, at: 1 },
			{ role: "agent", text: "Lisbon it is.", widgets: [{ id: "pim.goals/active", title: "Goals", empty: "None", kind: "progress", items: [{ title: "Lisbon", value: 0, max: 1 }] }], at: 2 },
		]);
		const raw = JSON.stringify(copy);
		for (const hidden of ["They want Lisbon", "Private working note", "create_goal", "Never sent", "iVBORw0KGgo", "secret-chat"]) expect(raw).not.toContain(hidden);
	});

	it("leaves out the app's note of a model that was asked again or replaced", () => {
		const told = { id: "n", role: "notice", parts: [], timestamp: 2, notices: [{ kind: "retry", model: "a" }] } as TranscriptMessage;
		const answer = { ...sends("3", "c", { message: "Hi." }), notices: [{ kind: "fallback", from: "a", to: "b", cause: "stalled" }] } as TranscriptMessage;
		expect(sharedMessages([user("1", { type: "text", text: "hello" }), told, answer, result("4", "c", "Sent.")])).toEqual([
			{ role: "user", text: "hello", images: 0, at: 1 },
			{ role: "agent", text: "Hi.", widgets: [], at: 2 },
		]);
	});

	it("starts after the newest context reset, and turns a ui block into its readable text", () => {
		const reset: TranscriptMessage = { id: "r", role: "notice", parts: [{ type: "text", text: "Context reset" }], timestamp: 0 };
		const copy = sharedMessages([user("1", { type: "text", text: "before" }), reset, user("2", { type: "text", text: "after" }), sends("3", "c", { message: "Hi.\n```ui\nText \"Hello there\"\n```\n" }), result("4", "c", "Sent.")]);
		expect(copy.map((m) => m.role)).toEqual(["user", "agent"]);
		expect(copy[0]).toMatchObject({ text: "after" });
		expect((copy[1] as { text: string }).text).not.toContain("```ui");
	});
});
