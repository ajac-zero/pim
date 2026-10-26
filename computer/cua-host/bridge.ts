/**
 * The bridge's program (docs/cua-bridge.md): run in the bridge's own
 * account, it serves one space's `Relay` (../cua-bridge.ts) over HTTPS with
 * the Node host (./host.ts), and opens each session on the desktop
 * endpoint's Unix socket (./session.ts, ./desktop.ts). It is the only
 * program that reads the bridge's token and TLS key.
 *
 *   PIM_BRIDGE_TOKEN_FILE=/etc/pim-bridge/token PIM_BRIDGE_CERT_FILE=/etc/pim-bridge/cert.pem \
 *   PIM_BRIDGE_KEY_FILE=/etc/pim-bridge/key.pem \
 *   node bridge.ts --space o_… --path /pim --socket /run/pim-session/session.sock --host 0.0.0.0 --port 8443
 *
 * The token and the key are read from the files the environment names,
 * never from flags, so they don't show in a process list; each must be a
 * regular file of this account's that its group and others can't read.
 * Neither, nor what reading them threw, is ever logged.
 */

import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Relay } from "../cua-bridge.ts";
import { createHost } from "./host.ts";
import { unixSession } from "./session.ts";

const USAGE = `A Cua bridge: serves one space's relay over HTTPS, with sessions on the desktop endpoint's Unix socket.

  PIM_BRIDGE_TOKEN_FILE=… PIM_BRIDGE_CERT_FILE=… PIM_BRIDGE_KEY_FILE=… \\
  node bridge.ts --space <owner ID> --path <path> --socket <path> --host <address> --port <port>

See docs/cua-bridge.md.`;

/** A secret file's contents, when it is a regular file of this account's that no one else can read. */
function secret(variable: string): Buffer {
	const file = process.env[variable];
	if (!file) throw new Error(`${variable} must name a file.`);
	const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) {
			throw new Error(`The file ${variable} names must be a regular file of the bridge's account that no one else can read.`);
		}
		return fs.readFileSync(descriptor);
	} finally {
		fs.closeSync(descriptor);
	}
}

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	let values: { space?: string; path?: string; socket?: string; host?: string; port?: string };
	try {
		({ values } = parseArgs({ options: { space: { type: "string" }, path: { type: "string" }, socket: { type: "string" }, host: { type: "string" }, port: { type: "string" } } }));
	} catch {
		values = {};
	}
	if (!values.space || !values.path || !values.socket || !values.host || !values.port || !/^\d{1,5}$/.test(values.port)) {
		console.error(USAGE);
		process.exit(2);
	}
	let stage = "settings";
	try {
		const open = unixSession({ socketPath: values.socket });
		stage = "token";
		const token = secret("PIM_BRIDGE_TOKEN_FILE").toString("utf8").trim();
		stage = "certificate";
		const cert = secret("PIM_BRIDGE_CERT_FILE");
		const key = secret("PIM_BRIDGE_KEY_FILE");
		stage = "relay";
		const relay = new Relay({ space: values.space, token, path: values.path, open });
		stage = "host";
		const host = createHost({ relay, transport: { kind: "https", cert, key, host: values.host, port: Number(values.port) } });
		await host.listen();
		const stop = () => {
			void host.close().then(() => process.exit(0));
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
	} catch {
		// What failed may carry a secret's contents or path, so only where it failed is said.
		console.error(JSON.stringify({ event: "bridge.failed", reason: stage }));
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
