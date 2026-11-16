// What `pnpm test:changed` decides to run, from the files a diff touches: the whole suite when a
// change can reach any test or nothing maps to one, otherwise only the projects it maps to.
import { describe, expect, it } from "vitest";
import { selectRuns } from "../scripts/test-changed.mjs";

describe("selecting which tests a change reaches", () => {
	it("runs the whole suite when dependency or build configuration changed, wherever it is", () => {
		for (const file of [
			"package.json",
			"web/package.json",
			"pnpm-lock.yaml",
			"vitest.config.ts",
			"web/vitest.config.ts",
			"wrangler.jsonc",
			"wrangler.preview.jsonc",
			"tsconfig.json",
			"web/tsconfig.app.json",
		]) {
			expect(selectRuns(["src/pim.ts", file])).toEqual({ full: true, reason: `${file} changed` });
		}
	});

	it("maps anything outside web/ to the root project, vitest's --changed to pick which of its tests", () => {
		expect(selectRuns(["src/pim.ts"])).toEqual({ full: false, root: true, web: false, daemons: false, packages: [] });
		expect(selectRuns(["test/auth.test.ts", "preview/worker.ts", "scripts/install-test-browser.mjs"])).toEqual({ full: false, root: true, web: false, daemons: false, packages: [] });
	});

	it("maps web/ to the web app's tests", () => {
		expect(selectRuns(["web/src/main.tsx"])).toEqual({ full: false, root: false, web: true, daemons: false, packages: [] });
		expect(selectRuns(["web/src/main.tsx", "src/pim.ts"])).toEqual({ full: false, root: true, web: true, daemons: false, packages: [] });
	});

	it("maps the packages web/ imports to the web app's tests too, and other src/ files not", () => {
		for (const file of ["packages/ui-lang/src/parse.ts", "packages/shared/src/transcript.ts", "packages/shared/src/themes.ts", "packages/shared/src/locales.ts"]) {
			expect(selectRuns([file])).toMatchObject({ full: false, root: true, web: true, daemons: false });
		}
		for (const file of ["src/pim.ts", "src/coding/vault/worker.ts", "packages/coding/src/tools/index.ts", "packages/triggers/src/store.ts", "src/extensions/themes/index.ts"]) {
			expect(selectRuns([file])).toMatchObject({ full: false, root: true, web: false, daemons: false });
		}
	});

	it("runs each package's own tests for a change in it, and every package's for one in @pim/shared, which they depend on", () => {
		expect(selectRuns(["packages/ui-lang/src/parse.ts"])).toEqual({ full: false, root: true, web: true, daemons: false, packages: ["ui-lang"] });
		expect(selectRuns(["packages/coding/src/pools.ts", "packages/triggers/src/time.ts"])).toMatchObject({ packages: ["coding", "triggers"] });
		expect(selectRuns(["packages/shared/src/http.ts"])).toMatchObject({ packages: ["coding", "core", "shared", "triggers", "ui-lang"] });
	});

	it("keeps a package's own tests out of the root project, but not the support modules the Worker's tests import", () => {
		expect(selectRuns(["packages/ui-lang/test/ui-lang.test.ts"])).toEqual({ full: false, root: false, web: false, daemons: false, packages: ["ui-lang"] });
		expect(selectRuns(["packages/coding/test/pools.test.ts"])).toEqual({ full: false, root: false, web: false, daemons: false, packages: ["coding"] });
		expect(selectRuns(["packages/coding/test/support/fake-manager.ts"])).toEqual({ full: false, root: true, web: false, daemons: false, packages: ["coding"] });
	});

	it("maps each daemon to its own tests, and a daemon's bundle that web/ builds from to the web app's as well", () => {
		expect(selectRuns(["sandbox-manager/src/main.js"])).toEqual({ full: false, root: false, web: false, daemons: true, packages: [] });
		expect(selectRuns(["sandbox-manager/hostopsd/test/install.test.js"])).toEqual({ full: false, root: false, web: false, daemons: true, packages: [] });
		expect(selectRuns(["workspace-agentd/test/agentd.test.mjs"])).toEqual({ full: false, root: false, web: false, daemons: true, packages: [] });
		// What the Worker's tests read of displayd is its bundle; the rest is its own.
		expect(selectRuns(["displayd/src/allocator.js"])).toEqual({ full: false, root: false, web: false, daemons: true, packages: [] });
		expect(selectRuns(["displayd/bundle.js"])).toEqual({ full: false, root: true, web: true, daemons: true, packages: [] });
		expect(selectRuns(["displayd/bundle.d.ts", "src/pim.ts"])).toEqual({ full: false, root: true, web: true, daemons: true, packages: [] });
		expect(selectRuns(["sandbox-manager/src/main.js", "web/src/main.tsx"])).toEqual({ full: false, root: false, web: true, daemons: true, packages: [] });
		expect(selectRuns(["sandbox-manager/README.md", "docs/reference.md"])).toEqual({ full: false, root: false, web: false, daemons: true, packages: [] });
	});

	it("keeps computer/ with the root project, whose node tests run it", () => {
		expect(selectRuns(["computer/pim-computer.ts"])).toEqual({ full: false, root: true, web: false, daemons: false, packages: [] });
	});

	it("runs the whole suite when nothing in the diff maps to a test", () => {
		expect(selectRuns(["README.md", "docs/reference.md", "LICENSE", ".github/workflows/ci.yml"])).toEqual({
			full: true,
			reason: "no tests map to what changed",
		});
	});

	it("runs the whole suite when there is nothing to diff", () => {
		expect(selectRuns([])).toEqual({ full: true, reason: "nothing changed to diff" });
	});

	it("skips empty names and duplicates", () => {
		expect(selectRuns(["", "src/pim.ts", "src/pim.ts"])).toEqual({ full: false, root: true, web: false, daemons: false, packages: [] });
	});
});
