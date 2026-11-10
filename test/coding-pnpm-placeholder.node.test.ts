// The step that installs pnpm through mise, run in bash against a fake `mise` whose pnpm package still has the placeholder executable, as mise's npm backend leaves it.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pnpmPostinstall, verifyTool } from "../src/coding/repo-environment";

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup(placeholder: boolean): string {
	root = mkdtempSync(join(tmpdir(), "pnpm-placeholder-"));
	const pkg = join(root, "install", "lib", "node_modules", "pnpm");
	mkdirSync(join(pkg, "bin"), { recursive: true });
	writeFileSync(join(pkg, "bin", "pnpm.cjs"), placeholder ? "// This is a placeholder. pnpm's native binary replaces this file during postinstall\n" : "native\n");
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pnpm", scripts: { postinstall: "node -e \"require('fs').writeFileSync('bin/pnpm.cjs','native')\"" } }));
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "mise"), `#!/bin/sh\ncase "$1" in where) echo "${join(root, "install")}";; reshim) echo reshim >> "${join(root, "log")}";; esac\n`);
	chmodSync(join(root, "bin", "mise"), 0o755);
	return pkg;
}

const run = () => execFileSync("bash", ["-c", pnpmPostinstall("12.0.0")], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });

describe("installing pnpm with mise", () => {
	it("runs pnpm's postinstall when its executable is still the placeholder, then reshims", () => {
		const pkg = setup(true);
		run();
		expect(readFileSync(join(pkg, "bin", "pnpm.cjs"), "utf8")).toBe("native");
		expect(readFileSync(join(root, "log"), "utf8")).toBe("reshim\n");
	});

	it("leaves an install that already has its binary alone", () => {
		const pkg = setup(false);
		run();
		expect(readFileSync(join(pkg, "bin", "pnpm.cjs"), "utf8")).toBe("native\n");
		expect(() => readFileSync(join(root, "log"))).toThrow();
	});
});

describe("checking that an installed tool runs", () => {
	const check = (tool: string, body: string) => {
		root = mkdtempSync(join(tmpdir(), "tool-check-"));
		mkdirSync(join(root, "bin"));
		if (body) {
			writeFileSync(join(root, "bin", tool), `#!/bin/sh\n${body}\n`);
			chmodSync(join(root, "bin", tool), 0o755);
		}
		const env = { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` };
		return spawnSync("bash", ["-c", verifyTool(tool)], { env, encoding: "utf8" });
	};

	it("passes a tool that prints its version", () => {
		expect(check("pnpm", "echo 12.0.0").status).toBe(0);
	});

	it("fails a tool that crashes, as pnpm's placeholder does, and says which one and how", () => {
		const result = check("pnpm", "echo 'SyntaxError: Invalid or unexpected token' >&2; exit 1");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("SyntaxError");
		expect(result.stderr).toContain("pnpm --version failed: the installed pnpm doesn't run");
	});

	it("fails a tool that isn't there at all, and asks Go for `go version`", () => {
		expect(check("nosuchtool", "").status).not.toBe(0);
		expect(check("go", "exit 1").stderr).toContain("go version failed");
	});
});
