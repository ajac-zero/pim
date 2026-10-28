/** The diagnosis entry point (../agent-preview-cli.ts) with a fake launcher and fake adapter: no browser or network. */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { Browser, BrowserCookie, BrowserLauncher, ExchangeAdapter } from "../agent-preview.ts";
import { run, USAGE } from "../agent-preview-cli.ts";

const ORIGIN = "https://preview.example.test";
const CREDENTIAL = "cli-credential-0123456789abcdef";
const COOKIE = "cli-cookie-value-9876543210";
const ID = "5b0b3f0e-9f0d-4c61-8c0e-2f0e8f6a1c11";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-preview-cli-"));
fs.chmodSync(dir, 0o700);
const file = path.join(dir, "credential");
fs.writeFileSync(file, CREDENTIAL, { mode: 0o600 });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function fake(status = 200) {
	const calls: string[] = [];
	let jar: BrowserCookie[] = [];
	const browser: Browser = {
		newContext: async () => ({
			request: {
				post: async (url) => {
					calls.push(`post ${url}`);
					jar = [{ name: "s", value: COOKIE, domain: "preview.example.test", path: "/", expires: -1, httpOnly: true, secure: true }];
					return { status: () => 200, json: async () => ({}) };
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
const adapter: ExchangeAdapter = { path: "/x", request: (c) => ({ headers: { authorization: `Bearer ${c}` } }), accept: (s) => (s === 200 ? { expiresAt: Date.now() + 600_000 } : null) };
const args = (extra: string[] = []) => ["--origin", ORIGIN, "--credential-file", file, "--deadline", new Date(Date.now() + 3_600_000).toISOString(), "--playwright-dir", "/unused", ...extra];
const capture = () => {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, streams: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) } };
};

describe("agent-preview-cli", () => {
	it("prints one metadata line for the read-only diagnosis, with nothing secret", async () => {
		const f = fake();
		const c = capture();
		assert.equal(await run(args(), adapter, c.streams, f.launcher), 0);
		assert.deepEqual(f.calls, [`post ${ORIGIN}/x`, `get ${ORIGIN}/api/observations`, `goto ${ORIGIN}/`]);
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
			assert.equal(await run(bad, adapter, c.streams, f.launcher), 2);
			assert.deepEqual(c.err, [USAGE]);
			assert.deepEqual(f.calls, []);
		}
	});

	it("stops with one redacted failure line and no retry when the API refuses the session", async () => {
		const f = fake(403);
		const c = capture();
		assert.equal(await run(args(), adapter, c.streams, f.launcher), 1);
		assert.equal(f.calls.filter((call) => call.startsWith("get")).length, 1);
		assert.equal(JSON.parse(c.err[0]!).code, "auth-refused");
		assert.deepEqual(c.out, []);
		for (const secret of [CREDENTIAL, COOKIE, file]) assert.equal(c.err.join("").includes(secret), false);
	});

	it("reports a bad origin without echoing it", async () => {
		const c = capture();
		assert.equal(await run(args().map((a) => (a === ORIGIN ? "http://secret-host.test" : a)), adapter, c.streams, fake().launcher), 1);
		assert.equal(JSON.parse(c.err[0]!).code, "origin");
		assert.equal(c.err.join("").includes("secret-host"), false);
	});
});
