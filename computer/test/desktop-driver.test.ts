// Runs in Node against a real display: displayd (../../displayd) starts Xvnc, openbox, the accessibility bus and Pim's own desktop driver (../desktop-driver.ts) for a thread, and
// the computer's DisplayClient calls the driver's tools as an agent's desktop tools do, on a real GTK app. It needs those programs (deploy/Dockerfile.computer installs them; CI's
// `desktop` job too, with PIM_REQUIRE_DESKTOP=1 so a missing one fails rather than skips).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWindows } from "../desktop-driver";
import { DisplayClient } from "../pim-computer";

const ROOT = path.resolve(import.meta.dirname, "../..");
const available = (() => {
	try {
		for (const program of ["Xvnc", "openbox", "dbus-daemon", "xauth", "xdotool", "wmctrl"]) execFileSync("sh", ["-c", `command -v ${program}`]);
		execFileSync("python3", ["-c", "import gi; gi.require_version('Atspi', '2.0'); gi.require_version('Gtk', '3.0'); gi.require_version('Gdk', '3.0')"]);
		return true;
	} catch {
		return false;
	}
})();

// A window with a text field, a button and a label that counts the button's presses.
const APP = `#!/usr/bin/env python3
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk
window = Gtk.Window(title="Pim desktop test")
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry()
label = Gtk.Label(label="presses: 0")
button = Gtk.Button(label="Count")
count = [0]
def pressed(_):
    count[0] += 1
    label.set_text(f"presses: {count[0]}")
button.connect("clicked", pressed)
for widget in (entry, button, label):
    box.pack_start(widget, False, False, 4)
window.add(box)
window.set_default_size(400, 200)
window.connect("destroy", Gtk.main_quit)
window.show_all()
Gtk.main()
`;

describe("Pim's desktop driver on parsing", () => {
	it("reads wmctrl's listing, titles with spaces included", () => {
		expect(parseWindows("0x00200003  0 13780  441  327  400  200  host Pim test window\n0x0040000a -1 0 0 0 1280 800 N/A \nnot a window\n")).toEqual([
			{ id: 0x200003, pid: 13780, x: 441, y: 327, w: 400, h: 200, title: "Pim test window" },
			{ id: 0x40000a, pid: 0, x: 0, y: 0, w: 1280, h: 800, title: "" },
		]);
	});
});

describe.skipIf(!available && process.env.PIM_REQUIRE_DESKTOP !== "1")("Pim's desktop driver on a real display", () => {
	let dir: string;
	let displayd: ChildProcess;
	let client: DisplayClient;
	let url: string;
	const thread = "desktop-test";
	const text = (result: { content: readonly unknown[] }) => (result.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const call = async (tool: string, args: Record<string, unknown> = {}) => {
		const result = await client.call(thread, tool, args);
		return { ...result, text: text(result) };
	};
	const until = async <T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> => {
		const deadline = Date.now() + 30_000;
		for (;;) {
			const value = await read();
			if (ok(value) || Date.now() > deadline) return value;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	};

	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-driver-"));
		await fs.mkdir(path.join(dir, "bin"));
		await fs.writeFile(path.join(dir, "bin", "pim-test-app"), APP, { mode: 0o755 });
		await fs.writeFile(path.join(dir, "token"), "secret\n");
		await fs.mkdir("/tmp/.X11-unix", { recursive: true, mode: 0o1777 }).catch(() => {});
		const port = 19_900 + (process.pid % 90);
		displayd = spawn(process.execPath, [path.join(ROOT, "displayd/src/main.js")], {
			env: {
				PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
				HOME: dir,
				DISPLAYD_TOKEN_FILE: path.join(dir, "token"),
				DISPLAYD_STATE_DIR: path.join(dir, "state"),
				DISPLAYD_CONTEXT_DIR: path.join(dir, "displays"),
				DISPLAYD_PORT: String(port),
				DISPLAYD_DRIVER_BIN: path.join(ROOT, "computer/desktop-driver.ts"),
			},
			stdio: "ignore",
		});
		url = `http://127.0.0.1:${port}`;
		client = new DisplayClient({ url, tokenFile: path.join(dir, "token") });
		await until(() => client.leases(), (leases) => leases !== undefined);
	}, 60_000);

	afterAll(async () => {
		// The display outlives displayd, as it does on a computer: release it first, which ends its processes.
		await fetch(`${url}/release`, { method: "POST", headers: { authorization: "Bearer secret", "content-type": "application/json" }, body: JSON.stringify({ threadId: thread }) }).catch(() => undefined);
		await until(async () => (await client.leases())?.some((one) => one.threadId === thread && one.state !== "gone"), (held) => !held);
		displayd?.kill("SIGTERM");
		await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
	});

	it("opens an app, sees and reads it, and uses it with the pointer, the keys and its accessibility tree", async () => {
		const opened = await until(() => call("launch_app", { name: "pim-test-app" }), (r) => !/display_(starting|queued)/.test(r.text));
		expect(opened.isError, opened.text).toBeFalsy();
		const pid = Number(/pid (\d+)/.exec(opened.text)?.[1]);

		const look = await until(() => call("get_desktop_state"), (r) => r.text.includes("Pim desktop test"));
		expect(look.text).toMatch(new RegExp(`window_id \\d+, pid ${pid}: "Pim desktop test"`));
		const shot = look.content.find((c) => (c as { type: string }).type === "image") as { data: string; mimeType: string };
		expect(shot.mimeType).toBe("image/jpeg");
		expect(Buffer.from(shot.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));

		const apps = await until(() => call("list_apps"), (r) => r.text.includes(`pid ${pid}`));
		expect(apps.text).toContain(`pid ${pid}: "Pim desktop test"`);

		const read = await call("get_window_state", { pid });
		const token = (role: string, name: string) => {
			const line = read.text.split("\n").find((l) => l.includes(`] ${role} ${JSON.stringify(name)}`));
			const snapshot = /Snapshot (s\d+)/.exec(read.text)![1];
			return `${snapshot}:${/^\[(\d+)\]/.exec(line ?? "")?.[1]}`;
		};
		expect(read.text).toMatch(/\] push button "Count"|\] button "Count"/);
		const button = read.text.includes('] push button "Count"') ? token("push button", "Count") : token("button", "Count");
		const field = token("text", "");

		// A click is a real pointer click at the element's middle.
		expect((await call("click", { element_token: button })).text).toMatch(/^Clicked .*"Count" at \(\d+, \d+\)/);
		expect((await call("double_click", { element_token: button })).isError).toBeFalsy();
		const counted = await until(() => call("get_window_state", { pid, query: "presses" }), (r) => r.text.includes("presses: 3"));
		expect(counted.text).toContain('label "presses: 3"');

		// set_value replaces a field's text through the accessibility tree; type_text types after it, and press_key and hotkey reach the field.
		expect((await call("set_value", { element_token: field, value: "héllo" })).isError).toBeFalsy();
		await call("type_text", { element_token: field, text: " there" });
		const typed = await until(() => call("get_window_state", { pid, query: "text" }), (r) => r.text.includes("héllo there"));
		expect(typed.text).toContain('= "héllo there"');
		await call("hotkey", { pid, keys: ["ctrl", "a"] });
		await call("press_key", { pid, key: "backspace" });
		const cleared = await until(() => call("get_window_state", { pid, query: "text" }), (r) => !r.text.includes("héllo"));
		expect(cleared.text).not.toContain("héllo");

		// A token of an element that is gone, or of no read, asks for a new read; kill_app quits only an app of this desktop.
		expect((await call("click", { element_token: "s999:1" })).text).toMatch(/read the window again/);
		expect((await call("kill_app", { pid: process.pid })).text).toMatch(/not an app on this desktop/);
		expect((await call("kill_app", { pid })).text).toBe(`Force-quit ${pid}.`);
		const after = await until(() => call("get_desktop_state"), (r) => !r.text.includes("Pim desktop test"));
		expect(after.text).not.toContain("Pim desktop test");
	});

	it("answers the screen stream's methods that it doesn't stream", async () => {
		const screen = await client.screenOf(thread);
		await expect(screen.open(() => {}, () => {})).rejects.toThrow(/doesn't stream the display/);
	});
});
