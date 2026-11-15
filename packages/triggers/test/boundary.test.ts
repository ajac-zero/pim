import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("the package's boundary", () => {
	it("imports nothing of the Worker, the web app or another package than @pim/shared, and no Cloudflare module", () => {
		const src = resolve(import.meta.dirname, "../src");
		const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(10);
		for (const file of files) {
			const specifiers = [...readFileSync(join(src, file), "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
			for (const specifier of specifiers) {
				expect(specifier, file).not.toMatch(/^cloudflare:|^@pim\/(?!shared\/)/);
				if (specifier.startsWith(".")) expect(resolve(src, dirname(file), specifier).startsWith(`${src}/`), `${file}: ${specifier}`).toBe(true);
			}
		}
	});
});
