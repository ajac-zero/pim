/**
 * The child of the descriptor-inheritance qualification (./fd3-inheritance.ts,
 * docs/cua-native-host-plan.md, "Qualifying descriptor 3"). It stands where
 * the endpoint would start ../cua-computer.ts, takes the same arguments, and
 * runs the real `startCuaComputer`, so the real `readCredential` reads the
 * real descriptor 3 this process inherited, with two stand-ins: spacesd is a
 * `fetch` that sends nothing anywhere and answers 503, and serving is a check
 * instead of pim-computer, so no browser, driver, MCP server or network is
 * reached.
 *
 * It reports one JSON line on standard output, which the endpoint carries to
 * the connection, and nothing else anywhere:
 *
 * - `inherited`: descriptor 3 was open when it started;
 * - `closedBeforeServe`: by the time serving began, no descriptor of this
 *   process was the file descriptor 3 was (compared by device and inode,
 *   since Node may give the number 3 to something else once it is closed);
 * - `grandchildClean`: a process it started then had no descriptor of that
 *   file either;
 * - `bearer`: the SHA-256 of the bearer the dispatcher sent, which the
 *   qualification compares with its synthetic bytes' and never prints;
 * - or `refused`, the fixed reason the start was refused.
 *
 * It is not a test and is in no suite: it runs only as the child of
 * ./fd3-inheritance.ts, which runs only when separately authorized. Linux only
 * (`/proc/self/fd`). Importing it does nothing.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CuaComputerRefused, startCuaComputer } from "../cua-computer.ts";

/** Whether any descriptor of this process is the file with `dev` and `ino`. */
export function holds(dev: bigint, ino: bigint): boolean {
	for (const name of fs.readdirSync("/proc/self/fd")) {
		try {
			const stat = fs.statSync(`/proc/self/fd/${name}`, { bigint: true });
			if (stat.dev === dev && stat.ino === ino) return true;
		} catch {
			// The directory's own descriptor, closed as it is read, or one that isn't a file.
		}
	}
	return false;
}

/** What a process started from here runs: the same check, in its own process, with the file's identity as arguments. */
const GRANDCHILD = `
import * as fs from "node:fs";
const [dev, ino] = process.argv.slice(-2).map(BigInt);
let held = false;
for (const name of fs.readdirSync("/proc/self/fd")) {
	try {
		const stat = fs.statSync("/proc/self/fd/" + name, { bigint: true });
		if (stat.dev === dev && stat.ino === ino) held = true;
	} catch {}
}
process.stdout.write(held ? "held" : "clean");
`;

async function main(): Promise<void> {
	const say = (line: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ event: "fd3-child", ...line })}\n`);
	const { values } = parseArgs({
		options: { root: { type: "string" }, chrome: { type: "string" }, owner: { type: "string" }, origin: { type: "string" }, headful: { type: "boolean" } },
	});
	let identity: { dev: bigint; ino: bigint };
	try {
		const stat = fs.fstatSync(3, { bigint: true });
		identity = { dev: stat.dev, ino: stat.ino };
	} catch {
		say({ inherited: false });
		process.exit(1);
	}
	let bearer: string | null = null;
	try {
		await startCuaComputer({
			root: values.root ?? "",
			chrome: values.chrome ?? "",
			headful: values.headful === true,
			owner: values.owner ?? "",
			origin: values.origin ?? "",
			// spacesd's stand-in: nothing is sent; the bearer is hashed and dropped.
			fetch: async (_url, init) => {
				const authorization = new Headers(init.headers).get("authorization") ?? "";
				bearer = createHash("sha256").update(authorization.replace(/^Bearer /, ""), "utf8").digest("hex");
				return new Response("unavailable", { status: 503 });
			},
			serve: async (settings) => {
				const closedBeforeServe = !holds(identity.dev, identity.ino);
				const grandchild = spawnSync(process.execPath, ["--input-type=module", "-e", GRANDCHILD, String(identity.dev), String(identity.ino)], {
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 10_000,
					encoding: "utf8",
				});
				// One native call, with this computer's own owner: the dispatcher's setup reaches only the stand-in above.
				await settings.native?.({ owner: values.owner ?? "", agentId: "fd3-qualification", runId: "fd3-run", callId: "fd3-call", tool: "list_apps", arguments: {} });
				say({ inherited: true, closedBeforeServe, grandchildClean: grandchild.status === 0 && grandchild.stdout === "clean", bearer });
				// Stays until its input ends, as pim-computer would.
				process.stdin.resume();
				process.stdin.on("end", () => process.exit(0));
			},
		});
	} catch (error) {
		say({ inherited: true, refused: error instanceof CuaComputerRefused ? error.reason : "serve", heldAfter: holds(identity.dev, identity.ino) });
		process.exit(1);
	}
}

// Run as a program, not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) void main();
