/**
 * pim-host: keeps the computers of everyone on a Pim, on this machine. Each
 * space gets one, permanently: a VM made with Cua
 * (https://github.com/trycua/cua), which runs all the time (Omarchy, or
 * Ubuntu where Omarchy can't run, as on a Mac with Apple silicon), with
 * pim-computer (./pim-computer.ts) in its desktop session, connected to its
 * space. The space's agents run commands, keep files and browse there, and
 * the person uses its desktop from the app, through cua-spacesd's stream.
 *
 * It needs Linux with KVM, or a Mac with Apple silicon, Cua's `cua` command, and no open
 * port: it asks the Pim for work at `/api/computer-host/sync` every few
 * seconds, with the token Settings → Deployment → Computers gives, and
 * reports what it did (src/computer-host.ts). Work is to make a space's
 * computer, with the token it connects to its space with, or to remove one.
 * It also starts any of its computers that stopped, as after this machine
 * restarted.
 *
 * The Pim's install script installs it, with Node.js 22.18 or later where
 * the machine has none, and `pim-host install` (`install`) does the rest:
 * it checks for KVM and Cua, setting Cua up where it can, checks the token
 * with the Pim, and runs pim-host as the user's service from then on:
 *
 *   curl -fsSL https://pim.example.com/install.sh | sh -s -- host pimh_…
 *
 * Or run it yourself, with ./pim-computer.ts beside it for the commands:
 *
 *   PIM_URL=https://pim.example.com PIM_HOST_TOKEN=pimh_… node pim-host.ts
 */

import { constants, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { Service } from "./pim-computer.ts";

export const VERSION = "0.1.0";

/**
 * The image computers are made from, as Cua builds it, with cua-spacesd and
 * Chromium: Omarchy's edge channel, which is x86-64 only, or elsewhere (a Mac
 * with Apple silicon, an ARM server) Cua's Ubuntu desktop as a VM.
 */
const DEFAULT_IMAGE = process.arch === "x64" ? "ghcr.io/trycua/omarchy:edge" : "ghcr.io/trycua/linux:24.04-disk";
/** The computers this program keeps are named `pim-<owner>`; it leaves every other sandbox alone. */
const PREFIX = "pim-";
/** What installs Cua's command. */
const CUA_INSTALL = "curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --no-onboarding";

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
 * with bash: the agents' Chromium shared with the person's (one profile, so
 * whichever of them opens it, the other uses the same), and then the Pim's
 * install script, as a person's own computer is set up, which gets Node.js
 * where the image has none new enough, and pim-computer, with its token when
 * one is given, as a service of the desktop's session (or, where there's no
 * systemd for the user, as in a container, a loop in the background).
 * Running it again sets it up again: with a new token, it restarts
 * pim-computer, and otherwise starts it if it isn't running. The browser it
 * started goes on running across its restarts.
 */
export function setupScript(pimUrl: string, token: string | null): string {
	return `set -euo pipefail
PIM_URL=${quote(pimUrl)}
TOKEN=${token === null ? "''" : quote(token)}
DIR="$HOME/.pim-computer"
export XDG_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
# Not set up yet: its first request, with its token, sets it up.
[ -n "$TOKEN" ] || [ -s "$DIR/token" ] || { echo "This computer has no token for its Pim yet."; exit 0; }

# One browser for the person and the agents: Chromium, however it's opened, uses pim-computer's profile, and says where DevTools is.
FLAGS="\${XDG_CONFIG_HOME:-$HOME/.config}/chromium-flags.conf"
mkdir -p "$(dirname "$FLAGS")"
grep -q -- '--user-data-dir=' "$FLAGS" 2>/dev/null || printf -- '--user-data-dir=%s\\n--remote-debugging-port=0\\n' "$DIR/browser" >>"$FLAGS"

curl -fsSL --retry 5 "$PIM_URL/install.sh" | PIM_URL="$PIM_URL" PIM_COMPUTER_TOKEN="$TOKEN" sh -s -- computer --root "$HOME/pim" --headful --desktop
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

/** The sandbox runtime each kind needs, as `cua runtime doctor` names it. */
const RUNTIMES: Record<string, string> = { vm: "qemu", container: "container", microvm: "firecracker" };

/** Where Cua's command is: as named, on the PATH, or where Cua's installer puts it; null where it isn't. */
async function findCua(named: string): Promise<string | null> {
	const os = await import("node:os");
	const places = named.includes("/") ? [named] : [...(process.env.PATH ?? "").split(":"), path.join(os.homedir(), ".local", "bin")].filter(Boolean).map((dir) => path.join(dir, named));
	for (const place of places) {
		if (await fs.access(place, constants.X_OK).then(() => true, () => false)) return place;
	}
	return null;
}

/** Whether the Pim knows the token, asking without taking work: null when it does, and otherwise what's wrong. */
async function checkToken(url: string, token: string): Promise<string | null> {
	const response = await fetch(new URL("/api/computer-host/sync", url), {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ results: [], check: true }),
		signal: AbortSignal.timeout(30_000),
	}).catch((error: Error) => error);
	if (response instanceof Error) return `Couldn't reach ${url}: ${response.cause instanceof Error ? response.cause.message : response.message}`;
	if (response.status === 401) return "The Pim doesn't know this token: pair the host again in Settings → Deployment → Computers, and use the command it gives.";
	if (!response.ok) return `${url} answered ${response.status}: is it a Pim, and is this pim-host as new as it?`;
	return null;
}

/** Settings as the options and environment give them, with their defaults. */
function readOptions(values: Record<string, string | boolean | undefined>, env: Record<string, string | undefined>, token: string): Options {
	const url = (values.url as string | undefined) ?? env.PIM_URL ?? "";
	return {
		url,
		token,
		computerUrl: (values["computer-url"] as string | undefined) ?? env.PIM_COMPUTER_URL ?? url,
		image: (values.image as string | undefined) ?? env.PIM_HOST_IMAGE ?? DEFAULT_IMAGE,
		kind: (values.kind as string | undefined) ?? env.PIM_HOST_KIND ?? "vm",
		cpu: Number((values.cpu as string | undefined) ?? env.PIM_HOST_CPU ?? 4),
		memory: (values.memory as string | undefined) ?? env.PIM_HOST_MEMORY ?? "8GB",
		cua: (values.cua as string | undefined) ?? env.PIM_CUA ?? "cua",
		intervalMs: 5_000,
	};
}

const hostService = async (): Promise<Service> => {
	const os = await import("node:os");
	return { name: "pim-host", description: "pim-host: keeps the computers of everyone on a Pim", dir: path.join(os.homedir(), ".pim-host") };
};

/** What `install` wrote for the service to run with, as the environment. */
async function installedEnv(service: Service): Promise<Record<string, string>> {
	const written = await fs.readFile(path.join(service.dir, "env"), "utf8").catch(() => "");
	return Object.fromEntries([...written.matchAll(/^(\w+)='(.*)'$/gm)].map(([, name, value]) => [name!, value!.replaceAll(`'"'"'`, "'")]));
}

/**
 * `pim-host install`: checks that this machine can keep computers, with
 * KVM and Cua's runtime for their kind, setting the runtime up where Cua
 * can, and that the Pim knows the token; then runs pim-host as the user's
 * service from boot (see pim-computer.ts's `Service`), with the options
 * given, and a `pim-host` command to manage it. Running it again sets it up
 * again, and restarts it if what it runs with changed.
 */
async function install(values: Record<string, string | boolean | undefined>): Promise<void> {
	const os = await import("node:os");
	const { startService, writeChanged, installCommand, shellQuote } = await import("./pim-computer.ts");
	const say = (line: string) => console.log(line);
	if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("pim-host runs on Linux or macOS.");
	const service = await hostService();
	const dir = service.dir;
	await fs.mkdir(dir, { recursive: true, mode: 0o700 });
	const tokenFile = path.join(dir, "token");
	const token = (values.token as string | undefined) || process.env.PIM_HOST_TOKEN || (await fs.readFile(tokenFile, "utf8").catch(() => "")).trim();
	const options = readOptions(values, process.env, token);
	if (!options.url) throw new Error("Give your Pim's address with --url.");
	if (!token) throw new Error("Give the token from Settings → Deployment → Computers with --token.");

	// On a Mac, VMs run with Apple's Hypervisor.framework, which Cua's runtime check covers.
	if (options.kind === "vm" && process.platform === "linux") {
		const kvm = await fs.stat("/dev/kvm").catch(() => null);
		if (!kvm) throw new Error("This machine has no KVM (/dev/kvm), which full VMs need: use a bare-metal machine, or a cloud VM with nested virtualization turned on. Or make the computers containers, which can't run Docker inside and share this machine's kernel: --image linux --kind container");
		if (!(await fs.access("/dev/kvm", constants.R_OK | constants.W_OK).then(() => true, () => false))) {
			throw new Error(`You can't use KVM yet: add yourself to its group (sudo usermod -aG kvm ${os.userInfo().username}), sign in again, and run this again.`);
		}
		say("KVM: yes.");
	}

	let cuaPath = await findCua(options.cua);
	if (!cuaPath && options.cua === "cua") {
		say("Installing Cua's command…");
		const { spawnSync } = await import("node:child_process");
		spawnSync("sh", ["-c", CUA_INSTALL], { stdio: ["ignore", "inherit", "inherit"] });
		cuaPath = await findCua("cua");
	}
	if (!cuaPath) throw new Error(`Cua's command isn't there (${options.cua}). Install it: ${CUA_INSTALL}`);
	const located = { ...options, cua: cuaPath };
	say(`Cua: ${(await cua(located, ["--version"])).stdout.trim()}.`);

	// Cua's runtime for this kind of computer, which `cua runtime setup` provisions where it can (with sudo, asking for no password).
	const runtime = RUNTIMES[options.kind];
	if (runtime) {
		type Backend = { backend: string; ready: boolean; provisionable: boolean; detail: string; missing: string[] };
		const doctor = async () => {
			const run = await cua(located, ["runtime", "doctor", "--json"]);
			return ((JSON.parse(run.stdout || "{}") as { backends?: Backend[] }).backends ?? []).find((backend) => backend.backend === runtime);
		};
		let backend = await doctor();
		if (backend && !backend.ready && backend.provisionable) {
			say(`Setting up Cua's ${runtime} runtime…`);
			await cua(located, ["runtime", "setup", runtime]);
			backend = await doctor();
		}
		if (backend && !backend.ready) {
			throw new Error(`Cua's ${runtime} runtime isn't ready: ${backend.detail}${backend.missing.length ? ` (missing: ${backend.missing.join(", ")})` : ""}. Run \`cua runtime setup ${runtime}\`, which uses sudo, then run this again.`);
		}
		say(`Cua's ${runtime} runtime: ready.`);
	}

	const problem = await checkToken(options.url, token);
	if (problem) throw new Error(problem);
	say(`${options.url} knows this host's token.`);

	// The programs live in the folder, where `run` updates them; ones run from elsewhere are copied there.
	const program = path.join(dir, "pim-host.ts");
	const self = realpathSync(process.argv[1]!);
	if (self !== program) {
		await fs.copyFile(self, program);
		await fs.copyFile(path.join(path.dirname(self), "pim-computer.ts"), path.join(dir, "pim-computer.ts"));
	}
	const settings: [string, string | undefined][] = [
		["PIM_URL", options.url],
		["PIM_HOST_TOKEN_FILE", tokenFile],
		// Cua finds QEMU and the rest on the PATH of whoever installed it (Homebrew's, on a Mac), not the service manager's short one.
		["PATH", process.env.PATH],
		["PIM_CUA", cuaPath],
		["PIM_COMPUTER_URL", values["computer-url"] as string | undefined],
		["PIM_HOST_IMAGE", values.image as string | undefined],
		["PIM_HOST_KIND", values.kind as string | undefined],
		["PIM_HOST_CPU", values.cpu as string | undefined],
		["PIM_HOST_MEMORY", values.memory as string | undefined],
	];
	const changed = [
		await writeChanged(tokenFile, `${token}\n`, 0o600),
		await writeChanged(
			path.join(dir, "env"),
			settings
				.filter(([, value]) => value)
				.map(([name, value]) => `${name}=${shellQuote(value!)}\n`)
				.join(""),
			0o600,
		),
		await writeChanged(
			path.join(dir, "run"),
			`#!/bin/sh
# Starts pim-host with the Pim's newest copy, when it can be had.
DIR=${shellQuote(dir)}
set -a; . "$DIR/env"; set +a
for file in pim-host.ts pim-computer.ts; do
	curl -fsSL --max-time 30 "$PIM_URL/$file" -o "$DIR/next-$file" && mv "$DIR/next-$file" "$DIR/$file"
done
exec ${shellQuote(process.execPath)} "$DIR/pim-host.ts"
`,
			0o755,
		),
	].some(Boolean);
	const { kind, atBoot } = await startService(service, changed);
	const bin = await installCommand("pim-host", program);
	say(`pim-host ${VERSION} is installed and running: it keeps computers for ${options.url}, made from ${options.image}.`);
	if (kind === "systemd" && !atBoot) {
		say(`It stops when you sign out, and so would the computers it starts again. To run it from boot: sudo loginctl enable-linger ${os.userInfo().username}`);
	}
	if (kind === "launchd") say("It runs while you're signed in to this Mac: turn on automatic login, so it and the computers start again after the Mac restarts.");
	if (kind === "loop") say("This machine has no systemd for you, so it runs in the background until the machine restarts: run `pim-host install` again then.");
	say(`Settings → Deployment → Computers shows it connected in a few seconds. Manage it with: pim-host status | logs | update | uninstall${bin ? ` (add ${bin} to your PATH)` : ""}`);
}

/** `pim-host status`: whether it runs, whether the Pim knows its token, and the computers it keeps. */
async function status(): Promise<void> {
	const { serviceState } = await import("./pim-computer.ts");
	const service = await hostService();
	const state = await serviceState(service);
	if (!state) {
		console.log("pim-host isn't installed here: run the command Settings → Deployment → Computers gives.");
		process.exitCode = 1;
		return;
	}
	const env = await installedEnv(service);
	const token = (await fs.readFile(env.PIM_HOST_TOKEN_FILE ?? path.join(service.dir, "token"), "utf8").catch(() => "")).trim();
	const options = readOptions({}, env, token);
	const how = { systemd: "a systemd user service", launchd: "a launchd agent", loop: "a loop in the background" }[state.kind];
	console.log(`pim-host ${VERSION}, for ${options.url}: ${state.running ? "running" : "not running"}, as ${how}.`);
	console.log((await checkToken(options.url, token)) ?? "The Pim knows its token.");
	const kept = await machines(options).catch((error: Error) => error);
	if (kept instanceof Error) console.log(kept.message);
	else console.log(`Computers (${kept.length}), made from ${options.image}:${kept.map((machine) => `\n  ${machine.name}  ${machine.running ? "running" : "stopped"}`).join("") || " none yet"}`);
	if (!state.running) process.exitCode = 1;
}

/** `pim-host uninstall`: stops it and removes it; the computers it keeps go on running, as they are. */
async function uninstall(): Promise<void> {
	const os = await import("node:os");
	const { removeService } = await import("./pim-computer.ts");
	const service = await hostService();
	const env = await installedEnv(service);
	await removeService(service);
	await fs.rm(service.dir, { recursive: true, force: true });
	await fs.rm(path.join(os.homedir(), ".local", "bin", "pim-host"), { force: true });
	const kept = await machines(readOptions({}, env, "")).catch(() => []);
	console.log("pim-host is uninstalled: this machine no longer keeps computers for your Pim. Unpair it in Settings → Deployment → Computers too.");
	if (kept.length) {
		console.log(`The ${kept.length} computers it kept are still here, as they were, and nothing starts them again; to remove one with everything on it: cua sb rm <name>`);
	}
}

const USAGE = `pim-host ${VERSION}: keeps the computers of everyone on your Pim, on this machine, with Cua.

  curl -fsSL https://pim.example.com/install.sh | sh -s -- host pimh_…

installs it as your service, which keeps it running from boot, with the command Settings → Deployment →
Computers gives, after checking for KVM and Cua (and installing Cua). Then:

  pim-host status      Whether it's running, whether your Pim knows it, and the computers it keeps
  pim-host logs        What it did lately
  pim-host update      Restart it with your Pim's newest pim-host
  pim-host uninstall   Stop it and remove it (the computers stay)

Or run it yourself:

  PIM_URL=https://pim.example.com PIM_HOST_TOKEN=pimh_… node pim-host.ts

Options, for install or running it (or the environment variables in brackets):
  --url <address>           Your Pim's address (PIM_URL)
  --token <token>           The token from Settings → Deployment → Computers (PIM_HOST_TOKEN, or a file named by PIM_HOST_TOKEN_FILE)
  --computer-url <address>  The Pim's address as the computers reach it, when it isn't --url (PIM_COMPUTER_URL)
  --image <image>           What computers are made from (PIM_HOST_IMAGE; ${DEFAULT_IMAGE})
  --kind <kind>             vm, container or microvm, as cua sb create takes it (PIM_HOST_KIND; vm)
  --cpu <count>             Each computer's vCPUs (PIM_HOST_CPU; 4)
  --memory <size>           Each computer's memory (PIM_HOST_MEMORY; 8GB)
  --cua <path>              Cua's command (PIM_CUA; cua)`;

async function main(): Promise<void> {
	const { parseArgs } = await import("node:util");
	const { values, positionals } = parseArgs({
		allowPositionals: true,
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
	const command = positionals[0];
	if (command && !values.help) {
		const commands: Record<string, () => Promise<void>> = {
			install: () => install(values),
			status,
			logs: async () => (await import("./pim-computer.ts")).showLog(await hostService()),
			update: async () => {
				if (!(await (await import("./pim-computer.ts")).restartService(await hostService()))) throw new Error("pim-host isn't installed here.");
				console.log("pim-host restarted with your Pim's newest copy.");
			},
			uninstall,
		};
		if (!commands[command]) {
			console.log(USAGE);
			process.exit(1);
		}
		try {
			await commands[command]();
		} catch (error) {
			console.error((error as Error).message);
			process.exit(1);
		}
		return;
	}
	const env = process.env;
	const tokenFile = env.PIM_HOST_TOKEN_FILE;
	const token = (values.token as string | undefined) ?? env.PIM_HOST_TOKEN ?? (tokenFile ? (await fs.readFile(tokenFile, "utf8")).trim() : undefined);
	const options = readOptions(values, env, token ?? "");
	if (values.help || !options.url || !token) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 1);
	}
	const version = await cua(options, ["--version"]);
	if (version.code !== 0) {
		console.error(`Cua's cua command isn't there (${options.cua}). Install it: ${CUA_INSTALL}`);
		process.exit(1);
	}
	log(`Keeping computers for ${options.url}, made from ${options.image} with ${version.stdout.trim()}.`);
	await serve(options);
}

// Run as a program, not when tests import it.
if (typeof process !== "undefined" && process.argv?.[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) void main();
