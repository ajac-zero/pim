import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../src/encoding";
import { apiKeyProblem, HARNESS_API_KEYS } from "../src/harnesses";
import { dispatch, HttpError, match, type Route, routeOf } from "../src/http";
import { maskCode } from "../src/markdown-code";
import { redact, redactSecrets } from "../src/redact";
import { pimThemes } from "../src/theme-data/index";
import { fromPerson, projectEntries, sendProvenance, withProvenance, DELIVERY_REMINDER } from "../src/transcript";

describe("base64url", () => {
	it("round-trips bytes that base64 would pad and escape", () => {
		const bytes = new Uint8Array([251, 255, 190, 1, 2]);
		const text = base64UrlEncode(bytes);
		expect(text).toBe("-_--AQI");
		expect([...base64UrlDecode(text)]).toEqual([...bytes]);
	});
});

describe("routes", () => {
	const routes: Route[] = [
		["GET", "/things/:id", (params) => ({ id: params.id })],
		["POST", "/things/:id", () => {
			throw new HttpError(409, "taken", { error: "taken", code: "x" });
		}],
	];

	it("answers with the handler's value, its error, 405 for another method and 404 for another path", async () => {
		const get = await dispatch(routes, new Request("https://pim.test/things/a%20b"), "/things/a%20b");
		expect(await get.json()).toEqual({ id: "a b" });
		const post = await dispatch(routes, new Request("https://pim.test/things/1", { method: "POST" }), "/things/1");
		expect([post.status, await post.json()]).toEqual([409, { error: "taken", code: "x" }]);
		expect((await dispatch(routes, new Request("https://pim.test/things/1", { method: "PUT" }), "/things/1")).status).toBe(405);
		expect((await dispatch(routes, new Request("https://pim.test/other"), "/other")).status).toBe(404);
	});

	it("names the pattern of a path, and only for whole matches", () => {
		expect(routeOf(routes, "/things/7")).toBe("/things/:id");
		expect(routeOf(routes, "/things/7/more")).toBeUndefined();
		expect(match("/a/:b", ["a", "x"])).toEqual({ b: "x" });
		expect(match("/a/:b", ["z", "x"])).toBeNull();
	});
});

describe("redaction", () => {
	it("hides credentials and keeps the words around them", () => {
		const token = `ghp_${"a1".repeat(18)}`;
		expect(redact(`pushed with ${token} today`)).toBe("pushed with [REDACTED] today");
		expect(redact("API_KEY=abcdef123456 ok")).toBe("API_KEY=[REDACTED] ok");
		expect(redactSecrets("failed: Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
		expect(redactSecrets("Rate limited, retry in 5 s")).toBe("Rate limited, retry in 5 s");
	});
});

describe("harness API keys", () => {
	it("checks a key's prefix and length", () => {
		const prefix = HARNESS_API_KEYS.amp.prefix;
		expect(apiKeyProblem("amp", `${prefix}${"x".repeat(20)}`)).toBeNull();
		expect(apiKeyProblem("amp", "short")).not.toBeNull();
	});
});

describe("transcript", () => {
	it("tells a person's message from Pim's own notices", () => {
		expect(fromPerson("hello")).toBe(true);
		expect(fromPerson("[Introduction]")).toBe(false);
	});

	it("does not show an answer that stopped with nothing in it, but shows an error or an aborted answer that has none", () => {
		const answer = (id: number, stopReason: string, content: unknown[]) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, stopReason, timestamp: id }] }) as never;
		const shown = projectEntries([
			answer(1, "stop", [{ type: "text", text: "\n" }, { type: "thinking", thinking: "" }]),
			answer(2, "stop", []),
			answer(3, "stop", [{ type: "text", text: "Hi" }]),
			answer(4, "error", []),
			answer(5, "aborted", []),
		]);
		expect(shown.map((m) => m.id)).toEqual(["3", "4", "5"]);
	});
});

describe("the notices of a model that was asked again or replaced", () => {
	const retry = { kind: "retry", model: "gemini-4-neon" };
	const fallback = { kind: "fallback", from: "gemini-4-neon", to: "gpt-6.1-sol", cause: "stalled" };
	const answer = (id: number, content: unknown[], modelNotices?: unknown, stopReason = "stop") => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, stopReason, timestamp: id, ...(modelNotices === undefined ? {} : { modelNotices }) }] }) as never;

	it("go with the assistant message of the request they happened in, and the stored shape is checked", () => {
		const [shown, plain, odd] = projectEntries([answer(1, [{ type: "text", text: "Hi" }], [retry, fallback]), answer(2, [{ type: "text", text: "Hi" }]), answer(3, [{ type: "text", text: "Hi" }], [{ kind: "x" }, { kind: "retry" }, { kind: "fallback", from: "a", to: "b" }])]);
		expect(shown).toMatchObject({ role: "assistant", notices: [retry, fallback] });
		expect(plain && "notices" in plain).toBe(false);
		// What does not have the shape is left out; a fallback of no stated cause is a failure.
		expect(odd?.notices).toEqual([{ kind: "fallback", from: "a", to: "b", cause: "failed" }]);
	});

	it("are still told by a request that answered with nothing, as a notice of their own, and an empty answer without them stays hidden", () => {
		const shown = projectEntries([answer(1, [{ type: "text", text: "\n" }], [retry]), answer(2, [{ type: "text", text: "\n" }])]);
		expect(shown).toEqual([{ id: "1", role: "notice", parts: [], timestamp: 1, notices: [retry] }]);
	});

	it("open no new work for a send's provenance, which counts the same models with them as without", () => {
		const send = { type: "toolCall", id: "a", name: "send_to_user", arguments: { message: "Hi" } };
		const search = { type: "toolCall", id: "s", name: "web_search", arguments: {} };
		const neon = { provider: "ai-gateway", model: "gemini-4-neon" };
		const sol = { provider: "openai", model: "gpt-6.1-sol" };
		const entries = (notices?: unknown) => [
			{ id: 1, kind: "pi.message", model: [{ role: "user", content: "Go", timestamp: 1 }] },
			{ id: 2, kind: "pi.assistant", model: [{ role: "assistant", content: [search], stopReason: "toolUse", timestamp: 2, ...neon, ...(notices ? { modelNotices: notices } : {}) }] },
			{ id: 3, kind: "pi.message", model: [{ role: "toolResult", toolCallId: "s", toolName: "web_search", content: [], isError: false, timestamp: 3 }] },
			{ id: 4, kind: "pi.assistant", model: [{ role: "assistant", content: [send], stopReason: "stop", timestamp: 4, ...sol, ...(notices ? { modelNotices: notices } : {}) }] },
		] as never[];
		const told = sendProvenance(entries([retry, fallback]), "start");
		expect(told).toEqual(sendProvenance(entries(), "start"));
		expect(told?.a?.contributors.map((m) => m.model)).toEqual(["gemini-4-neon", "gpt-6.1-sol"]);
	});
});

describe("a message's model", () => {
	const answer = (id: number, fields: Record<string, unknown>) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text: "Hi" }], stopReason: "stop", timestamp: id, ...fields }] }) as never;

	it("is the provider and model the request recorded, with the model the response named only when it differs, and none when the message recorded none", () => {
		const [gateway, same, blank, user] = projectEntries([
			answer(1, { provider: "ai-gateway", model: "gemini-4-neon", responseModel: "gemini-4-neon-0925" }),
			answer(2, { provider: "openai", model: "gpt-6-sol", responseModel: "gpt-6-sol" }),
			answer(3, { provider: "", model: "" }),
			{ id: 4, kind: "pi.message", model: [{ role: "user", content: "x", timestamp: 4 }] } as never,
		]);
		expect(gateway?.model).toEqual({ provider: "ai-gateway", model: "gemini-4-neon", served: "gemini-4-neon-0925" });
		expect(same?.model).toEqual({ provider: "openai", model: "gpt-6-sol" });
		expect(blank && "model" in blank).toBe(false);
		expect(user && "model" in user).toBe(false);
	});
});

describe("who is behind a message that was sent", () => {
	const neon = { provider: "ai-gateway", model: "gemini-4-neon" };
	const sol = { provider: "openai", model: "gpt-6-sol" };
	let next = 0;
	const entry = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: ++next, kind: "pi.message", model: [message], ...extra }) as never;
	const user = (text: string) => entry({ role: "user", content: text, timestamp: 0 });
	const answer = (model: Record<string, string> | null, content: unknown[], stopReason = "stop") => entry({ role: "assistant", content, stopReason, timestamp: 0, ...(model ?? {}) });
	const result = (id: string, isError = false) => entry({ role: "toolResult", toolCallId: id, toolName: "x", content: [], isError, timestamp: 0 });
	const send = (id: string, message = "Hi") => ({ type: "toolCall", id, name: "send_to_user", arguments: { message } });
	const search = { type: "toolCall", id: "s", name: "web_search", arguments: {} };
	const names = (list: readonly { model: string }[] | undefined) => list?.map((m) => m.model);
	const run = (entries: unknown[], edge: "more" | "start" | "cut" = "start") => sendProvenance(entries as never, edge);

	it("names the emitter and the models that succeeded toward the send, never one that only failed, in the order they answered", () => {
		const found = run([user("Weather?"), answer(neon, [], "error"), answer(sol, [search], "toolUse"), result("s"), answer(neon, [send("m")])]);
		expect(found?.m?.emitter).toEqual(neon);
		expect(names(found?.m?.contributors)).toEqual(["gpt-6-sol", "gemini-4-neon"]);
		expect(found?.m?.complete).toBe(true);
	});

	it("counts a request once: its sends share one answer, trailing text leads nowhere, and another tool call it made carries it into the next message", () => {
		const note = { type: "text", text: "Done." };
		const only = [user("Go"), answer(neon, [send("a"), send("b"), note]), result("a"), result("b"), answer(sol, [send("c")])];
		expect(names(run(only.slice(0, 2))?.a?.contributors)).toEqual(["gemini-4-neon"]);
		const sent = run(only.slice(0, 2));
		expect(sent?.a).toBe(sent?.b);
		expect(names(run(only)?.c?.contributors)).toEqual(["gpt-6-sol"]);
		const also = [user("Go"), answer(neon, [send("a"), search], "toolUse"), result("a"), result("s"), answer(sol, [send("c")])];
		expect(names(run(also)?.c?.contributors)).toEqual(["gemini-4-neon", "gpt-6-sol"]);
	});

	it("starts after a person's message, a context reset, a post or the message sent before, but not after a compaction, the harness's reminders or a send that was refused", () => {
		const reset = { id: ++next, kind: "pi.reset", head: "self" } as never;
		const compaction = { id: ++next, kind: "pi.compaction", model: [{ role: "user", content: "summary", timestamp: 0 }] } as never;
		const after = (middle: unknown) => names(run([user("Go"), answer(sol, [search], "toolUse"), result("s"), middle, answer(neon, [send("a")])])?.a?.contributors);
		expect(after(user("Next"))).toEqual(["gemini-4-neon"]);
		expect(after(user("[From Ada]\nhi"))).toEqual(["gemini-4-neon"]);
		expect(after(reset)).toEqual(["gemini-4-neon"]);
		expect(after(compaction)).toEqual(["gpt-6-sol", "gemini-4-neon"]);
		expect(after(user(DELIVERY_REMINDER))).toEqual(["gpt-6-sol", "gemini-4-neon"]);
		expect(names(run([user("Go"), answer(sol, [send("r")], "toolUse"), result("r", true), answer(neon, [send("a")])])?.a?.contributors)).toEqual(["gpt-6-sol", "gemini-4-neon"]);
		expect(names(run([user("Go"), answer(sol, [send("r")], "toolUse"), result("r"), answer(neon, [send("a")])])?.a?.contributors)).toEqual(["gemini-4-neon"]);
	});

	it("does not see entries a retry left out", () => {
		const first = answer(sol, [send("old")], "toolUse");
		const retry = { id: ++next, kind: "pim.retry", edits: [{ target: (first as { id: number }).id, action: "omit" }] } as never;
		expect(names(run([user("Go"), first, retry, answer(neon, [send("a")])])?.a?.contributors)).toEqual(["gemini-4-neon"]);
	});

	it("is never complete when a successful request recorded no model, or the work reaches past what was read, and asks for older entries when it is not settled", () => {
		expect(run([user("Go"), answer(null, [search], "toolUse"), result("s"), answer(neon, [send("a")])])?.a).toMatchObject({ complete: false, contributors: [neon] });
		const open = [answer(sol, [search], "toolUse"), result("s"), answer(neon, [send("a")])];
		expect(run(open, "more")).toBeUndefined();
		expect(run(open, "start")?.a?.complete).toBe(true);
		expect(run(open, "cut")?.a?.complete).toBe(false);
		expect(run([user("Go"), answer(neon, [search], "toolUse")], "start")).toEqual({});
	});

	it("names the emitter while the answer is still being written, and counts it as a contributor only once it ended well", () => {
		const earlier = [user("Go"), answer(sol, [search], "toolUse"), result("s")];
		for (const stopReason of ["pending", "error", "aborted"]) {
			const found = run([...earlier, answer(neon, [send("a")], stopReason)])?.a;
			expect(found?.emitter).toEqual(neon);
			expect(names(found?.contributors)).toEqual(["gpt-6-sol"]);
		}
		for (const stopReason of ["toolUse", "stop"]) expect(names(run([...earlier, answer(neon, [send("a")], stopReason)])?.a?.contributors)).toEqual(["gpt-6-sol", "gemini-4-neon"]);
	});

	it("is put on a projected message by call id, and a post carries its own", () => {
		const [message] = projectEntries([answer(neon, [send("a"), send("b")])]);
		const found = run([user("Go"), answer(neon, [send("a")])])!;
		const withIt = withProvenance(message!, found);
		expect(withIt.parts.map((part) => ("provenance" in part ? part.provenance : undefined))).toEqual([found.a, undefined]);
		const [post] = projectEntries([user("[From Ada]\nhi")]);
		expect(withProvenance(post!, undefined, found.a).provenance).toBe(found.a);
	});
});

describe("Pim's own themes", () => {
	it("each have both modes with the colors the app reads", () => {
		expect(new Set(pimThemes.map((theme) => theme.id)).size).toBe(pimThemes.length);
		for (const theme of pimThemes) {
			for (const mode of ["light", "dark"] as const) {
				expect(theme[mode].background, `${theme.id} ${mode}`).toMatch(/^(#|oklch)/);
				expect(theme[mode].foreground, `${theme.id} ${mode}`).toMatch(/^(#|oklch)/);
			}
		}
	});
});

describe("the package's boundary", () => {
	it("imports nothing of the Worker, the web app or another package, and no Cloudflare runtime", () => {
		const src = new URL("../src/", import.meta.url);
		const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(10);
		for (const file of files) {
			const url = new URL(file, src);
			const specifiers = [...readFileSync(url, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
			for (const specifier of specifiers) {
				expect(specifier, file).not.toMatch(/^cloudflare:|^@pim\//);
				if (specifier.startsWith(".")) expect(new URL(specifier, url).href, file).toMatch(/\/packages\/shared\/src\//);
			}
		}
	});
});

describe("maskCode", () => {
	it("blanks fenced code and inline code, keeping every index and line break", () => {
		const text = "a `b` c\n```js\n<x>\n```\n~~~\n<y>\n~~~\nd ``e ` f`` g";
		const masked = maskCode(text);
		expect(masked).toHaveLength(text.length);
		expect(masked.split("\n").map((line) => line.trim())).toEqual(["a     c", "", "", "", "", "", "", `d${" ".repeat(11)}g`]);
	});

	it("keeps an unclosed backtick, and a fence's longer closing line", () => {
		expect(maskCode("it` is")).toBe("it` is");
		expect(maskCode("````\n```\n````\nx")).toBe("    \n   \n    \nx");
	});
});
