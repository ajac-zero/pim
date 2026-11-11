// Runs in Node: the script that ensures displayd on a computer is checked as text and with `sh -n`, never run for real, and the bundle the Pim serves is unpacked with tar.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { displaydSetupScript, displaydUnit, ensureDisplayd } from "../computer/pim-computer";
import { displaydBundle, displaydFiles } from "../displayd/bundle.js";

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
		for (const file of displaydFiles()) expect(readFileSync(path.join(into, file))).toEqual(readFileSync(path.join(import.meta.dirname, "..", "displayd", file)));
	});

	it("is the same bytes every time, so a computer can tell by its checksum that it has the newest", () => {
		expect(displaydBundle().equals(displaydBundle())).toBe(true);
	});
});
