import { env } from "cloudflare:test";

/**
 * Runs before each file of the Cua stand-in lane (vitest.cua-standin.config.ts),
 * whose Worker has no Browser Run binding. Were its configuration ever to give
 * it one, every file fails here, before its tests run, rather than a test
 * reaching the tests' Chrome. Without one, `testBrowser` (test/helpers.ts)
 * throws when called, before anything starts.
 */
if ((env as unknown as { BROWSER?: unknown }).BROWSER !== undefined) {
	throw new Error("The Cua stand-in lane's Worker must have no Browser Run binding (BROWSER), so that no test can start the tests' Chrome.");
}
