import * as fs from "node:fs/promises";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { api, apiUrl, connectTestComputer, OWNER, pendingApproval, post, say, signedIn, TOKEN, toolUse, url } from "./helpers";
import { faux } from "./worker";

/**
 * Apps with a backend (src/hosted.ts), with a computer whose backend calls
 * the test answers itself: workerd can't start the process, and the
 * supervisor that does has its own tests (computer-apps.node.test.ts).
 */

const ROOT = `/tmp/computer-${crypto.randomUUID()}`;

type Request = { id: string; method: string; path: string; headers: [string, string][]; body?: string };
const started: Record<string, any>[] = [];
const stopped: string[] = [];
const requests: Request[] = [];
let backend: (request: Request) => { status: number; headers: [string, string][]; body: string } | Error = () => ({ status: 200, headers: [], body: "" });
let state = "running";

const raw = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(apiUrl(path), { redirect: "manual", ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers } }));
const page = (address: string, init: RequestInit = {}) => exports.default.fetch(new Request(url(address), { redirect: "manual", ...init }));
const b64 = (text: string) => btoa(text);

async function writeFolder(folder: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		await fs.mkdir(`${ROOT}/${folder}/${path.slice(0, Math.max(0, path.lastIndexOf("/")))}`, { recursive: true });
		await fs.writeFile(`${ROOT}/${folder}/${path}`, content);
	}
}

/** Has the agent deploy a folder, and the person approve it; the agent's last tool result comes back. */
async function deploy(args: Record<string, unknown>) {
	let result = "";
	faux.setResponses([
		toolUse("app_deploy", args as never),
		(context) => {
			const last = context.messages.findLast((message) => message.role === "toolResult");
			result = last?.role === "toolResult" ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : "";
			return toolUse("send_to_user", { message: "Done." });
		},
	]);
	const deploying = say("Deploy it.");
	const approval = await pendingApproval();
	await post(`/approvals/${approval.id}/approve`);
	await deploying;
	return { approval, result };
}

const MANIFEST = JSON.stringify({ backend: { command: "node server.js", install: "npm ci" } });

describe("apps with a backend", () => {
	it("are deployed from a folder once the person approves, and run from a release of their own", async () => {
		// With no computer there is nothing to deploy to.
		faux.setResponses([
			(context) => {
				expect(JSON.stringify(context)).not.toContain("app_deploy");
				return toolUse("send_to_user", { message: "ok" });
			},
		]);
		await say("What can you do?");

		const { body } = await post<{ token: string }>("/computer");
		await connectTestComputer(
			body.token,
			ROOT,
			async () => {
				throw new Error("runs no commands");
			},
			undefined,
			undefined,
			undefined,
			{
				app_start: (args) => {
					started.push(args);
					return { state: "running", pid: 1 };
				},
				app_stop: (args) => {
					stopped.push(args.id);
					return { state: "stopped" };
				},
				app_status: (args) => ({ apps: [{ id: args.id, state, pid: 1, restarts: 2, since: 1, port: 18000 }] }),
				app_logs: () => ({ text: "listening\n" }),
				app_http: (args) => {
					requests.push(args);
					const answered = backend(args);
					if (answered instanceof Error) throw answered;
					return answered;
				},
			},
		);

		await writeFolder("shop", {
			"pim.app.json": MANIFEST,
			"server.js": "// the backend",
			"public/index.html": "<p>Shop</p>",
			"node_modules/dep/index.js": "never part of a version",
			".git/HEAD": "never part of a version",
		});
		const { approval, result } = await deploy({ path: "/workspace/shop", title: "Shop" });
		expect(approval.summary).toBe("Deploy /workspace/shop as the app Shop, and run its backend on your computer");

		const { artifacts } = (await api("/artifacts")).body;
		expect(artifacts).toHaveLength(1);
		const [made] = artifacts;
		expect(made).toMatchObject({ title: "Shop", kind: "hosted", version: 1 });
		expect(result).toContain(`Deployed app ${made.id}, version 1`);
		// A version holds the folder's files, and not what a release installs or a repository keeps.
		const version = (await api(`/artifacts/${made.id}/versions/1`)).body;
		expect(version.files.map((file: { path: string }) => file.path)).toEqual(["pim.app.json", "public/index.html", "server.js"]);

		// The backend started from a copy of the version, on a port Pim chose, with a folder of its own for its data.
		expect(started).toEqual([
			{ id: made.id, dir: `/workspace/.pim/apps/${made.id}/v1`, command: "node server.js", install: "npm ci", port: 18_000, data: `/workspace/.pim/apps/${made.id}/data` },
		]);
		const release = `${ROOT}/.pim/apps/${made.id}/v1`;
		expect(await fs.readFile(`${release}/server.js`, "utf8")).toBe("// the backend");
		expect(await fs.readFile(`${release}/public/index.html`, "utf8")).toBe("<p>Shop</p>");
		await expect(fs.stat(`${release}/node_modules`)).rejects.toThrow();
	});

	it("open in the app's frame from an address with a token, which reaches only the backend", async () => {
		const [made] = (await api("/artifacts")).body.artifacts;
		const framed = await raw(`/artifacts/${made.id}/versions/1/frame`);
		expect(framed.status).toBe(302);
		const address = framed.headers.get("location")!;
		expect(address).toMatch(new RegExp(`^/hosted/${OWNER}/${made.id}/[0-9a-z]+\\.[\\w-]+/$`));

		backend = () => ({
			status: 200,
			headers: [
				["content-type", "text/html"],
				["set-cookie", "session=stolen; Path=/"],
				["set-cookie", "other=1"],
				["content-security-policy", "default-src *"],
				["x-frame-options", "ALLOWALL"],
				["x-shop", "yes"],
			],
			body: b64("<h1>Shop</h1>"),
		});
		// Nothing but the token signs the request in: no key, no cookie.
		const opened = await page(address, { headers: { cookie: "pim_session=secret", authorization: "Bearer secret", "accept-language": "pt" } });
		expect(opened.status).toBe(200);
		expect(await opened.text()).toBe("<h1>Shop</h1>");
		// What the backend sets can't loosen the page's rules or reach Pim's own cookies.
		expect(opened.headers.get("set-cookie")).toBeNull();
		expect(opened.headers.get("x-shop")).toBe("yes");
		expect(opened.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
		expect(opened.headers.get("content-security-policy")).toContain("connect-src 'self'");
		expect(opened.headers.get("content-security-policy")).not.toContain("default-src *");
		expect(opened.headers.get("x-frame-options")).toBeNull();
		expect(opened.headers.get("access-control-allow-origin")).toBe("*");

		const sent = requests.at(-1)!;
		expect(sent).toMatchObject({ id: made.id, method: "GET", path: "/" });
		const names = sent.headers.map(([name]) => name);
		expect(names).not.toContain("cookie");
		expect(names).not.toContain("authorization");
		expect(sent.headers).toContainEqual(["accept-language", "pt"]);
		expect(sent.headers).toContainEqual(["x-forwarded-prefix", address.replace(/\/$/, "")]);

		// What the page asks of its backend goes there with its body and query, and a redirect stays inside the app.
		backend = () => ({ status: 302, headers: [["location", "/items/7"]], body: "" });
		const posted = await page(`${address}api/items?sort=up`, { method: "POST", body: "name=tea", headers: { "content-type": "application/x-www-form-urlencoded" } });
		expect(posted.status).toBe(302);
		expect(posted.headers.get("location")).toBe(`${address.replace(/\/$/, "")}/items/7`);
		expect(requests.at(-1)).toMatchObject({ method: "POST", path: "/api/items?sort=up", body: b64("name=tea") });
		const before = requests.length;
		const preflight = await page(`${address}api/items`, { method: "OPTIONS" });
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		expect(requests.length).toBe(before);

		// A page that goes without the trailing slash is sent where its relative addresses work.
		const bare = await page(address.slice(0, -1), { redirect: "manual" });
		expect(bare.status).toBe(308);
		expect(bare.headers.get("location")).toContain(address);

		// Another app's token, a changed one, and none open nothing.
		const token = address.split("/")[4]!;
		const other = crypto.randomUUID();
		for (const bad of [`/hosted/${OWNER}/${other}/${token}/`, `/hosted/${OWNER}/${made.id}/${token.slice(0, -2)}xx/`, `/hosted/${OWNER}/${made.id}/${"1.".concat(token.split(".")[1]!)}/`]) {
			expect((await page(bad)).status).toBe(404);
		}
		expect(requests.length).toBe(before);
	});

	it("say so when the backend isn't running, and keep its pages out of what the person shares", async () => {
		const [made] = (await api("/artifacts")).body.artifacts;
		const address = (await raw(`/artifacts/${made.id}/versions/1/frame`)).headers.get("location")!;
		backend = () => Object.assign(new Error("App x is stopped, not running."), { code: "ENOTRUNNING" });
		const down = await page(address);
		expect(down.status).toBe(503);
		expect(await down.text()).toContain("backend isn't running");
		backend = () => Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
		expect((await page(address)).status).toBe(503);

		expect((await raw(`/artifacts/${made.id}/circles`, { method: "PUT", body: JSON.stringify({ circles: [] }) })).status).toBe(400);
		expect((await raw(`/artifacts/${made.id}/publish`, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
	});

	it("get a new release for each version, and the older ones stay for a rollback", async () => {
		const [made] = (await api("/artifacts")).body.artifacts;
		await writeFolder("shop", { "server.js": "// the next backend" });
		await fs.rm(`${ROOT}/shop/public`, { recursive: true });
		const { approval } = await deploy({ path: "/workspace/shop", id: made.id });
		expect(approval.summary).toBe("Deploy /workspace/shop as a new version of Shop, and run its backend on your computer");

		const latest = (await api(`/artifacts/${made.id}`)).body;
		expect(latest.version).toBe(2);
		// A file taken out of the folder is out of the version.
		expect((await api(`/artifacts/${made.id}/versions/2`)).body.files.map((file: { path: string }) => file.path)).toEqual(["pim.app.json", "server.js"]);
		expect(started.at(-1)).toMatchObject({ id: made.id, dir: `/workspace/.pim/apps/${made.id}/v2`, port: 18_000 });
		expect(await fs.readFile(`${ROOT}/.pim/apps/${made.id}/v2/server.js`, "utf8")).toBe("// the next backend");
		expect(await fs.readFile(`${ROOT}/.pim/apps/${made.id}/v1/server.js`, "utf8")).toBe("// the backend");
	});

	it("refuse a manifest that promises what isn't built, and a folder with none", async () => {
		await writeFolder("bad", { "pim.app.json": JSON.stringify({ backend: { command: "x" }, access: "public" }), "a.js": "1" });
		const count = (await api("/artifacts")).body.artifacts.length;
		expect((await deploy({ path: "/workspace/bad" })).result).toContain(`has no "access" yet`);
		await writeFolder("none", { "a.js": "1" });
		expect((await deploy({ path: "/workspace/none" })).result).toContain("has no pim.app.json");
		expect((await deploy({ path: "/etc" })).result).toContain("not a folder under /workspace");
		expect((await api("/artifacts")).body.artifacts).toHaveLength(count);
	});

	it("show the person how the backend is doing, and let them stop it or run a version, in their browser", async () => {
		const [made] = (await api("/artifacts")).body.artifacts;
		state = "running";
		expect((await api(`/artifacts/${made.id}/backend`)).body).toEqual({ version: 2, status: { state: "running", restarts: 2, since: 1 }, computer: "online" });
		expect((await api(`/artifacts/${made.id}/backend/logs`)).body).toEqual({ text: "listening\n" });
		// Another kind of app has no backend to ask about.
		expect((await api(`/artifacts/${crypto.randomUUID()}/backend`)).status).toBe(404);

		// Stopping is the owner's, with a token too; running a version is the person's own choice, in their browser.
		const before = started.length;
		expect((await post(`/artifacts/${made.id}/backend/run`, { version: 1 })).status).toBe(403);
		expect(started.length).toBe(before);
		const cookie = await signedIn();
		const asPerson = (path: string, body: unknown) =>
			exports.default.fetch(new Request(apiUrl(path), { method: "POST", headers: { cookie, origin: "https://pim.test", "content-type": "application/json" }, body: JSON.stringify(body) }));
		expect((await asPerson(`/artifacts/${made.id}/backend/run`, { version: 9 })).status).toBe(404);
		const ran = await asPerson(`/artifacts/${made.id}/backend/run`, { version: 1 });
		expect(ran.status).toBe(200);
		expect(started.at(-1)).toMatchObject({ id: made.id, dir: `/workspace/.pim/apps/${made.id}/v1` });
		expect((await api(`/artifacts/${made.id}/backend`)).body.version).toBe(1);
		const stops = stopped.length;
		expect((await post(`/artifacts/${made.id}/backend/stop`)).status).toBe(200);
		expect(stopped.length).toBe(stops + 1);
		expect((await asPerson(`/artifacts/${made.id}/backend/run`, { version: 2 })).status).toBe(200);
	});

	it("show how the backend is doing, stop it, and stop it when the app is deleted", async () => {
		const [made] = (await api("/artifacts")).body.artifacts;
		let said = "";
		const ask = async (name: string) => {
			faux.setResponses([
				toolUse(name, { id: made.id } as never),
				(context) => {
					const last = context.messages.findLast((message) => message.role === "toolResult");
					said = last?.role === "toolResult" ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("") : "";
					return toolUse("send_to_user", { message: "Done." });
				},
			]);
			await say("How is it?");
			return said;
		};
		expect(await ask("app_logs")).toBe("running, restarted 2 times, version 2.\nlistening\n");
		state = "crashed";
		expect(await ask("app_logs")).toContain("crashed, restarted 2 times");
		const stopsBefore = stopped.length;
		await ask("app_stop");
		expect(stopped.slice(stopsBefore)).toEqual([made.id]);

		const address = (await raw(`/artifacts/${made.id}/versions/2/frame`)).headers.get("location")!;
		expect((await raw(`/artifacts/${made.id}`, { method: "DELETE" })).status).toBe(200);
		expect(stopped.slice(stopsBefore)).toEqual([made.id, made.id]);
		expect((await page(address)).status).toBe(404);
		expect((await raw(`/artifacts/${made.id}`)).status).toBe(404);
		// Its port is free for the next app.
		await writeFolder("again", { "pim.app.json": MANIFEST, "server.js": "1" });
		await deploy({ path: "/workspace/again", title: "Again" });
		expect(started.at(-1)).toMatchObject({ port: 18_000 });
		void env;
	});
});
