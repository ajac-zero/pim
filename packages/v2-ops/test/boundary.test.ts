import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = new URL("../src/", import.meta.url).pathname;
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));

describe("the package boundary", () => {
	it("imports no Pim package but @pim/v2-contracts and nothing from the Worker, and only the fence Worker imports cloudflare: modules", () => {
		for (const file of files(SRC)) {
			const imports = [...readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
			for (const specifier of imports) {
				expect(specifier, `${file} imports ${specifier}`).not.toMatch(/^@pim\/(?!v2-contracts\/)|\/src\/|^\.\.\/\.\.\/\.\.\/(?!v2-contracts)/);
				if (specifier.startsWith("cloudflare:")) expect(file, `${file} imports ${specifier}`).toContain("/fence-worker/");
			}
		}
	});
});
