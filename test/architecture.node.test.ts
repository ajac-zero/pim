// Runs in Node, reading the source: where the code's imports may point. The Worker's entry router, the space's collaborators, the packages and the web app each have a direction their imports may go.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");

/** Every `.ts` and `.tsx` file under `dir`, as an absolute path, apart from dependencies and build output. */
function sourcesIn(dir: string): string[] {
	const found: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "dist") continue;
		const file = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...sourcesIn(file));
		else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) found.push(file);
	}
	return found;
}

/** What one import or re-export names: its specifier, and whether it is only for types, so that nothing is loaded for it. */
type Import = { readonly specifier: string; readonly typeOnly: boolean };

/** What a file imports or re-exports. */
function importsOf(file: string): Import[] {
	const source = fs.readFileSync(file, "utf8");
	const found: Import[] = [];
	for (const [, statement, specifier] of source.matchAll(/^\s*((?:import|export)\b[^;]*?)\bfrom\s*["']([^"']+)["']/gms)) {
		const text = statement!.trim();
		const braces = /\{([^}]*)\}/.exec(text)?.[1];
		const names = braces?.split(",").map((name) => name.trim()).filter(Boolean) ?? [];
		const onlyNamed = /^(?:import|export)\s*\{/.test(text);
		found.push({ specifier: specifier!, typeOnly: /^(?:import|export)\s+type\b/.test(text) || (onlyNamed && names.length > 0 && names.every((name) => name.startsWith("type "))) });
	}
	for (const [, specifier] of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push({ specifier: specifier!, typeOnly: false });
	for (const [, specifier] of source.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push({ specifier: specifier!, typeOnly: false });
	return found;
}

/** The source file a relative specifier names, or null for a package or anything that isn't one here. */
function resolve(from: string, specifier: string): string | null {
	if (!specifier.startsWith(".")) return null;
	const base = path.resolve(path.dirname(from), specifier);
	for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

const rel = (file: string) => path.relative(root, file);

describe("architecture", () => {
	it("serves the Worker's requests from src/gateway.ts, which only src/index.ts imports", () => {
		const gateway = path.join(root, "src/gateway.ts");
		const importers = sourcesIn(path.join(root, "src")).filter((file) => importsOf(file).some(({ specifier }) => resolve(file, specifier) === gateway));
		expect(importers.map(rel)).toEqual(["src/index.ts"]);
	});

	it("keeps the space's collaborators from loading Pim: they import its type at most, and nothing they load imports it back", () => {
		const pim = path.join(root, "src/pim.ts");
		const collaborators = sourcesIn(path.join(root, "src/space"));
		expect(collaborators.length).toBeGreaterThan(0);
		// The files a file loads when it runs: its value imports.
		const loads = (file: string) => importsOf(file).filter(({ typeOnly }) => !typeOnly).flatMap(({ specifier }) => resolve(file, specifier) ?? []);
		const reach = (start: string) => {
			const seen = new Set<string>();
			const queue = [start];
			for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
				if (seen.has(file)) continue;
				seen.add(file);
				queue.push(...loads(file));
			}
			return seen;
		};
		for (const file of collaborators) expect(reach(file).has(pim), `${rel(file)} loads src/pim.ts`).toBe(false);
	});

	it("keeps the space's collaborators from loading one another in a circle", () => {
		const loads = (file: string) => importsOf(file).filter(({ typeOnly }) => !typeOnly).flatMap(({ specifier }) => resolve(file, specifier) ?? []);
		const reaches = (from: string, target: string, seen = new Set<string>()): boolean => loads(from).some((next) => next === target || (!seen.has(next) && seen.add(next) && reaches(next, target, seen)));
		for (const file of sourcesIn(path.join(root, "src/space"))) expect(reaches(file, file), `${rel(file)} loads itself`).toBe(false);
	});

	it("gives the packages no import of src/ or web/", () => {
		const files = fs.readdirSync(path.join(root, "packages")).flatMap((name) => sourcesIn(path.join(root, "packages", name)));
		expect(files.length).toBeGreaterThan(0);
		const outside = files.flatMap((file) =>
			importsOf(file).flatMap(({ specifier }) => {
				const target = path.resolve(path.dirname(file), specifier);
				const reaches = specifier.startsWith(".") && [path.join(root, "src"), path.join(root, "web")].some((dir) => target === dir || target.startsWith(dir + path.sep));
				return reaches || /^(src|web)\//.test(specifier) ? [`${rel(file)} imports ${specifier}`] : [];
			}),
		);
		expect(outside).toEqual([]);
	});

	it("keeps the web app's imports inside web/", () => {
		const web = path.join(root, "web");
		const escaping = sourcesIn(path.join(web, "src")).flatMap((file) =>
			importsOf(file).flatMap(({ specifier }) => {
				if (!specifier.startsWith(".")) return [];
				const target = path.resolve(path.dirname(file), specifier);
				return target.startsWith(web + path.sep) ? [] : [`${rel(file)} imports ${specifier}`];
			}),
		);
		expect(escaping).toEqual([]);
	});
});
