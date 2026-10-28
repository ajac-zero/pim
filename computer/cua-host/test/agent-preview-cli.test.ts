/** The diagnosis entry point (../agent-preview-cli.ts) with a fake launcher and fake adapter: no browser or network. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { Browser, BrowserCookie, BrowserLauncher } from "../agent-preview.ts";
import { run, USAGE } from "../agent-preview-cli.ts";

const ORIGIN = "https://preview.example.test";
const CREDENTIAL = "cli-credential-0123456789abcdef-_ABCDEFGXYZ";
const OWNER = "o_87r9p7fs0qkbs5e5q0qzetztdn";
const COOKIE = "cli-cookie-value-9876543210";
const ID = "5b0b3f0e-9f0d-4c61-8c0e-2f0e8f6a1c11";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-preview-cli-"));
fs.chmodSync(dir, 0o700);
const file = path.join(dir, "automation.json");
fs.writeFileSync(file, JSON.stringify({ version: 1, origin: ORIGIN, owner: OWNER, evaluation: "cua-eval-test", deployment: "cua-eval@cloudflare", credential: CREDENTIAL }), { mode: 0o600 });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fake(status = 200) {
	const calls: string[] = [];
	let jar: BrowserCookie[] = [];
	const browser: Browser = {
		newContext: async () => ({
			request: {
				post: async (url, options) => {
					calls.push(`post ${url} ${options.headers?.authorization?.split(" ")[0]} ${JSON.stringify(options.data)}`);
					jar = [{ name: "__Host-pim-automation", value: COOKIE, domain: "preview.example.test", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Strict" }];
					const session = { kind: "automation", access: "read-only", owner: OWNER, evaluation: "cua-eval-test", deployment: "cua-eval@cloudflare", origin: ORIGIN, expiresAt: new Date(Date.now() + 600_000).toISOString() };
					return { status: () => 201, json: async () => ({ mode: "enabled", session }) };
				},
				get: async (url) => {
					calls.push(`get ${url}`);
					return { status: () => (jar.length ? status : 401), json: async () => ({ blocked: null, observations: [{ id: ID, status: "unconfirmed", notAfter: 1, evidence: "the host's answer to launch was lost (timeout)" }] }) };
				},
			},
			cookies: async () => jar,
			route: async () => {},
			routeWebSocket: async () => {},
			newPage: async () => ({ goto: async (url) => void calls.push(`goto ${url}`), url: () => `${ORIGIN}/`, title: async () => "Pim", locator: () => ({ first: () => ({ textContent: async () => "UNSAFE PREVIEW — agent access enabled" }) }), close: async () => {} }),
			close: async () => {},
		}),
		close: async () => {},
	};
	const launcher: BrowserLauncher = { launch: async () => browser };
	return { calls, launcher };
}
const args = (extra: string[] = []) => ["--origin", ORIGIN, "--config-file", file, "--deadline", new Date(Date.now() + 3_600_000).toISOString(), "--playwright-dir", "/unused", ...extra];
const capture = () => {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, streams: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) } };
};

describe("agent-preview-cli", () => {
	it("prints one metadata line for the read-only diagnosis, with nothing secret", async () => {
		const f = fake();
		const c = capture();
		assert.equal(await run(args(), c.streams, f.launcher), 0);
		assert.deepEqual(f.calls, [`post ${ORIGIN}/auth/automation/session Pim-Automation ${JSON.stringify({ owner: OWNER, evaluation: "cua-eval-test", deployment: "cua-eval@cloudflare" })}`, `get ${ORIGIN}/api/observations`, `goto ${ORIGIN}/`]);
		assert.equal(c.out.length, 1);
		const line = JSON.parse(c.out[0]!);
		assert.equal(line.event, "agent-preview.diagnosis");
		assert.equal(line.observations.observations[0].lostReason, "timeout");
		assert.equal(line.ui.banner, "UNSAFE PREVIEW — agent access enabled");
		for (const secret of [CREDENTIAL, COOKIE, file]) assert.equal(c.out.join("").includes(secret), false);
		assert.deepEqual(c.err, []);
	});

	it("takes no secret as an argument and refuses unknown or missing ones", async () => {
		for (const bad of [["--token", "x"], ["--origin", ORIGIN], [], args().map((a, i) => (i === 5 ? "2000-01-01T00:00:00Z" : a)), args().map((a, i) => (i === 5 ? "yesterday" : a))]) {
			const f = fake();
			const c = capture();
			assert.equal(await run(bad, c.streams, f.launcher), 2);
			assert.deepEqual(c.err, [USAGE]);
			assert.deepEqual(f.calls, []);
		}
	});

	it("stops with one redacted failure line and no retry when the API refuses the session", async () => {
		const f = fake(403);
		const c = capture();
		assert.equal(await run(args(), c.streams, f.launcher), 1);
		assert.equal(f.calls.filter((call) => call.startsWith("get")).length, 1);
		assert.equal(JSON.parse(c.err[0]!).code, "auth-refused");
		assert.deepEqual(c.out, []);
		for (const secret of [CREDENTIAL, COOKIE, file]) assert.equal(c.err.join("").includes(secret), false);
	});

	it("refuses a configuration file for another origin, before any browser", async () => {
		const f = fake();
		const c = capture();
		assert.equal(await run(args().map((a) => (a === ORIGIN ? "https://other.example.test" : a)), c.streams, f.launcher), 1);
		assert.equal(JSON.parse(c.err[0]!).code, "config");
		assert.deepEqual(f.calls, []);
	});

	it("reports a bad origin without echoing it", async () => {
		const c = capture();
		assert.equal(await run(args().map((a) => (a === ORIGIN ? "http://secret-host.test" : a)), c.streams, fake().launcher), 1);
		assert.equal(JSON.parse(c.err[0]!).code, "config");
		assert.equal(c.err.join("").includes("secret-host"), false);
	});
});
