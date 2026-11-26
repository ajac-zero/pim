import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "../src/encoding";
import { apiKeyProblem, HARNESS_API_KEYS } from "../src/harnesses";
import { dispatch, HttpError, match, type Route, routeOf } from "../src/http";
import { maskCode } from "../src/markdown-code";
import { redact, redactSecrets } from "../src/redact";
import { pimThemes } from "../src/theme-data/index";
import { fromPerson, projectEntries } from "../src/transcript";

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
