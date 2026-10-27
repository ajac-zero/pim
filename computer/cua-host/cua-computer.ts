/**
 * The Cua computer: pim-computer's `--stdio` (`serveStdio` in
 * ../pim-computer.ts) with a native-app dispatcher (`createNativeDispatcher`
 * in ./native-mcp.ts) for one space's Cua VM, so that `native_tool` reaches
 * that VM's spacesd. pim-computer itself imports nothing of this, and Sprites
 * and paired computers serve as before.
 *
 * Nothing starts it yet. The desktop endpoint (./desktop.ts) starts it in
 * place of pim-computer only when the code that makes the endpoint gives
 * `cua`; the endpoint's own program doesn't, and no flag, variable, installer
 * step or service does. It would run as the desktop user, as pim-computer does:
 *
 *   node cua-computer.ts --root <folder> --chrome <browser> --owner <space> --origin <spacesd origin> [--headful]
 *
 * with spacesd's token on descriptor 3 (`CREDENTIAL_FD`), as the endpoint
 * hands it over. Its start, in order:
 *
 * 1. It reads the token from descriptor 3, bounded, and closes the
 *    descriptor once, whether the read succeeds, is refused or throws
 *    (`readCredential` in ./cua-credential.ts). It goes on only if that close
 *    returned: one that throws is refused `credential-close`, so nothing is
 *    served while the descriptor may still be open, and a command, shell or
 *    browser it would start can't inherit it (Node doesn't mark an inherited
 *    descriptor close-on-exec).
 * 2. It makes the dispatcher for the owner and origin it was given, which
 *    checks them and the token and sends nothing yet. A call of another
 *    owner is refused unsent, and requests go only to that origin.
 * 3. Only then does it say its hello and take calls, as pim-computer's
 *    `--stdio` does. Serving goes on after `startCuaComputer` resolves: with
 *    `serveStdio`, it resolves once the hello is written and the input is
 *    being read, not when serving ends. Serving ends when the input does:
 *    the browser quits and the process exits. Nothing here hands back a way
 *    to watch that; the endpoint watches the process's exit.
 *
 * Any refusal ends it before step 3, with exit code 1 and one fixed reason on
 * standard error (which the endpoint discards), never a path, the token, or
 * what Node threw. The endpoint sees that as the child's exit, and starts no
 * other until it has seen it.
 *
 * Importing it does nothing; `startCuaComputer(...)` starts serving.
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { type ServeSettings, serveStdio } from "../pim-computer.ts";
import { CREDENTIAL_FD, CredentialRefused, type CredentialReader, NODE_CREDENTIAL_READER, readCredential } from "./cua-credential.ts";
import { createNativeDispatcher, type Fetch } from "./native-mcp.ts";

/** Why the Cua computer didn't start: a fixed reason, which is all its program reports of it. */
export class CuaComputerRefused extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(`The Cua computer didn't start (${reason}).`);
		this.reason = reason;
	}
}

export type CuaComputerOptions = {
	/** The folder `/workspace` stands for, as the endpoint gives it: absolute. */
	readonly root: string;
	/** The browser, as the endpoint gives it. */
	readonly chrome: string;
	readonly headful: boolean;
	/** The space whose VM this is; a native-app call of any other is refused unsent. */
	readonly owner: string;
	/** spacesd's origin, as `createNativeMcp` takes it; nothing is sent anywhere else. */
	readonly origin: string;
	/** What reads descriptor 3; Node's `fs` unless a test gives its own. */
	readonly reader?: CredentialReader;
	/** The effective user ID; `process.geteuid()` unless a test gives its own. */
	readonly uid?: number;
	/** What the dispatcher sends with; Node's `fetch` unless a test gives its own. */
	readonly fetch?: Fetch;
	/** What serves the space once the dispatcher is made, resolving once serving has begun; `serveStdio` unless a test gives its own. */
	readonly serve?: (settings: ServeSettings) => Promise<void>;
};

/**
 * Starts the Cua computer, in the order above: the credential is read and its
 * descriptor closed first, whatever else is wrong, then the dispatcher is
 * made, then `serve` is called, once, with a `native` that hands each request
 * to the dispatcher and nothing else of the credential. Throws
 * `CuaComputerRefused` before `serve` on any refusal, `credential-close` when
 * the descriptor's close threw, which is never taken as closed.
 *
 * It resolves when `serve` resolves, which for `serveStdio` is once serving
 * has begun: a start, not a lifetime. Awaiting it observes nothing of how or
 * when serving ends.
 */
export async function startCuaComputer(options: CuaComputerOptions): Promise<void> {
	let token: string;
	try {
		token = readCredential(CREDENTIAL_FD, options.uid ?? process.geteuid?.(), options.reader ?? NODE_CREDENTIAL_READER);
	} catch (error) {
		throw new CuaComputerRefused(error instanceof CredentialRefused ? `credential-${error.reason}` : "credential");
	}
	const { root, chrome, headful, owner, origin } = options;
	if (typeof root !== "string" || !path.isAbsolute(root) || typeof chrome !== "string" || chrome === "" || typeof headful !== "boolean") {
		throw new CuaComputerRefused("settings");
	}
	let dispatcher: ReturnType<typeof createNativeDispatcher>;
	try {
		dispatcher = createNativeDispatcher({ origin, token, owner, fetch: options.fetch ?? ((url, init) => fetch(url, init)) });
	} catch {
		// What it threw names the setting, never the token; only the fixed reason is passed on.
		throw new CuaComputerRefused("native-settings");
	}
	await (options.serve ?? serveStdio)({ folder: root, chrome, headful, native: (request) => dispatcher.dispatch(request) });
}

async function main(): Promise<void> {
	const failed = (reason: string, code: number): never => {
		console.error(JSON.stringify({ event: "cua-computer.failed", reason }));
		// Exiting closes descriptor 3 too, if it is still open.
		process.exit(code);
	};
	const { parseArgs } = await import("node:util");
	let values: { root?: string; chrome?: string; owner?: string; origin?: string; headful?: boolean } = {};
	try {
		({ values } = parseArgs({
			options: { root: { type: "string" }, chrome: { type: "string" }, owner: { type: "string" }, origin: { type: "string" }, headful: { type: "boolean" } },
		}));
	} catch {
		failed("usage", 2);
	}
	if (!values.root || !values.chrome || !values.owner || !values.origin) return failed("usage", 2);
	try {
		await startCuaComputer({ root: values.root, chrome: values.chrome, headful: values.headful === true, owner: values.owner, origin: values.origin });
	} catch (error) {
		failed(error instanceof CuaComputerRefused ? error.reason : "serve", 1);
	}
}

// Run as a program, not when tests import it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
