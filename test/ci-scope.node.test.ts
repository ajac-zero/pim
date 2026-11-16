// Which CI jobs a change needs, from the files it touches: a push to main runs them all, and a branch only
// those its files can reach.
import { describe, expect, it } from "vitest";
import { JOBS, selectJobs } from "../scripts/ci-scope.mjs";

/** The names of the jobs that run. */
const running = (files: string[], main = false) =>
	Object.entries(selectJobs(files, { main }))
		.filter(([, run]) => run)
		.map(([job]) => job)
		.sort();

describe("choosing CI's jobs for a change", () => {
	it("runs every job on main, whatever changed", () => {
		expect(running(["README.md"], true)).toEqual([...JOBS].sort());
	});

	it("runs only the internal-identifier check for prose", () => {
		expect(running(["README.md", "docs/reference.md", "LICENSE", "sandbox-manager/README.md"])).toEqual([]);
	});

	it("runs the types, the linter and the web tests for web/ alone, and no Worker, browser or daemon job", () => {
		expect(running(["web/src/main.tsx", "docs/reference.md"])).toEqual(["lint", "typecheck", "web"]);
	});

	it("runs only the daemons' tests for a daemon alone", () => {
		expect(running(["sandbox-manager/src/main.js"])).toEqual(["daemons"]);
		expect(running(["workspace-agentd/src/agentd.js", "displayd/src/allocator.js"])).toEqual(["daemons"]);
	});

	it("adds what reads displayd's bundle: the web app's types and the Worker's tests", () => {
		expect(running(["displayd/bundle.js"])).toEqual(["daemons", "typecheck", "unit", "web", "worker"]);
	});

	it("runs only the types and the unit job for a v2 package, which nothing else imports", () => {
		expect(running(["packages/v2-contracts/src/db.ts", "packages/v2-contracts/migrations/0001_foundation.sql", "scripts/v2-migrate/run.mjs"])).toEqual(["typecheck", "unit"]);
	});

	it("runs the backend's jobs without the browser for the Worker's code, and the web app too for what it imports", () => {
		expect(running(["src/pim.ts", "test/agents.test.ts"])).toEqual(["lint", "typecheck", "unit", "worker"]);
		expect(running(["packages/ui-lang/src/parse.ts"])).toEqual(["lint", "typecheck", "unit", "web", "worker"]);
		expect(running(["packages/shared/src/transcript.ts"])).toEqual(["lint", "typecheck", "unit", "web", "worker"]);
	});

	it("runs a package's source in the Worker's tests too, as the Worker runs it, and only its types and unit tests for a change that is all its own tests", () => {
		expect(running(["packages/coding/src/pools.ts"])).toEqual(["lint", "typecheck", "unit", "worker"]);
		expect(running(["packages/triggers/src/store.ts"])).toEqual(["lint", "typecheck", "unit", "worker"]);
		expect(running(["packages/ui-lang/test/ui-lang.test.ts", "packages/coding/test/pools.test.ts"])).toEqual(["typecheck", "unit"]);
		// The support modules the Worker's tests import are not the package's alone.
		expect(running(["packages/coding/test/support/fake-manager.ts"])).toEqual(["lint", "typecheck", "unit", "worker"]);
	});

	it("runs the browser job only for what browsing reaches", () => {
		for (const file of ["src/browser.ts", "src/extensions/browser.ts", "src/space/routes.ts", "src/space/sockets.ts", "src/space/views.ts", "computer/pim-computer.ts", "test/browser.test.ts", "test/helpers.ts", "test/worker.ts"]) {
			expect(running([file])).toContain("browser");
		}
		expect(running(["src/coding/thread-do.ts"])).not.toContain("browser");
		expect(running(["src/space/approvals.ts"])).not.toContain("browser");
	});

	it("runs every job when the dependencies, the build, the test setup or CI itself change", () => {
		for (const file of ["package.json", "web/package.json", "pnpm-lock.yaml", "vitest.config.ts", "wrangler.jsonc", "tsconfig.json", ".github/workflows/ci.yml"]) {
			expect(running(["docs/reference.md", file])).toEqual([...JOBS].sort());
		}
	});

	it("adds up the jobs of every file in the change", () => {
		expect(running(["web/src/main.tsx", "sandbox-manager/src/main.js"])).toEqual(["daemons", "lint", "typecheck", "web"]);
		expect(running(["web/src/main.tsx", "src/pim.ts"])).toEqual(["lint", "typecheck", "unit", "web", "worker"]);
	});
});
