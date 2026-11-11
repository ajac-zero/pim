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
		expect(selectRuns(["src/pim.ts"])).toEqual({ full: false, root: true, web: false });
		expect(selectRuns(["test/auth.test.ts", "preview/worker.ts", "scripts/install-test-browser.mjs"])).toEqual({ full: false, root: true, web: false });
	});

	it("maps web/ to the web app's tests", () => {
		expect(selectRuns(["web/src/main.tsx"])).toEqual({ full: false, root: false, web: true });
		expect(selectRuns(["web/src/main.tsx", "src/pim.ts"])).toEqual({ full: false, root: true, web: true });
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
		expect(selectRuns(["", "src/pim.ts", "src/pim.ts"])).toEqual({ full: false, root: true, web: false });
	});
});
