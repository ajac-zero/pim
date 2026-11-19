import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("the package's boundary", () => {
	it("imports nothing of the Worker, the web app or another package, and no Cloudflare module", () => {
		const src = resolve(import.meta.dirname, "../src");
		const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(10);
		for (const file of files) {
			const specifiers = [...readFileSync(join(src, file), "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");
			for (const specifier of specifiers) {
				expect(specifier, file).not.toMatch(/^cloudflare:|^@pim\/(?!v2-contracts\/|triggers\/(spec|time|validate|condition|firing-text)$)/);
				if (specifier.startsWith(".")) expect(resolve(src, dirname(file), specifier).startsWith(`${src}/`), `${file}: ${specifier}`).toBe(true);
			}
		}
	});

	it("keeps every tenant table sealed by row-level security", () => {
		const sql = readdirSync(resolve(import.meta.dirname, "../migrations")).map((f) => readFileSync(resolve(import.meta.dirname, "../migrations", f), "utf8")).join("\n");
		const tables = [...sql.matchAll(/CREATE TABLE pim_app\.(\w+)/g)].map((m) => m[1]!);
		// Instance-level tables hold no tenant data and are the only ones allowed to go unsealed.
		const open = new Set(["instance_settings", "registration_attempts", "claim_codes", "schedule_wakeups", "auth_flows", "oauth_clients"]);
		for (const table of tables) if (!open.has(table)) expect(sql, table).toMatch(new RegExp(`(seal_tenant|seal_lookup)\\('pim_app\\.${table}'|ALTER TABLE pim_app\\.${table} ENABLE ROW LEVEL SECURITY`));
	});
});
