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
 * Given all of `--viewer-origin` (where spacesd is), `--viewer-public-origin` (the
 * HTTPS origin a browser loads the viewer from: this bridge's own), `--viewer-journal-dir`
 * and PIM_VIEWER_ROOT_TOKEN_FILE (and optionally `--viewer-display`, `primary` by
 * default, and `--viewer-embed-origin`, the one Pim app origin that may frame it), it also serves
 * the view-only desktop viewer (./viewer-host.ts, docs/cua-viewer-first-preview.md);
 * given none of them it serves the relay alone, and given some, or an invalid
 * one, it refuses to start. The root token's file is checked and
 * read for each launch, like the others never from a flag, and never logged.
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
	let values: { space?: string; path?: string; socket?: string; host?: string; port?: string; "viewer-origin"?: string; "viewer-journal-dir"?: string; "viewer-display"?: string; "viewer-public-origin"?: string; "viewer-embed-origin"?: string };
	try {
		({ values } = parseArgs({
			options: {
				space: { type: "string" },
				path: { type: "string" },
				socket: { type: "string" },
				host: { type: "string" },
				port: { type: "string" },
				"viewer-origin": { type: "string" },
				"viewer-journal-dir": { type: "string" },
				"viewer-display": { type: "string" },
				"viewer-public-origin": { type: "string" },
				"viewer-embed-origin": { type: "string" },
			},
		}));
	} catch {
		values = {};
	}
	if (!values.space || !values.path || !values.socket || !values.host || !values.port || !/^\d{1,5}$/.test(values.port)) {
		console.error(USAGE);
		process.exit(2);
	}
	let stage = "settings";
	let viewer: Awaited<ReturnType<typeof import("./viewer-host.ts").createViewerHost>> | undefined;
	try {
		const open = unixSession({ socketPath: values.socket });
		stage = "token";
		const token = secret("PIM_BRIDGE_TOKEN_FILE").toString("utf8").trim();
		stage = "certificate";
		const cert = secret("PIM_BRIDGE_CERT_FILE");
		const key = secret("PIM_BRIDGE_KEY_FILE");
		stage = "relay";
		const relay = new Relay({ space: values.space, token, path: values.path, open });
		// The viewer is all or nothing: some of its settings given, or any invalid, is a mistake, not a smaller bridge.
		stage = "viewer";
		const flags = { origin: values["viewer-origin"], journalDirectory: values["viewer-journal-dir"], display: values["viewer-display"], publicOrigin: values["viewer-public-origin"], embedOrigin: values["viewer-embed-origin"] };
		const env = { PIM_VIEWER_ROOT_TOKEN_FILE: process.env.PIM_VIEWER_ROOT_TOKEN_FILE };
		// A bridge with none of the viewer's settings never loads its code.
		if (Object.values({ ...flags, ...env }).some((value) => value !== undefined)) {
			const viewerModule = await import("./viewer-host.ts");
			viewer = await viewerModule.createViewerHost(viewerModule.parseViewerSettings(flags, env)!);
		}
		stage = "host";
		const host = createHost({ relay, ...(viewer ? { viewer: viewer.routes } : {}), transport: { kind: "https", cert, key, host: values.host, port: Number(values.port) } });
		await host.listen();
		let stopping = false;
		const stop = () => {
			if (stopping) return;
			stopping = true;
			void (async () => {
				// Exits 0 only when everything was seen settled. Pending, unsettled or unobserved work, or a failure, is a nonzero status, and one failure doesn't hide another.
				let status = 0;
				try {
					// The viewer first: it stops admitting launches and asks its launches to end, and says what it saw.
					const shutdown = viewer ? await viewer.close() : undefined;
					if (shutdown) {
						console.error(JSON.stringify({ event: "bridge.viewer_stopped", ...shutdown }));
						if (!shutdown.settled) status = 3;
					}
				} catch {
					console.error(JSON.stringify({ event: "bridge.viewer_stopped", reason: "failed" }));
					status = 3;
				}
				try {
					await host.close();
				} catch {
					console.error(JSON.stringify({ event: "bridge.failed", reason: "close" }));
					if (status === 0) status = 1;
				}
				process.exit(status);
			})();
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
	} catch {
		// What failed may carry a secret's contents or path, so only where it failed is said.
		console.error(JSON.stringify({ event: "bridge.failed", reason: stage }));
		// A viewer that was opened is shut down, and says what it saw; the status stays the failure's.
		if (viewer) {
			const shutdown = await viewer.close().catch(() => undefined);
			console.error(JSON.stringify({ event: "bridge.viewer_stopped", ...(shutdown ?? { reason: "failed" }) }));
		}
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
