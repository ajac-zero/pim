import { describe, expect, it } from "vitest";
import type { JsonValue } from "@earendil-works/pi-ai";
import { MESSAGE_CHARS, OUTPUT_LINE_CHARS, pageTranscript, SUMMARY_CHARS, transcriptOutput, transcriptText, TRANSCRIPT_PAGE } from "../src/coding/transcript";
import type { TranscriptMessage } from "../src/transcript";

// What an agent reads of a coding thread's transcript (src/coding/transcript.ts): the page
// coding_transcript cuts out of it and the whole of one message coding_transcript_output reads
// back. Like the coding tools' tests, these run in the Worker pool but touch no binding.

let ids = 0;

const message = (role: TranscriptMessage["role"], parts: TranscriptMessage["parts"], id?: string): TranscriptMessage => ({ id: id ?? `m${++ids}`, role, parts, timestamp: 0 });

const said = (role: "user" | "assistant" | "notice", text: string, id?: string) => message(role, [{ type: "text", text }], id);

const toolCall = (name: string, args: JsonValue, callId: string, id?: string) => message("assistant", [{ type: "tool-call", id: callId, name, arguments: args }], id);

const toolResult = (name: string, text: string, callId: string, id?: string) =>
	message("tool", [{ type: "tool-result", id: callId, name, content: [{ type: "text", text }], error: false }], id);

/** A transcript with one of everything a thread says, with fixed ids. */
const thread = () => [
	said("user", "Add a greeting to the README.", "first"),
	said("assistant", "On it.", "on-it"),
	toolCall("bash", { command: "cat README.md" }, "call-1", "the-call"),
	toolResult("bash", "# Demo\n", "call-1", "the-result"),
	message("notice", [{ type: "text", text: "Context reset" }], "reset"),
];

describe("a page of a coding thread's transcript", () => {
	it("shows the oldest messages first, and says where the next page starts", () => {
		const messages = Array.from({ length: TRANSCRIPT_PAGE + 5 }, (_, index) => said("user", `Turn ${index}`, `t${index}`));
		const first = pageTranscript(messages);
		expect(first.total).toBe(25);
		expect(first.messages).toHaveLength(TRANSCRIPT_PAGE);
		expect(first.messages[0]).toMatchObject({ id: "t0", role: "user", text: "Turn 0" });
		expect(first.next_offset).toBe(TRANSCRIPT_PAGE);
		const rest = pageTranscript(messages, { offset: first.next_offset! });
		expect(rest.messages.map((each) => each.text)).toEqual(["Turn 20", "Turn 21", "Turn 22", "Turn 23", "Turn 24"]);
		expect(rest.next_offset).toBeUndefined();
		// An empty page past the end, rather than an error.
		expect(pageTranscript(messages, { offset: 25 })).toEqual({ messages: [], total: 25 });
		// A smaller page starts further in.
		expect(pageTranscript(messages, { offset: 24, limit: 1 }).messages).toHaveLength(1);
	});

	it("keeps only the messages of the role asked, and counts just those", () => {
		const whole = pageTranscript(thread());
		expect(whole.total).toBe(5);
		expect(whole.messages.map((each) => [each.id, each.role])).toEqual([
			["first", "user"],
			["on-it", "assistant"],
			["the-call", "assistant"],
			["the-result", "tool"],
			["reset", "notice"],
		]);
		expect(pageTranscript(thread(), { role: "user" })).toEqual({ messages: [{ id: "first", role: "user", text: "Add a greeting to the README." }], total: 1 });
		expect(pageTranscript(thread(), { role: "tool" })).toEqual({ messages: [{ id: "the-result", role: "tool", text: "# Demo" }], total: 1 });
		expect(pageTranscript(thread(), { role: "notice" })).toEqual({ messages: [{ id: "reset", role: "notice", text: "Context reset" }], total: 1 });
	});

	it("cuts a long message, and says the rest is readable by its id", () => {
		const messages = [said("assistant", "y".repeat(MESSAGE_CHARS + 600), "long"), said("user", "Short.", "short")];
		const [cut, whole] = pageTranscript(messages).messages;
		expect(cut!.text).toBe(`y`.repeat(MESSAGE_CHARS) + `… [600 more characters, coding_transcript_output reads the whole message]`);
		expect(whole!.text).toBe("Short.");
	});

	it("summarizes: the first line of each message, cut short", () => {
		const messages = [said("assistant", `${"x".repeat(SUMMARY_CHARS + 20)}\nit went on`, "first"), said("user", "Thanks.", "second")];
		const summary = pageTranscript(messages, { summary: true });
		expect(summary.messages).toEqual([
			{ id: "first", role: "assistant", text: "x".repeat(SUMMARY_CHARS) + `… [${20} more characters, coding_transcript_output reads the whole message]` },
			{ id: "second", role: "user", text: "Thanks." },
		]);
	});
});

describe("one message of a coding thread's transcript whole", () => {
	it("reads a message's whole text, whatever its parts", () => {
		expect(transcriptText(thread()[0]!)).toBe("Add a greeting to the README.");
		expect(transcriptText(toolCall("bash", { command: "pnpm test" }, "call-2"))).toBe('bash({"command":"pnpm test"})');
		expect(transcriptText(said("assistant", "Done.\nBye.", "last"))).toBe("Done.\nBye.");
		expect(transcriptOutput([said("assistant", "Done.\nBye.", "last")], "last")).toBe("Done.\nBye.");
		expect(transcriptOutput(thread(), "first")).toBe("Add a greeting to the README.");
		expect(transcriptOutput(thread(), "no-such-message")).toBeNull();
		// A message with nothing in it, rather than an empty answer.
		expect(transcriptOutput([message("assistant", [], "empty")], "empty")).toBe("(nothing in that message)");
	});

	it("pages a long message by lines, and says how to read on", () => {
		const long = Array.from({ length: 5 }, (_, index) => `line ${index + 1}`).join("\n");
		const messages = [said("assistant", long, "long")];
		expect(transcriptOutput(messages, "long", { offset: 2, limit: 2 })).toBe("line 2\nline 3\n\n[Lines 2-3 of 5. Use offset=4 to read on.]");
		expect(transcriptOutput(messages, "long")).toBe(long);
		expect(transcriptOutput(messages, "long", { offset: 6 })).toBe("line 5");
	});

	it("cuts a line that is too long, like read does", () => {
		const messages = [said("assistant", "z".repeat(OUTPUT_LINE_CHARS + 100), "wide")];
		expect(transcriptOutput(messages, "wide")).toBe("z".repeat(OUTPUT_LINE_CHARS) + `… [line cut at ${OUTPUT_LINE_CHARS} characters]`);
	});
});

describe("what a coding thread's transcript never says", () => {
	it("is a credential: both the page and the whole message redact it", () => {
		const messages = [said("user", "Use sk-abcdefghijklmnopqrstuvwx for the API.", "key"), said("assistant", 'MY_TOKEN = "hunter2secret"\nDone.', "set")];
		const page = pageTranscript(messages);
		expect(page.messages[0]!.text).toBe("Use [REDACTED] for the API.");
		expect(page.messages[1]!.text).toBe("MY_TOKEN = [REDACTED]\nDone.");
		expect(transcriptOutput(messages, "key")).toBe("Use [REDACTED] for the API.");
		expect(transcriptOutput(messages, "set")).toBe("MY_TOKEN = [REDACTED]\nDone.");
	});
});
