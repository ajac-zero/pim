// The backend and the web app are separate components. One real Pim process (every role, as the preview runs it) has no web app: it answers the paths that are its own and 404s the
// rest, even where the old variables that once pointed it at a build are set. The web app is its own process (web-host/), and releasing a new interface is starting its new
// image: the Pim process (its pid, its start, a signed-in browser's Live socket, its session) is the same one before, through and after, and a page opened on the release before
// still gets its scripts.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { waitFor } from "../../v2-runtime/test/support/rig.ts";
import { type Deployment, envFor, startS3 } from "./support/processes.ts";
import { createStack, describeWith, freePort, hasNats, startNats } from "./support/stack.ts";

const real = describeWith(hasNats());
const WEB_HOST = fileURLToPath(new URL("../../../web-host/src/main.js", import.meta.url));

function build(dir: string, name: string, chunk?: string) {
	mkdirSync(join(dir, "assets"), { recursive: true });
	writeFileSync(join(dir, "index.html"), `<!doctype html><title>${name}</title><script type="module" src="/assets/index-${name}0000.js"></script>`);
	writeFileSync(join(dir, "assets", `index-${name}0000.js`), `// ${name}`);
	if (chunk) writeFileSync(join(dir, "assets", chunk), `export default '${name}'`);
	writeFileSync(join(dir, "release.json"), JSON.stringify({ id: name }));
	return dir;
}

real("the backend and the web app as separate components", () => {
	let d: Deployment;
	const scratch = mkdtempSync(join(tmpdir(), "pim-web-split-"));
	const volume = join(scratch, "pim-web");
	let backend: ReturnType<typeof spawn>;
	let web: ReturnType<typeof spawn> | undefined;
	let webPort: number;
	let backendOrigin: string;
	const webOrigin = () => `http://127.0.0.1:${webPort}`;

	/** Starts the web host as its image does: publish its build into the volume, serve it. Resolves once it is ready. */
	const startWeb = async (source: string) => {
		web = spawn(process.execPath, [WEB_HOST], { env: { PATH: process.env.PATH!, PIM_HTTP_PORT: String(webPort), PIM_WEB_SOURCE: source, PIM_WEB_RELEASES: volume }, stdio: "ignore" });
		await waitFor("the web host to be ready", async () => ((await fetch(`${webOrigin()}/readyz`).catch(() => undefined))?.status === 200 ? true : undefined), 15_000);
	};
	const stopWeb = async () => {
		const child = web;
		if (!child) return;
		child.kill("SIGTERM");
		await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve(null)));
		web = undefined;
	};

	beforeAll(async () => {
		const stack = await createStack();
		d = { stack, nats: await startNats(), s3: await startS3(), gatePort: await freePort(), ingressSecret: "ingress-secret" };
		webPort = await freePort();
		backendOrigin = `http://127.0.0.1:${d.gatePort}`;
		const env = envFor(d, "all-in-one", {
			PIM_HTTP_PORT: String(d.gatePort),
			PIM_DEV_SIGN_IN: "1",
			// What once made the Gate serve a build: there is nothing in the backend that reads either now.
			PIM_WEB_DIR: build(join(scratch, "legacy"), "legacy"),
			PIM_WEB_RELEASES: join(scratch, "legacy-releases"),
			PIM_KEK_CURRENT: "t",
			PIM_KEK_t: randomBytes(32).toString("base64"),
		});
		backend = spawn(process.execPath, ["--import", "tsx", "src/main.ts", "all-in-one"], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { PATH: process.env.PATH!, ...env }, stdio: "ignore" });
		await waitFor("Pim to be ready", async () => ((await fetch(`${backendOrigin}/readyz`).catch(() => undefined))?.status === 200 ? true : undefined), 60_000);
	}, 120_000);
	afterAll(async () => {
		await stopWeb();
		backend?.kill("SIGTERM");
		await new Promise((resolve) => (backend && backend.exitCode === null ? backend.once("exit", resolve) : resolve(null)));
		d?.nats.stop();
		await d?.s3.stop();
		await d?.stack.drop();
		rmSync(scratch, { recursive: true, force: true });
	});

	const ingress = (extra: Record<string, string> = {}) => ({ "x-pim-ingress-secret": d.ingressSecret, ...extra });

	it("serves no web app from the backend: no page, no script, no icon, whatever variables are set", async () => {
		for (const path of ["/", "/index.html", "/chat/abc", "/assets/index-legacy0000.js", "/sw.js", "/favicon.svg", "/manifest.webmanifest", "/release.json"]) {
			const response = await fetch(`${backendOrigin}${path}`, { headers: ingress() });
			expect(response.status, path).toBe(404);
			expect(response.headers.get("content-type") ?? "", path).not.toMatch(/html|javascript/);
			expect(await response.text(), path).not.toMatch(/legacy/);
		}
		// What is the backend's still answers there.
		expect((await fetch(`${backendOrigin}/auth/session`, { headers: ingress() })).status).toBe(200);
		expect((await fetch(`${backendOrigin}/api/themes.css`, { headers: ingress() })).status).toBe(200);
		// What a computer downloads is the backend's, so it matches the backend it pairs with.
		const computer = await fetch(`${backendOrigin}/pim-computer.ts`, { headers: ingress() });
		expect(computer.status).toBe(200);
		const displayd = await fetch(`${backendOrigin}/displayd.tar.gz`, { headers: ingress() });
		expect(displayd.status).toBe(200);
		expect(displayd.headers.get("content-type")).toBe("application/gzip");
		expect((await displayd.arrayBuffer()).byteLength).toBeGreaterThan(1000);
	});

	it("releases the interface by replacing only the web process: same backend, session and Live socket; the old page's scripts still load; a rollback is the older image again", async () => {
		const signIn = await fetch(`${backendOrigin}/__dev/sign-in/ada`, { headers: ingress(), redirect: "manual" });
		const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		expect(cookie).not.toBe("");
		const session = async () => ((await (await fetch(`${backendOrigin}/auth/session`, { headers: ingress({ cookie }) })).json()) as { signedIn: boolean; account?: { username: string } });
		expect((await session()).account?.username).toBe("ada");
		const socket = new WebSocket(`ws://127.0.0.1:${d.gatePort}/api/ws`, { headers: ingress({ cookie }) });
		let closed = false;
		socket.on("close", () => (closed = true));
		await new Promise((resolve, reject) => (socket.once("open", resolve), socket.once("error", reject)));
		socket.send(JSON.stringify({ type: "subscribe", topic: "sidebar" }));
		const pong = () => new Promise<void>((resolve) => (socket.once("pong", () => resolve()), socket.ping()));
		await pong();
		const pid = backend.pid;

		const a = build(join(scratch, "a"), "aaaa", "lazy-aaaaaaaa.js");
		const b = build(join(scratch, "b"), "bbbb", "lazy-bbbbbbbb.js");
		const page = async () => (await fetch(`${webOrigin()}/`)).text();

		await startWeb(a);
		expect(await page()).toContain("<title>aaaa</title>");
		// The web process is replaced by the next release's image. Nothing else is touched.
		await stopWeb();
		expect((await fetch(`${webOrigin()}/`).catch(() => null))?.status).toBeUndefined();
		await pong();
		await startWeb(b);
		expect(await page()).toContain("<title>bbbb</title>");
		const old = await fetch(`${webOrigin()}/assets/lazy-aaaaaaaa.js`);
		expect(old.status).toBe(200);
		expect(old.headers.get("cache-control")).toContain("immutable");
		expect(await old.text()).toBe("export default 'aaaa'");
		// Rolled back: the older image starts again.
		await stopWeb();
		await startWeb(a);
		expect(await page()).toContain("<title>aaaa</title>");
		expect((await fetch(`${webOrigin()}/assets/lazy-bbbbbbbb.js`)).status).toBe(200);

		// The backend never moved: the same process, still ready, the session still signed in, the socket still open and answering.
		expect(backend.pid).toBe(pid);
		expect(backend.exitCode).toBeNull();
		expect((await fetch(`${backendOrigin}/readyz`)).status).toBe(200);
		expect((await session()).account?.username).toBe("ada");
		expect(closed).toBe(false);
		await pong();
		socket.close();
	}, 90_000);

	it("keeps private answers out of every cache, and revalidates the stylesheet every load waits on", async () => {
		const signIn = await fetch(`${backendOrigin}/__dev/sign-in/ada`, { headers: ingress(), redirect: "manual" });
		const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		for (const path of ["/api/sessions", "/auth/session"]) expect((await fetch(`${backendOrigin}${path}`, { headers: ingress({ cookie }) })).headers.get("cache-control"), path).toBe("no-store");
		const css = await fetch(`${backendOrigin}/api/themes.css`, { headers: ingress() });
		expect(css.headers.get("cache-control")).toBe("no-cache");
		expect((await fetch(`${backendOrigin}/api/themes.css`, { headers: ingress({ "if-none-match": css.headers.get("etag")! }) })).status).toBe(304);
	});
});
