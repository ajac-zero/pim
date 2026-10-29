/**
 * pim-host: keeps the computers of everyone on a Pim, on this machine. Each
 * space gets one, permanently: an Omarchy VM made with Cua
 * (https://github.com/trycua/cua), which runs all the time, with
 * pim-computer (./pim-computer.ts) in its desktop session, connected to its
 * space. The space's agents run commands, keep files and browse there, and
 * the person uses its desktop from the app, through cua-spacesd's stream.
 *
 * It needs a Linux machine with KVM and Cua's `cua` command, and no open
 * port: it asks the Pim for work at `/api/computer-host/sync` every few
 * seconds, with the token Settings → Deployment → Computers gives, and
 * reports what it did (src/computer-host.ts). Work is to make a space's
 * computer, with the token it connects to its space with, or to remove one.
 * It also starts any of its computers that stopped, as after this machine
 * restarted.
 *
 * Runs on Node.js 22.18 or later, with nothing to install:
 *
 *   PIM_URL=https://pim.example.com PIM_HOST_TOKEN=pimh_… node pim-host.ts
 */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const VERSION = "0.1.0";

/** The image computers are made from: Omarchy's edge channel, as Cua builds it, with cua-spacesd and Chromium. */
const DEFAULT_IMAGE = "ghcr.io/trycua/omarchy:edge";
/** The computers this program keeps are named `pim-<owner>`; it leaves every other sandbox alone. */
const PREFIX = "pim-";
/** Node.js for pim-computer, where the image has none new enough: its official build, checked. */
const NODE_VERSION = "22.23.4";
const NODE_SHA256 = "1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce";

type Request = { id: string; op: "create"; name: string; token: string } | { id: string; op: "delete"; name: string };
type Result = { id: string; error?: string };
type Machine = { name: string; running: boolean };

export type Options = {
	/** The Pim's address, which this asks for work. */
	readonly url: string;
	readonly token: string;
	/** The Pim's address as the computers reach it, which is `url` unless they reach it another way. */
	readonly computerUrl: string;
	readonly image: string;
	/** The kind of sandbox, as `cua sb create --kind` takes it: Omarchy is a VM. */
	readonly kind: string;
	readonly cpu: number;
	readonly memory: string;
	/** The `cua` command. */
	readonly cua: string;
	readonly intervalMs: number;
};

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

/** Runs `cua` with `args`, and `input` on its standard input; what it said, and how it exited. */
async function cua(options: Options, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	const { spawn } = await import("node:child_process");
	return new Promise((resolve) => {
		const child = spawn(options.cua, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CUA_TELEMETRY: process.env.CUA_TELEMETRY ?? "0" } });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-4000);
		});
		child.on("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
		child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
		child.stdin.end(input ?? "");
	});
}

/** A failure of `cua`, said briefly. */
function failed(what: string, run: { code: number; stderr: string; stdout: string }): Error {
	const said = (run.stderr.trim() || run.stdout.trim()).split("\n").slice(-3).join(" ").slice(0, 400);
	return new Error(`${what} failed (cua exited ${run.code})${said ? `: ${said}` : ""}`);
}

/** The computers this program keeps, and whether each runs. */
async function machines(options: Options): Promise<Machine[]> {
	const run = await cua(options, ["sb", "ls", "--local", "--json", "--no-size"]);
	if (run.code !== 0) throw failed("Listing the computers", run);
	const listed = JSON.parse(run.stdout || "[]") as { name?: string; state?: string; status?: string }[];
	return listed
		.filter((sandbox) => typeof sandbox.name === "string" && sandbox.name.startsWith(PREFIX))
		.map((sandbox) => ({ name: sandbox.name!, running: sandbox.state === "running" }));
}

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

/**
 * What sets pim-computer up in a computer, run there as its desktop's user
 * with bash: Node.js, pim-computer as the Pim serves it, its token when one
 * is given, the agents' Chromium shared with the person's (one profile, so
 * whichever of them opens it, the other uses the same), and a user service
 * that runs it in the desktop's session, all the time. Where there's no
 * systemd for the user, as in a container, a loop in the background runs it
 * instead. Running it again sets it up again; with a new token, it
 * restarts pim-computer, and otherwise starts it if it isn't running. The
 * browser it started goes on running across its restarts.
 */
export function setupScript(pimUrl: string, token: string | null): string {
	return `set -euo pipefail
PIM_URL=${quote(pimUrl)}
TOKEN=${token === null ? "''" : quote(token)}
DIR="$HOME/.pim-computer"
mkdir -p "$DIR" "$HOME/pim"
chmod 700 "$DIR"
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [ -n "$TOKEN" ]; then (umask 077 && printf '%s\\n' "$TOKEN" >"$DIR/token"); fi
# Not set up yet: its first request, with its token, sets it up.
[ -s "$DIR/token" ] || { echo "This computer has no token for its Pim yet."; exit 0; }

# Node.js 22.18 or later, for pim-computer: the image's own when it's new enough.
new_enough() { "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null; }
if ! { command -v node >/dev/null && new_enough node; } && ! new_enough "$DIR/node/bin/node"; then
	curl -fsSL --retry 5 --retry-all-errors -o /tmp/pim-node.tar.xz https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz
	echo "${NODE_SHA256}  /tmp/pim-node.tar.xz" | sha256sum -c - >/dev/null
	rm -rf "$DIR/node" && mkdir -p "$DIR/node"
	tar -xJf /tmp/pim-node.tar.xz -C "$DIR/node" --strip-components=1
	rm -f /tmp/pim-node.tar.xz
fi

curl -fsSL --retry 5 --retry-all-errors "$PIM_URL/pim-computer.ts" -o "$DIR/pim-computer.ts"
printf 'PIM_URL=%s\\nPIM_COMPUTER_TOKEN_FILE=%s\\nPIM_BROWSER_HEADFUL=1\\n' "$PIM_URL" "$DIR/token" >"$DIR/env"

# Starts pim-computer in the desktop's session, with the Pim's newest copy when it can be had.
cat >"$DIR/run" <<'RUN'
#!/bin/bash
DIR="$HOME/.pim-computer"
[ -r /run/cua-desktop/desktop.env ] && { set -a; . /run/cua-desktop/desktop.env; set +a; }
set -a; . "$DIR/env"; set +a
export PATH="$DIR/node/bin:$PATH"
curl -fsSL --max-time 30 "$PIM_URL/pim-computer.ts" -o "$DIR/next.ts" && mv "$DIR/next.ts" "$DIR/pim-computer.ts"
exec node "$DIR/pim-computer.ts" --root "$HOME/pim"
RUN
chmod 755 "$DIR/run"

# One browser for the person and the agents: Chromium, however it's opened, uses pim-computer's profile, and says where DevTools is.
FLAGS="\${XDG_CONFIG_HOME:-$HOME/.config}/chromium-flags.conf"
mkdir -p "$(dirname "$FLAGS")"
grep -q -- '--user-data-dir=' "$FLAGS" 2>/dev/null || printf -- '--user-data-dir=%s\\n--remote-debugging-port=0\\n' "$DIR/browser" >>"$FLAGS"

if systemctl --user show-environment >/dev/null 2>&1; then
	mkdir -p "$HOME/.config/systemd/user"
	cat >"$HOME/.config/systemd/user/pim-computer.service" <<'UNIT'
[Unit]
Description=pim-computer: this computer's connection to its Pim
After=graphical-session.target
PartOf=graphical-session.target

[Service]
ExecStart=%h/.pim-computer/run
Restart=always
RestartSec=5
# The browser it starts is the person's too: restarting pim-computer leaves it open, and the new one uses it.
KillMode=process

[Install]
WantedBy=graphical-session.target
UNIT
	systemctl --user daemon-reload
	systemctl --user enable pim-computer.service >/dev/null 2>&1
	if [ -n "$TOKEN" ]; then systemctl --user restart pim-computer.service; else systemctl --user start pim-computer.service; fi
else
	# No systemd for the user: a loop in the background, which a new token replaces.
	running=false
	if [ -s "$DIR/loop.pid" ] && kill -0 "$(cat "$DIR/loop.pid")" 2>/dev/null; then running=true; fi
	if $running && [ -n "$TOKEN" ]; then kill -- "-$(cat "$DIR/loop.pid")" 2>/dev/null || true; running=false; fi
	if ! $running; then
		setsid bash -c 'echo $$ >"$HOME/.pim-computer/loop.pid"; while :; do "$HOME/.pim-computer/run"; sleep 5; done' >>"$DIR/log" 2>&1 </dev/null &
	fi
fi
echo "pim-computer is set up."
`;
}

/** Sets pim-computer up in a computer, as `setupScript` says, through cua-spacesd, with the script on standard input so the token stays off every command line. */
async function setUp(options: Options, name: string, token: string | null): Promise<void> {
	const run = await cua(options, ["sb", "exec", "--stdin", name, "--", "bash", "-s"], setupScript(options.computerUrl, token));
	if (run.code !== 0) throw failed(`Setting up pim-computer in ${name}`, run);
}

/** Makes a space's computer, or sets the one it has up again with a new token. */
async function create(options: Options, name: string, token: string): Promise<void> {
	const existing = (await machines(options)).find((machine) => machine.name === name);
	if (!existing) {
		log(`Making ${name} from ${options.image}; the first one downloads the image, which takes a while.`);
		const args = ["sb", "create", options.image, "--name", name, "--cpu", String(options.cpu), "--memory", options.memory, "--wait", "desktop"];
		if (options.kind) args.push("--kind", options.kind);
		const run = await cua(options, args);
		if (run.code !== 0) throw failed(`Making ${name}`, run);
	} else if (!existing.running) await start(options, name);
	await setUp(options, name, token);
	log(`${name} is set up.`);
}

/** Starts a computer that stopped. */
async function start(options: Options, name: string): Promise<void> {
	log(`Starting ${name}, which stopped.`);
	const resumed = await cua(options, ["sb", "resume", name]);
	if (resumed.code === 0) return;
	const restarted = await cua(options, ["sb", "restart", name]);
	if (restarted.code !== 0) throw failed(`Starting ${name}`, restarted);
}

/** Removes a space's computer, with everything on it; one that's gone already is removed. */
async function remove(options: Options, name: string): Promise<void> {
	const run = await cua(options, ["sb", "rm", name, "--force"]);
	// 3: no such sandbox.
	if (run.code !== 0 && run.code !== 3) throw failed(`Removing ${name}`, run);
	log(`${name} is removed.`);
}

/** Starts the computers that stopped, and pim-computer in them; at the start, pim-computer in every one, whose loop may have gone with this machine. */
async function keepRunning(options: Options, everyone: boolean): Promise<void> {
	for (const machine of await machines(options)) {
		if (machine.running && !everyone) continue;
		try {
			if (!machine.running) await start(options, machine.name);
			await setUp(options, machine.name, null);
		} catch (error) {
			log(`Couldn't start ${machine.name}: ${(error as Error).message}`);
		}
	}
}

/** Asks the Pim for work, reporting what was done, and does it, one request at a time; forever. */
export async function serve(options: Options): Promise<never> {
	const queue: Request[] = [];
	const results: Result[] = [];
	let working = false;
	const work = async () => {
		if (working) return;
		working = true;
		for (let request = queue.shift(); request; request = queue.shift()) {
			try {
				if (request.op === "create") await create(options, request.name, request.token);
				else await remove(options, request.name);
				results.push({ id: request.id });
			} catch (error) {
				log((error as Error).message);
				results.push({ id: request.id, error: (error as Error).message });
			}
		}
		working = false;
	};
	await keepRunning(options, true).catch((error) => log((error as Error).message));
	let lastKept = Date.now();
	let lastListed = 0;
	let wasReached = true;
	for (;;) {
		try {
			const reporting = results.splice(0);
			// The computers it keeps, for the admin to see, once a minute.
			let known: Machine[] | undefined;
			if (Date.now() - lastListed > 60_000) {
				lastListed = Date.now();
				known = await machines(options).catch((error: Error) => {
					log(error.message);
					return undefined;
				});
			}
			const response = await fetch(new URL("/api/computer-host/sync", options.url), {
				method: "POST",
				headers: { Authorization: `Bearer ${options.token}`, "content-type": "application/json" },
				body: JSON.stringify({ results: reporting, ...(known ? { machines: known } : {}), image: options.image, version: VERSION }),
				signal: AbortSignal.timeout(30_000),
			}).catch((error: Error) => error);
			if (response instanceof Error || !response.ok) {
				results.unshift(...reporting);
				if (response instanceof Response && response.status === 401) {
					log("The Pim doesn't know this token: pair this host again in Settings → Deployment → Computers.");
				} else if (wasReached) log(`Couldn't reach ${options.url} (${response instanceof Error ? response.message : response.status}); trying again.`);
				wasReached = false;
			} else {
				if (!wasReached) log(`Reached ${options.url} again.`);
				wasReached = true;
				const { requests } = (await response.json()) as { requests: Request[] };
				for (const request of requests) {
					if (!queue.some((queued) => queued.id === request.id)) queue.push(request);
				}
				void work();
			}
			if (Date.now() - lastKept > 60_000 && !working) {
				lastKept = Date.now();
				await keepRunning(options, false).catch((error) => log((error as Error).message));
			}
		} catch (error) {
			log(`Something went wrong: ${(error as Error).message}`);
		}
		await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
	}
}

const USAGE = `pim-host ${VERSION}: keeps the computers of everyone on your Pim, on this machine, with Cua.

  PIM_URL=https://pim.example.com PIM_HOST_TOKEN=pimh_… node pim-host.ts

Options (or the environment variables in brackets):
  --url <address>           Your Pim's address (PIM_URL)
  --token <token>           The token from Settings → Deployment → Computers (PIM_HOST_TOKEN, or a file named by PIM_HOST_TOKEN_FILE)
  --computer-url <address>  The Pim's address as the computers reach it, when it isn't --url (PIM_COMPUTER_URL)
  --image <image>           What computers are made from (PIM_HOST_IMAGE; ${DEFAULT_IMAGE})
  --kind <kind>             vm, container or microvm, as cua sb create takes it (PIM_HOST_KIND; vm)
  --cpu <count>             Each computer's vCPUs (PIM_HOST_CPU; 4)
  --memory <size>           Each computer's memory (PIM_HOST_MEMORY; 8GB)
  --cua <path>              Cua's command (PIM_CUA; cua)

It needs Cua's cua command (curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --no-onboarding)
and, for Omarchy, KVM: check with cua runtime doctor.`;

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	const fs = await import("node:fs/promises");
	const { values } = parseArgs({
		options: {
			url: { type: "string" },
			token: { type: "string" },
			"computer-url": { type: "string" },
			image: { type: "string" },
			kind: { type: "string" },
			cpu: { type: "string" },
			memory: { type: "string" },
			cua: { type: "string" },
			help: { type: "boolean" },
		},
	});
	const env = process.env;
	const tokenFile = env.PIM_HOST_TOKEN_FILE;
	const url = values.url ?? env.PIM_URL;
	const token = values.token ?? env.PIM_HOST_TOKEN ?? (tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : undefined);
	if (values.help || !url || !token) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 1);
	}
	const options: Options = {
		url,
		token,
		computerUrl: values["computer-url"] ?? env.PIM_COMPUTER_URL ?? url,
		image: values.image ?? env.PIM_HOST_IMAGE ?? DEFAULT_IMAGE,
		kind: values.kind ?? env.PIM_HOST_KIND ?? "vm",
		cpu: Number(values.cpu ?? env.PIM_HOST_CPU ?? 4),
		memory: values.memory ?? env.PIM_HOST_MEMORY ?? "8GB",
		cua: values.cua ?? env.PIM_CUA ?? "cua",
		intervalMs: 5_000,
	};
	const version = await cua(options, ["--version"]);
	if (version.code !== 0) {
		console.error(`Cua's cua command isn't there (${options.cua}). Install it: curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --no-onboarding`);
		process.exit(1);
	}
	log(`Keeping computers for ${url}, made from ${options.image} with ${version.stdout.trim()}.`);
	await serve(options);
}

// Run as a program, not when tests import it.
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
