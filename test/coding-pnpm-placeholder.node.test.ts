// The step that installs pnpm through mise, run in bash against a fake `mise` whose pnpm package still has the placeholder executable, as mise's npm backend leaves it, and the check that an installed tool runs.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/coding/workspace/types";
import { pnpmPostinstall, runProvisionStep, verifyTool } from "../src/coding/repo-environment";

let root = "";
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fake mise whose `where` names an install laid out as mise's npm backend lays out pnpm 12: the package under node_modules/.mise, and a `.bin` shim that runs it with Node. */
function setup(placeholder: boolean): { pkg: string; bin: string } {
	root = mkdtempSync(join(tmpdir(), "pnpm-placeholder-"));
	const install = join(root, "install");
	const pkg = join(install, "node_modules", ".mise", "pnpm@12.0.0", "node_modules", "pnpm");
	const bin = join(install, "node_modules", ".bin");
	mkdirSync(pkg, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(pkg, "pnpm"), placeholder ? "This is a placeholder. pnpm's native binary replaces this file during\ninstallation (see ./install.js).\n" : "native\n");
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pnpm", version: "12.0.0" }));
	// pnpm's own preinstall: put the native binary where the placeholder is.
	writeFileSync(join(pkg, "install.js"), "require('fs').writeFileSync('pnpm', 'native\\n');\n");
	for (const name of ["pnpm", "pn", "pnpx", "pnx"]) {
		if (name !== "pnpm") writeFileSync(join(pkg, name), "#!/bin/sh\n");
		writeFileSync(join(bin, name), "#!/bin/sh\nexec node pnpm\n");
	}
	mkdirSync(join(root, "bin"));
	writeFileSync(join(root, "bin", "mise"), `#!/bin/sh\ncase "$1" in where) echo "${install}";; reshim) echo reshim >> "${join(root, "log")}";; esac\n`);
	chmodSync(join(root, "bin", "mise"), 0o755);
	return { pkg, bin };
}

const run = () => execFileSync("bash", ["-c", pnpmPostinstall("12.0.0")], { env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });

describe("installing pnpm with mise", () => {
	it("runs pnpm's own install script when its executable is still the placeholder, points the .bin entries at the package's executables, and reshims", () => {
		const { pkg, bin } = setup(true);
		run();
		expect(readFileSync(join(pkg, "pnpm"), "utf8")).toBe("native\n");
		expect(readlinkSync(join(bin, "pnpm"))).toBe(join(pkg, "pnpm"));
		expect(readlinkSync(join(bin, "pnpx"))).toBe(join(pkg, "pnpx"));
		expect(readFileSync(join(root, "log"), "utf8")).toBe("reshim\n");
	});

	it("leaves an install that already has its binary, or has no placeholder at all, alone", () => {
		const { pkg, bin } = setup(false);
		run();
		expect(readFileSync(join(pkg, "pnpm"), "utf8")).toBe("native\n");
		expect(readFileSync(join(bin, "pnpm"), "utf8")).toBe("#!/bin/sh\nexec node pnpm\n");
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

	it("fails the toolchain step, with the tool's own error, when its binary is the placeholder", async () => {
		root = mkdtempSync(join(tmpdir(), "tool-step-"));
		mkdirSync(join(root, "bin"));
		// What node does with pnpm's placeholder: it fails to parse it.
		writeFileSync(join(root, "bin", "pnpm"), "#!/bin/sh\necho \"SyntaxError: Unexpected identifier 'is' (This is a placeholder)\" >&2\nexit 1\n");
		chmodSync(join(root, "bin", "pnpm"), 0o755);
		const workspace = {
			async *exec(argv: string[], o: { env?: Record<string, string> }) {
				const child = spawn(argv[0]!, argv.slice(1), { env: { ...process.env, ...o.env, PATH: `${join(root, "bin")}:${process.env.PATH}` } });
				let out = "";
				child.stderr.on("data", (d) => (out += d));
				const code: number | null = await new Promise((resolve) => child.on("close", resolve));
				yield { type: "stdout", data: out };
				yield { type: "exit", code, timedOut: false };
			},
		} as unknown as Workspace;
		const step = { id: "toolchain:pnpm", kind: "toolchain", tool: "pnpm", script: `true && ${verifyTool("pnpm")}`, needs: [] } as const;
		const result = await runProvisionStep(workspace, step, { cwd: root, env: {} });
		expect(result).toMatchObject({ outcome: "failed", how: "exited 1", output: expect.stringContaining("pnpm --version failed: the installed pnpm doesn't run") });
		expect(result).toMatchObject({ output: expect.stringContaining("placeholder") });
	});
});
