import { describe, expect, it } from "vitest";
import { chooseSetup, ENV_CONFIG_PATH, MAX_ENV_CONFIG_BYTES, parseEnvConfig } from "../src/coding/env-config";
import { globRegExp } from "../src/coding/environment-cache";

// The repository's declarative contract, `.pim/env.json`: read strictly, never throwing.

const parse = (value: unknown) => parseEnvConfig(JSON.stringify(value));
const errorOf = (value: unknown) => {
	const result = parse(value);
	if (result.ok) throw new Error("expected the file to be ignored");
	return result.error;
};
const service = (name: string, port: number) => ({ name, command: "run", port });

describe(".pim/env.json", () => {
	it("reads every field", () => {
		const result = parse({
			setup: ["pnpm install", "pnpm build"],
			cacheKeys: ["db/schema.sql", "tools/**/*.lock"],
			cachePaths: ["node_modules"],
			services: [{ name: "web", command: "pnpm dev", port: 5173, ready: "curl -sf localhost:5173", preview: true }, { name: "db_1", command: "pg", port: 5432 }],
			check: ["pnpm test", " pnpm lint "],
		});
		expect(result).toEqual({
			ok: true,
			notes: [],
			config: {
				setup: "set -e\npnpm install\npnpm build\n",
				cacheKeys: ["db/schema.sql", "tools/**/*.lock"],
				cachePaths: ["node_modules"],
				services: [{ name: "web", command: "pnpm dev", port: 5173, ready: "curl -sf localhost:5173", preview: true }, { name: "db_1", command: "pg", port: 5432 }],
				check: ["pnpm test", "pnpm lint"],
			},
		});
		expect(parse({ setup: "make setup\n" })).toMatchObject({ ok: true, config: { setup: "make setup\n", services: [], check: [] } });
		expect(parse({})).toMatchObject({ ok: true, config: { cacheKeys: [], cachePaths: [] } });
	});

	it("ignores unknown fields with a note, and a file that isn't an object or JSON with the reason", () => {
		expect(parse({ check: ["a"], extra: 1 })).toMatchObject({ ok: true, notes: [`${ENV_CONFIG_PATH}: the unknown field "extra" is ignored`] });
		expect(parseEnvConfig("{nope")).toEqual({ ok: false, error: ".pim/env.json is ignored: it is not valid JSON" });
		expect(parseEnvConfig("[]")).toEqual({ ok: false, error: ".pim/env.json is ignored: it must be a JSON object" });
		expect(parseEnvConfig("null")).toMatchObject({ ok: false });
	});

	it("rejects each invalid field, naming it", () => {
		for (const setup of [5, "", "  ", [], ["ok", 1], [""]]) expect(errorOf({ setup })).toContain("setup must be");
		for (const field of ["cacheKeys", "cachePaths"]) {
			expect(errorOf({ [field]: "a" })).toContain(`${field} must be a list of strings`);
			for (const path of ["/etc/passwd", "~/x", "../x", "a/../b", "a\\b", "", "x".repeat(201)]) expect(errorOf({ [field]: [path] }), path).toContain(`${field} must hold relative paths`);
		}
		expect(parse({ cacheKeys: ["a..b", "..hidden", "./x"] })).toMatchObject({ ok: true });
		expect(errorOf({ check: "make" })).toContain("check must be a list");
		expect(errorOf({ check: ["a", " "] })).toContain("check must be a list");
		expect(errorOf({ services: {} })).toContain("services must be a list");
		const bad = [
			[{ ...service("a", 1), extra: 1 }, "is not a service field"],
			[service("1a", 1), "name must be"],
			[service("a b", 1), "name must be"],
			[service("a".repeat(41), 1), "name must be"],
			[{ name: "a", port: 1 }, "command must be"],
			[{ name: "a", command: " ", port: 1 }, "command must be"],
			[service("a", 0), "port must be"],
			[service("a", 65536), "port must be"],
			[service("a", 1.5), "port must be"],
			[{ ...service("a", 1), port: "80" }, "port must be"],
			[{ ...service("a", 1), ready: "" }, "ready must be"],
			[{ ...service("a", 1), preview: "yes" }, "preview must be"],
			["web", "must be an object"],
		] as const;
		for (const [each, why] of bad) expect(errorOf({ services: [each] }), JSON.stringify(each)).toContain(why);
		expect(errorOf({ services: [service("Web", 1), service("web", 2)] })).toContain("name repeats");
		expect(errorOf({ services: [service("a", 7), service("b", 7)] })).toContain("port repeats");
	});

	it("says up to five reasons", () => {
		const error = errorOf({ setup: 1, check: 1, cacheKeys: 1, cachePaths: 1, services: 1, more: 1 });
		expect(error.startsWith(".pim/env.json is ignored: ")).toBe(true);
		expect(error.split("; ")).toHaveLength(5);
		const many = errorOf({ services: Array.from({ length: 7 }, () => "x") });
		expect(many).toContain("; and 2 more");
		expect(many.match(/must be an object/g)).toHaveLength(5);
	});

	it("holds its limits at their edges", () => {
		const base = JSON.stringify({ check: ["x"], pad: "" });
		const fits = JSON.stringify({ check: ["x"], pad: "a".repeat(MAX_ENV_CONFIG_BYTES - base.length) });
		expect(fits.length).toBe(MAX_ENV_CONFIG_BYTES);
		expect(parseEnvConfig(fits)).toMatchObject({ ok: true });
		expect(parseEnvConfig(`${fits} `)).toEqual({ ok: false, error: ".pim/env.json is ignored: it is larger than 32 KiB" });
		const count = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
		expect(parse({ services: count(20).map((name, i) => service(name, i + 1)) })).toMatchObject({ ok: true });
		expect(errorOf({ services: count(21).map((name, i) => service(name, i + 1)) })).toContain("more than 20");
		expect(parse({ check: count(50) })).toMatchObject({ ok: true });
		expect(errorOf({ check: count(51) })).toContain("more than 50 commands");
		expect(parse({ check: ["x".repeat(200)] })).toMatchObject({ ok: true });
		expect(errorOf({ check: ["x".repeat(201)] })).toContain("longer than 200");
		expect(parse({ cacheKeys: count(50) })).toMatchObject({ ok: true });
		expect(errorOf({ cacheKeys: count(51) })).toContain("more than 50 entries");
	});
});

describe("cache key globs", () => {
	it("match * within a name and ** across directories", () => {
		const match = (pattern: string, path: string) => globRegExp(pattern).test(path);
		expect(match("db/*.sql", "db/schema.sql")).toBe(true);
		expect(match("db/*.sql", "db/a/schema.sql")).toBe(false);
		expect(match("db/*.sql", "db/schemaxsql")).toBe(false);
		expect(match("tools/**/*.lock", "tools/a/b/x.lock")).toBe(true);
		expect(match("tools/**/*.lock", "tools/x.lock")).toBe(true);
		expect(match("tools/**/*.lock", "other/x.lock")).toBe(false);
		expect(match("**/*.lock", "x.lock")).toBe(true);
		expect(match("src/**", "src/a/b.ts")).toBe(true);
		expect(match("a.b+c", "a.b+c")).toBe(true);
		expect(match("a.b", "axb")).toBe(false);
	});
});

describe("the setup a thread runs", () => {
	const config = { setup: "from env", cacheKeys: [], cachePaths: [], services: [], check: [] };
	const configured = { script: "mise run setup", source: "mise" as const, content: "mise.toml" };
	const choose = (setting: string | null, env: typeof config | null, repository: string | null, mise: typeof configured | null) => chooseSetup({ setting, config: env, repository: async () => repository, configured: async () => mise });

	it("goes setting, then env.json, then .pim/setup.sh, then mise or the dev container", async () => {
		expect(await choose("s", config, "r", configured)).toEqual({ script: "s", source: "settings", content: "s" });
		expect(await choose(null, config, "r", configured)).toEqual({ script: "from env", source: "env", content: "from env" });
		expect(await choose(null, { ...config, setup: undefined } as never, "r", configured)).toEqual({ script: "r", source: "repository", content: "r" });
		expect(await choose(null, null, "r", configured)).toMatchObject({ source: "repository" });
		expect(await choose(null, null, null, configured)).toBe(configured);
		expect(await choose(null, null, null, null)).toBeNull();
	});
});
