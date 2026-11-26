// Releasing the web app on its own: one real Pim process keeps running, with a signed-in browser's Live socket open, while the interface it
// serves is switched to another release and rolled back. The process is the same (its pid, its start, its socket) and the session cookie still works,
// because nothing but the directory the Gate reads its files from changed.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { activate, publish, rollback } from "../src/web-release.ts";
import { type Deployment, envFor, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());

function build(dir: string, name: string, extra: Record<string, string> = {}) {
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, "index.html"), `<!doctype html><title>${name}</title><script type="module" src="/assets/index-${name}0000.js"></script>`);
	writeFileSync(join(dir, "assets", `index-${name}0000.js`), `// ${name}`);
	for (const [file, body] of Object.entries(extra)) writeFileSync(join(dir, "assets", file), body);
	writeFileSync(join(dir, "release.json"), JSON.stringify({ id: name }));
	return dir;
}

real("releasing the web app without touching the backend", () => {
	let d: Deployment;
	const scratch = mkdtempSync(join(tmpdir(), "pim-web-switch-"));
	let child: ReturnType<typeof spawn>;
	let log = "";
	const root = join(scratch, "web");
	let origin: string;
	const ingress = (extra: Record<string, string> = {}) => ({ "x-pim-ingress-secret": d.ingressSecret, ...extra });

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress-secret" };
		origin = `http://127.0.0.1:${d.gatePort}`;
		const env = envFor(d, "all-in-one", {
			PIM_HTTP_PORT: String(d.gatePort),
			PIM_DEV_SIGN_IN: "1",
			PIM_WEB_DIR: build(join(scratch, "image"), "image"),
			PIM_WEB_RELEASES: root,
			PIM_KEK_CURRENT: "t",
			PIM_KEK_t: randomBytes(32).toString("base64"),
		});
		child = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "all-in-one"], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { PATH: process.env.PATH!, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout!.on("data", (chunk) => (log += chunk));
		child.stderr!.on("data", (chunk) => (log += chunk));
		await waitFor("Pim to be ready", async () => ((await fetch(`${origin}/readyz`).catch(() => undefined))?.status === 200 ? true : undefined), 60_000);
	}, 120_000);
	afterAll(async () => {
		child?.kill("SIGTERM");
		await new Promise((resolve) => (child && child.exitCode === null ? child.once("exit", resolve) : resolve(null)));
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		rmSync(scratch, { recursive: true, force: true });
	});

	it("keeps the same process, session and open socket through a release, an old tab's chunk request and a rollback", async () => {
		const page = async () => (await fetch(`${origin}/`, { headers: ingress() })).text();
		expect(await page()).toContain("<title>image</title>");

		// Signed in, as a browser would be, with its Live socket open.
		const signIn = await fetch(`${origin}/__dev/sign-in/ada`, { headers: ingress(), redirect: "manual" });
		const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		expect(cookie).not.toBe("");
		const session = async () => ((await (await fetch(`${origin}/auth/session`, { headers: ingress({ cookie }) })).json()) as { signedIn: boolean; account?: { username: string } });
		expect((await session()).account?.username).toBe("ada");
		// What is private is never kept by a browser or a shared cache; the stylesheet every load waits on is revalidated, not downloaded again.
		for (const path of ["/api/sessions", "/auth/session"]) expect((await fetch(`${origin}${path}`, { headers: ingress({ cookie }) })).headers.get("cache-control"), path).toBe("no-store");
		const css = await fetch(`${origin}/api/themes.css`, { headers: ingress() });
		expect(css.headers.get("cache-control")).toBe("no-cache");
		expect((await fetch(`${origin}/api/themes.css`, { headers: ingress({ "if-none-match": css.headers.get("etag")! }) })).status).toBe(304);

		const socket = new WebSocket(`ws://127.0.0.1:${d.gatePort}/api/ws`, { headers: ingress({ cookie }) });
		let closed = false;
		socket.on("close", () => (closed = true));
		await new Promise((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
		socket.send(JSON.stringify({ type: "subscribe", topic: "sidebar" }));
		const pid = child.pid;
		const metric = async () => (await (await fetch(`http://127.0.0.1:${d.gatePort}/healthz`)).text());

		// Release A, then B. Each is one switch of what the Gate reads.
		const a = publish(build(join(scratch, "a"), "aaaa", { "lazy-aaaaaaaa.js": "export default 'a'" }), root);
		activate(root, a.id);
		await waitFor("release A", async () => ((await page()).includes("<title>aaaa</title>") ? true : undefined), 5_000);
		const b = publish(build(join(scratch, "b"), "bbbb", { "lazy-bbbbbbbb.js": "export default 'b'" }), root);
		const pong = () => new Promise<void>((resolve) => (socket.once("pong", () => resolve()), socket.ping()));
		await pong();
		activate(root, b.id);
		await waitFor("release B", async () => ((await page()).includes("<title>bbbb</title>") ? true : undefined), 5_000);

		// A tab opened on A asks for A's lazy chunk after B is live: it is there, kept for good.
		const old = await fetch(`${origin}/assets/lazy-aaaaaaaa.js`, { headers: ingress() });
		expect(old.status).toBe(200);
		expect(old.headers.get("cache-control")).toContain("immutable");
		expect(await old.text()).toBe("export default 'a'");

		// Rolled back, the page is A's again and B's chunk is still there for a tab that opened on B.
		expect(rollback(root)).toBe(a.id);
		await waitFor("rollback to A", async () => ((await page()).includes("<title>aaaa</title>") ? true : undefined), 5_000);
		expect((await fetch(`${origin}/assets/lazy-bbbbbbbb.js`, { headers: ingress() })).status).toBe(200);

		// Nothing about the backend moved: the same process, still ready, the session the cookie names still signed in, and the socket still open and still answering.
		expect(child.pid).toBe(pid);
		expect(child.exitCode).toBeNull();
		expect(await metric()).toBe("ok");
		expect((await session()).account?.username).toBe("ada");
		expect(closed).toBe(false);
		expect(socket.readyState).toBe(WebSocket.OPEN);
		await pong();
		socket.close();
	}, 90_000);
});
