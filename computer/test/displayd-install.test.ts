// Runs in Node: the script that ensures displayd on a computer is checked as text and with `sh -n`, never run for real, and the bundle the Pim serves is unpacked with tar.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { chmodSync } from "node:fs";
import { displaydSetupScript, displaydUnit, ensureDisplayd, startEmbeddedDisplayd } from "../pim-computer";
import { displaydBundle, displaydFiles } from "../../displayd/bundle.js";

const setup = { url: "https://pim.test/", user: "cua", home: "/home/cua", node: "/usr/local/lib/nodejs/bin/node" };
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));
const tmp = () => dirs[dirs.push(mkdtempSync(path.join(os.tmpdir(), "displayd-"))) - 1]!;

describe("displayd's service on a computer", () => {
	it("runs as the computer's user and leaves the running displays alone when it restarts", () => {
		const unit = displaydUnit(setup);
		expect(unit).toContain("User=cua\n");
		expect(unit).toContain("KillMode=process\n");
		expect(unit).toContain("RuntimeDirectory=pim\nRuntimeDirectoryMode=0755\nRuntimeDirectoryPreserve=yes\n");
		expect(unit).toContain('Environment="DISPLAYD_TOKEN_FILE=/etc/displayd/token"');
		expect(unit).toContain('Environment="DISPLAYD_STATE_DIR=/home/cua/.displayd/state"');
		expect(unit).toContain('Environment="DISPLAYD_CONTEXT_DIR=/run/pim/displays"');
		expect(unit).toContain("ExecStart=/usr/local/lib/nodejs/bin/node /home/cua/.displayd/app/src/main.js\n");
		expect(unit).toContain("Restart=always");
	});

	it("is one sh script that installs what's missing, fetches the Pim's bundle, makes the token once, and checks /health", () => {
		const script = displaydSetupScript(setup);
		expect(script).not.toMatch(/@[A-Z_]+@/);
		expect(script).toContain("URL='https://pim.test'");
		expect(script).toContain('PACKAGES="tigervnc-standalone-server openbox dbus-x11 at-spi2-core xdotool xclip"');
		expect(script).toContain("apt-get install -y $PACKAGES");
		expect(script).toContain('SUDO="sudo -n"');
		expect(script).toContain('"$URL/displayd.tar.gz"');
		expect(script).toContain("chmod 0640");
		expect(script).toContain('[ ! -s "$TOKEN" ]');
		expect(script).toContain("http://127.0.0.1:9900/health");
		// The unit it installs is the one `displaydUnit` makes.
		expect(script).toContain(displaydUnit(setup).trimEnd());
		// It never fails the install, whatever happens.
		expect(script.trimEnd().endsWith("exit 0")).toBe(true);
		expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
	});

	it("quotes what it's given, and is still sh", () => {
		const script = displaydSetupScript({ ...setup, home: "/home/it's me", user: "a b" });
		expect(script).toContain(`HOME_DIR='/home/it'"'"'s me'`);
		expect(spawnSync("sh", ["-n"], { input: script }).status).toBe(0);
	});

	it("does nothing, and says nothing, where it isn't asked for (PIM_DISPLAYD=0)", async () => {
		const said: string[] = [];
		process.env.PIM_DISPLAYD = "0";
		try {
			await ensureDisplayd("https://pim.test", (line) => said.push(line));
		} finally {
			delete process.env.PIM_DISPLAYD;
		}
		expect(said).toEqual([]);
	});
});

describe("displayd inside the container image", () => {
	/** A directory with the display's programs in it (empty scripts), and a displayd main file. */
	const image = (programs = ["Xvnc", "openbox", "dbus-daemon", "xauth"]) => {
		const bin = tmp();
		for (const program of programs) {
			writeFileSync(path.join(bin, program), "#!/bin/sh\n");
			chmodSync(path.join(bin, program), 0o755);
		}
		const main = path.join(tmp(), "main.js");
		writeFileSync(main, "");
		return { bin, main };
	};
	const fakeChild = () => Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [] as string[], kill(signal: string) { this.killed.push(signal); return true; } });

	it("is not started where the image does not ask for it, or where the display's programs are not installed", async () => {
		const said: string[] = [];
		expect(await startEmbeddedDisplayd({ env: { PATH: "/bin" }, say: (l) => said.push(l) })).toBeNull();
		const { bin, main } = image(["Xvnc", "openbox"]);
		expect(await startEmbeddedDisplayd({ env: { PIM_DISPLAYD_EMBEDDED: "1", PIM_DISPLAYD_MAIN: main, PATH: bin }, home: tmp(), say: (l) => said.push(l) })).toBeNull();
		expect(said).toEqual(["displayd: dbus-daemon is missing in this image, so there are no displays of their own."]);
	});

	it("starts displayd as a child with a token in the computer's home, where the display client looks for it, and starts it again when it exits", async () => {
		const { bin, main } = image();
		const home = tmp();
		const started: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
		const children: ReturnType<typeof fakeChild>[] = [];
		const said: string[] = [];
		const running = await startEmbeddedDisplayd({
			env: { PIM_DISPLAYD_EMBEDDED: "1", PIM_DISPLAYD_MAIN: main, PATH: bin },
			home,
			node: "/usr/bin/node",
			say: (l) => said.push(l),
			restartMs: 5,
			spawnProcess: ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
				started.push({ args, env: options.env });
				children.push(fakeChild());
				return children.at(-1)!;
			}) as never,
		});
		expect(running).not.toBeNull();
		const token = readFileSync(path.join(home, ".displayd", "token"), "utf8").trim();
		expect(token).toMatch(/^[0-9a-f]{48}$/);
		expect(started[0]).toMatchObject({ args: [main], env: { DISPLAYD_TOKEN_FILE: path.join(home, ".displayd", "token"), DISPLAYD_STATE_DIR: path.join(home, ".displayd", "state"), DISPLAYD_CONTEXT_DIR: "/tmp/pim-displays", DISPLAYD_HOST: "127.0.0.1" } });
		children[0]!.stdout.emit("data", Buffer.from("listening on 127.0.0.1:9900\n"));
		expect(said).toContain("displayd: listening on 127.0.0.1:9900");
		// It exits: it is started again, with the same token.
		children[0]!.emit("exit", 1);
		for (let i = 0; i < 100 && started.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
		expect(started).toHaveLength(2);
		expect(readFileSync(path.join(home, ".displayd", "token"), "utf8").trim()).toBe(token);
		// Stopped, it stays stopped.
		running!.stop();
		expect(children[1]!.killed).toEqual(["SIGTERM"]);
		children[1]!.emit("exit", 0);
		await new Promise((r) => setTimeout(r, 30));
		expect(started).toHaveLength(2);
	});
});

describe("the bundle the Pim serves at /displayd.tar.gz", () => {
	it("unpacks to displayd's own files, byte for byte, and to nothing else", () => {
		const out = tmp();
		const archive = path.join(out, "bundle.tar.gz");
		writeFileSync(archive, displaydBundle());
		const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
		expect(listed.status).toBe(0);
		expect(listed.stdout.trim().split("\n")).toEqual(displaydFiles());
		expect(displaydFiles()).toContain("src/main.js");
		expect(displaydFiles().some((file) => file.startsWith("test/") || file.endsWith(".sh"))).toBe(false);
		const into = path.join(out, "app");
		mkdirSync(into);
		expect(spawnSync("tar", ["-xzf", archive, "-C", into]).status).toBe(0);
		for (const file of displaydFiles()) expect(readFileSync(path.join(into, file))).toEqual(readFileSync(path.join(import.meta.dirname, "..", "..", "displayd", file)));
	});

	it("is the same bytes every time, so a computer can tell by its checksum that it has the newest", () => {
		expect(displaydBundle().equals(displaydBundle())).toBe(true);
	});
});
