/**
 * The agent-preview harness (../agent-preview.ts) against fake Playwright
 * objects: no browser, socket, process or network. The only files are
 * temporary ones holding a made-up credential. The credential and cookie
 * here are test strings, not secrets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	AgentPreviewError,
	type BrowserContext,
	type BrowserCookie,
	type BrowserLauncher,
	type BrowserRoute,
	type Clock,
	diagnoseObservations,
	type ExchangeAdapter,
	exactOrigin,
	MAX_REQUESTS,
	MAX_SESSION_MS,
	openAgentPreview,
	readCredentialFile,
} from "../agent-preview.ts";

const ORIGIN = "https://preview.example.test";
const CREDENTIAL = "credential-0123456789abcdef";
const COOKIE_VALUE = "cookie-value-9876543210zyxw";
const T0 = Date.UTC(2026, 9, 29, 12, 0);
const ID = "obs_0123456789abcdef";

const refusal = async (run: () => Promise<unknown> | unknown): Promise<AgentPreviewError> => {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof AgentPreviewError, `expected AgentPreviewError, got ${String(error)}`);
		return error;
	}
	assert.fail("expected a refusal");
};

/** A clock the test moves, with the timers it was asked for. */
class FakeClock implements Clock {
	time = T0;
	timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
	now = () => this.time;
	setTimeout(fn: () => void, ms: number) {
		const timer = { fn, ms, cleared: false };
		this.timers.push(timer);
		return timer;
	}
	clearTimeout(handle: unknown) {
		(handle as { cleared: boolean }).cleared = true;
	}
}

type Call = { kind: string; url: string; method?: string; headers?: Record<string, string>; data?: unknown; options?: unknown };

/** One fake browser: its context has one cookie jar, which the exchange fills and the API and pages need. */
class Fake {
	calls: Call[] = [];
	contexts = 0;
	contextOptions: Record<string, unknown>[] = [];
	closed = { browser: 0, context: 0, page: 0 };
	jar: BrowserCookie[] = [];
	routeHandler: ((route: BrowserRoute) => Promise<void> | void) | undefined;
	postStatus = 200;
	getStatus = 200;
	getBody: unknown = { blocked: null, observations: [] };
	setCookie: BrowserCookie[] = [cookie()];
	pageUrl = `${ORIGIN}/`;
	throwOnGet = false;
	throwOnPost = false;

	launcher: BrowserLauncher = {
		launch: async () => ({
			newContext: async (options) => {
				this.contexts++;
				this.contextOptions.push({ ...options });
				return this.context();
			},
			close: async () => {
				this.closed.browser++;
			},
		}),
	};

	context(): BrowserContext {
		const fake = this;
		return {
			request: {
				async post(url, options) {
					fake.calls.push({ kind: "post", url, headers: options.headers, data: options.data, options });
					if (fake.throwOnPost) throw new Error(`socket failure with ${CREDENTIAL}`);
					if (fake.postStatus === 200) fake.jar = fake.setCookie;
					return { status: () => fake.postStatus, json: async () => ({ ok: fake.postStatus === 200 }) };
				},
				async get(url, options) {
					fake.calls.push({ kind: "get", url, headers: options.headers, options });
					if (fake.throwOnGet) throw new Error("socket failure");
					const status = fake.jar.length === 0 ? 401 : fake.getStatus;
					return { status: () => status, json: async () => fake.getBody };
				},
			},
			cookies: async () => fake.jar,
			route: async (_url, handler) => {
				fake.routeHandler = handler;
			},
			newPage: async () => ({
				goto: async (url) => {
					fake.calls.push({ kind: "goto", url, method: fake.jar.length === 0 ? "no-cookie" : "cookie" });
				},
				url: () => fake.pageUrl,
				title: async () => `Pim ${COOKIE_VALUE}`,
				locator: () => ({ first: () => ({ textContent: async () => "UNSAFE PREVIEW — agent access enabled" }) }),
				close: async () => {
					fake.closed.page++;
				},
			}),
			close: async () => {
				fake.closed.context++;
			},
		};
	}
}

function cookie(overrides: Partial<BrowserCookie> = {}): BrowserCookie {
	return { name: "pim_agent", value: COOKIE_VALUE, domain: "preview.example.test", path: "/", expires: (T0 + 10 * 60_000) / 1000, httpOnly: true, secure: true, ...overrides };
}

const adapter: ExchangeAdapter = {
	path: "/test-exchange",
	request: (credential) => ({ headers: { authorization: `Bearer ${credential}` }, data: { evaluation: "eval-1" } }),
	accept: (status) => (status === 200 ? { expiresAt: T0 + 10 * 60_000 } : null),
};

/** An operator directory (0700) and credential file (0600), as the harness requires. */
const dirs: string[] = [];
function operatorFile(content = `${CREDENTIAL}\n`) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-preview-test-"));
	dirs.push(dir);
	fs.chmodSync(dir, 0o700);
	const file = path.join(dir, "credential");
	fs.writeFileSync(file, content, { mode: 0o600 });
	fs.chmodSync(file, 0o600);
	return { dir, file };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function open(fake = new Fake(), clock = new FakeClock(), overrides: { deadline?: number; origin?: string; adapter?: ExchangeAdapter } = {}) {
	const { file } = operatorFile();
	const session = await openAgentPreview({ origin: overrides.origin ?? ORIGIN, credentialFile: file, adapter: overrides.adapter ?? adapter, deadline: overrides.deadline ?? T0 + 3_600_000, launcher: fake.launcher, clock });
	return { fake, clock, session };
}

describe("one context for the exchange, the API and the UI", () => {
	it("exchanges once with the context's own request, and the same jar serves the API and a page", async () => {
		const { fake, session } = await open();
		const report = await session.observations();
		await session.inspectPage("/");
		assert.equal(report.status, 200);
		assert.equal(fake.contexts, 1);
		assert.deepEqual(
			fake.calls.map((call) => call.kind),
			["post", "get", "goto"],
		);
		// The GET succeeded only because the POST's cookie was in the shared jar; the page loaded with it too.
		assert.equal(fake.calls[2]?.method, "cookie");
		assert.equal(fake.calls.filter((call) => call.kind === "post").length, 1);
	});

	it("puts the credential only in the exchange's POST body or headers, never a URL, and names the origin", async () => {
		const { fake, session } = await open();
		await diagnoseObservations(session);
		for (const call of fake.calls) assert.equal(call.url.includes(CREDENTIAL), false);
		const post = fake.calls[0]!;
		assert.equal(post.url, `${ORIGIN}/test-exchange`);
		assert.equal(post.headers?.origin, ORIGIN);
		assert.deepEqual(post.options, { headers: post.headers, data: post.data, maxRedirects: 0, failOnStatusCode: false, timeout: 15_000 });
		// After the exchange, requests carry no authorization header at all (the observation routes refuse one).
		for (const call of fake.calls.slice(1)) assert.equal(call.headers?.authorization, undefined);
	});

	it("makes a new, private context with no saved state, profile, downloads, service workers, video or trace", async () => {
		const { fake, session } = await open();
		assert.deepEqual(fake.contextOptions, [{ acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false, bypassCSP: false, javaScriptEnabled: true, permissions: [], baseURL: ORIGIN }]);
		for (const forbidden of ["storageState", "recordHar", "recordVideo", "userDataDir", "extraHTTPHeaders"]) assert.equal(forbidden in fake.contextOptions[0]!, false);
		for (const method of ["storageState", "cookies", "context", "post"]) assert.equal(method in session, false);
		await session.close();
	});
});

describe("origin", () => {
	it("accepts exactly an https origin", () => {
		assert.equal(exactOrigin(ORIGIN), ORIGIN);
		for (const bad of ["http://preview.example.test", `${ORIGIN}/`, `${ORIGIN}/path`, `${ORIGIN}?x=1`, "https://user:pw@preview.example.test", "preview.example.test", "https://PREVIEW.example.test"]) {
			assert.throws(() => exactOrigin(bad), AgentPreviewError, bad);
		}
	});

	it("makes nothing for a wrong origin", async () => {
		const fake = new Fake();
		const error = await refusal(() => open(fake, new FakeClock(), { origin: "http://preview.example.test" }));
		assert.equal(error.code, "origin");
		assert.equal(fake.contexts, 0);
	});

	it("aborts a browser request to another origin, and any write from a page", async () => {
		const { fake } = await open();
		const outcomes: string[] = [];
		const attempt = async (url: string, method: string) => {
			await fake.routeHandler!({ request: () => ({ url: () => url, method: () => method }), abort: async () => void outcomes.push("abort"), continue: async () => void outcomes.push("continue") });
		};
		await attempt(`${ORIGIN}/app.js`, "GET");
		await attempt("https://elsewhere.example.test/x", "GET");
		await attempt("https://preview.example.test.evil.test/", "GET");
		await attempt(`${ORIGIN}/api/observations`, "POST");
		assert.deepEqual(outcomes, ["continue", "abort", "abort", "abort"]);
	});

	it("closes a session whose page ends on another origin", async () => {
		const { fake, session } = await open();
		fake.pageUrl = "https://elsewhere.example.test/";
		assert.equal((await refusal(() => session.inspectPage("/"))).code, "redirect");
		assert.equal(fake.closed.context, 1);
	});

	it("treats a redirect from the API as an error, closes, and doesn't follow it", async () => {
		const { fake, session } = await open();
		fake.getStatus = 302;
		const error = await refusal(() => session.observations());
		assert.equal(error.code, "redirect");
		assert.equal(fake.closed.context, 1);
		assert.equal((fake.calls.at(-1)?.options as { maxRedirects: number }).maxRedirects, 0);
	});
});

describe("the credential file", () => {
	it("reads a 0600 file in a 0700 directory, without its line end", () => {
		assert.equal(readCredentialFile(operatorFile().file), CREDENTIAL);
	});

	it("refuses loose modes, a loose directory, a link, a hard link, other content and relative paths, without saying the path", () => {
		const wrongFile = operatorFile();
		fs.chmodSync(wrongFile.file, 0o640);
		const wrongDir = operatorFile();
		fs.chmodSync(wrongDir.dir, 0o750);
		const linked = operatorFile();
		fs.symlinkSync(linked.file, path.join(linked.dir, "link"));
		const hard = operatorFile();
		fs.linkSync(hard.file, path.join(hard.dir, "second"));
		const spaced = operatorFile("two words here that are long enough");
		const short = operatorFile("short");
		const empty = operatorFile("");
		const cases: [string, string][] = [
			[wrongFile.file, "mode"],
			[wrongDir.file, "0700"],
			[path.join(linked.dir, "link"), "link"],
			[hard.file, "one link"],
			[spaced.file, "printable"],
			[short.file, "printable"],
			[empty.file, "size"],
			["relative/token.txt", "absolute"],
			[`${os.tmpdir()}/nope/../x/token.txt`, "normalized"],
			[path.join(os.tmpdir(), "agent-preview-missing-dir", "token.txt"), "directory"],
		];
		for (const [file, why] of cases) {
			assert.throws(
				() => readCredentialFile(file),
				(error: unknown) => error instanceof AgentPreviewError && error.code === "credential-file" && error.message.includes(why) && !error.message.includes(file),
				`${file}: ${why}`,
			);
		}
	});

	it("launches no browser when the file is refused", async () => {
		const fake = new Fake();
		const { file } = operatorFile();
		fs.chmodSync(file, 0o644);
		await refusal(() => openAgentPreview({ origin: ORIGIN, credentialFile: file, adapter, deadline: T0 + 1e6, launcher: fake.launcher, clock: new FakeClock() }));
		assert.equal(fake.contexts, 0);
	});
});

describe("redaction", () => {
	it("keeps the credential and cookie out of metadata, reports and failures", async () => {
		const { session } = await open();
		const shown = JSON.stringify([session.metadata(), await session.inspectPage("/"), session.redact(`x ${CREDENTIAL} y ${COOKIE_VALUE}`)]);
		assert.equal(shown.includes(CREDENTIAL), false);
		assert.equal(shown.includes(COOKIE_VALUE), false);
		assert.ok(shown.includes("[redacted]"));
		assert.deepEqual(Object.keys(session.metadata()).sort(), ["expiresAt", "origin", "requestsLeft"]);
	});

	it("never repeats what a failing transport threw, or a response body", async () => {
		const fake = new Fake();
		fake.throwOnPost = true;
		const error = await refusal(() => open(fake));
		assert.equal(error.code, "network");
		assert.equal(`${error.message}${error.stack?.split("\n")[0]}`.includes(CREDENTIAL), false);
		assert.equal(error.cause, undefined);
	});

	it("reports observations without the host's launch identity, and caps free text", async () => {
		const { fake, session } = await open();
		fake.getBody = { blocked: `bad ${COOKIE_VALUE}`, observations: [{ observationId: ID, status: "unconfirmed", notAfter: 5, hostLaunchId: "launch-secret-id", hostGeneration: "g", evidence: "free text", conflicting: true }] };
		const report = await session.observations();
		assert.deepEqual(report.records, [{ observationId: ID, status: "unconfirmed", notAfter: 5, conflicting: true, hasHostLaunch: true }]);
		assert.equal(report.blocked, "bad [redacted]");
		assert.equal(JSON.stringify(report).includes("launch-secret-id"), false);
	});
});

describe("bounded lifecycle and no retry", () => {
	it("makes one exchange and stops when it is refused", async () => {
		const fake = new Fake();
		fake.postStatus = 401;
		const error = await refusal(() => open(fake));
		assert.equal(error.code, "exchange-refused");
		assert.equal(error.status, 401);
		assert.equal(fake.calls.length, 1);
		assert.deepEqual(fake.closed, { browser: 1, context: 1, page: 0 });
	});

	it("closes the session at its first refused API request, and makes no second request", async () => {
		const { fake, session } = await open();
		fake.getStatus = 403;
		assert.equal((await refusal(() => session.observations())).code, "auth-refused");
		assert.equal((await refusal(() => session.observations())).code, "closed");
		assert.equal(fake.calls.filter((call) => call.kind === "get").length, 1);
		assert.deepEqual(fake.closed, { browser: 1, context: 1, page: 0 });
	});

	it("closes on a network failure without retrying", async () => {
		const { fake, session } = await open();
		fake.throwOnGet = true;
		assert.equal((await refusal(() => session.observations())).code, "network");
		assert.equal(fake.calls.filter((call) => call.kind === "get").length, 1);
		assert.equal(fake.closed.context, 1);
	});

	it("refuses a session end past 30 minutes, past the deadline, or already over, and closes", async () => {
		for (const [expiresAt, deadline] of [
			[T0 + MAX_SESSION_MS + 1, T0 + 1e9],
			[T0 + 10 * 60_000, T0 + 5 * 60_000],
			[T0, T0 + 1e9],
			[Number.NaN, T0 + 1e9],
		] as const) {
			const fake = new Fake();
			const error = await refusal(() => open(fake, new FakeClock(), { deadline, adapter: { ...adapter, accept: () => ({ expiresAt }) } }));
			assert.equal(error.code, "lifetime");
			assert.deepEqual(fake.closed, { browser: 1, context: 1, page: 0 });
		}
		// The edge itself is allowed.
		const edge = await open(new Fake(), new FakeClock(), { deadline: T0 + MAX_SESSION_MS, adapter: { ...adapter, accept: () => ({ expiresAt: T0 + MAX_SESSION_MS }) } });
		assert.equal(edge.session.metadata().expiresAt, new Date(T0 + MAX_SESSION_MS).toISOString());
	});

	it("refuses cookies that aren't Secure HttpOnly for exactly the origin, or outlast the session", async () => {
		for (const bad of [cookie({ secure: false }), cookie({ httpOnly: false }), cookie({ domain: ".preview.example.test" }), cookie({ domain: "other.example.test" }), cookie({ expires: (T0 + 3_600_000) / 1000 })]) {
			const fake = new Fake();
			fake.setCookie = [bad];
			assert.equal((await refusal(() => open(fake))).code, "cookie");
			assert.equal(fake.closed.context, 1);
		}
		const none = new Fake();
		none.setCookie = [];
		assert.equal((await refusal(() => open(none))).code, "cookie");
	});

	it("closes by timer at the session's end, and then refuses every call", async () => {
		const { fake, clock, session } = await open();
		const timer = clock.timers[0]!;
		assert.equal(timer.ms, 10 * 60_000);
		clock.time = T0 + 10 * 60_000;
		timer.fn();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(fake.closed, { browser: 1, context: 1, page: 0 });
		assert.equal(timer.cleared, true);
		assert.equal((await refusal(() => session.observations())).code, "closed");
		await session.close();
		assert.equal(fake.closed.context, 1);
	});

	it("refuses a call after the end even before the timer runs, and caps requests", async () => {
		const first = await open();
		first.clock.time = T0 + 10 * 60_000;
		assert.equal((await refusal(() => first.session.observations())).code, "expired");
		const second = await open();
		for (let i = 0; i < MAX_REQUESTS; i++) await second.session.observations();
		assert.equal((await refusal(() => second.session.observations())).code, "limit");
		assert.equal(second.fake.calls.filter((call) => call.kind === "get").length, MAX_REQUESTS);
	});
});

describe("read only first use", () => {
	it("diagnoses with one GET /api/observations and one page of /, and closes", async () => {
		const { fake, session } = await open();
		fake.getBody = { blocked: null, observations: [{ observationId: ID, status: "unconfirmed", notAfter: 1 }] };
		const result = await diagnoseObservations(session);
		assert.deepEqual(
			fake.calls.map((call) => [call.kind, call.url]),
			[
				["post", `${ORIGIN}/test-exchange`],
				["get", `${ORIGIN}/api/observations`],
				["goto", `${ORIGIN}/`],
			],
		);
		assert.equal(result.observations.records[0]?.status, "unconfirmed");
		assert.equal(result.ui.banner, "UNSAFE PREVIEW — agent access enabled");
		assert.equal(result.ui.title.includes(COOKIE_VALUE), false);
		assert.deepEqual(fake.closed, { browser: 1, context: 1, page: 1 });
	});

	it("closes the session even when the diagnosis fails", async () => {
		const { fake, session } = await open();
		fake.getStatus = 500;
		assert.equal((await refusal(() => diagnoseObservations(session))).code, "status");
		assert.equal(fake.closed.context, 1);
	});

	it("reads only the observation routes: no end, no query, no other path, no write method", async () => {
		const { fake, session } = await open();
		const reach = (id: string) => session.observation(id);
		for (const bad of [`${ID}/end`, `${ID}?x=1`, "short", "../x", `${ID}/`]) {
			assert.equal((await refusal(() => reach(bad))).code, "path", bad);
		}
		for (const bad of ["//elsewhere.example.test/", "/../x", "/a?b=1", "/a#b", "https://elsewhere.example.test/", "no-slash"]) {
			assert.equal((await refusal(() => session.inspectPage(bad))).code, "path", bad);
		}
		assert.deepEqual(
			fake.calls.map((call) => call.kind),
			["post"],
		);
		for (const method of ["watch", "end", "launch", "post", "enroll", "setup", "put", "delete"]) assert.equal(method in session, false);
		await session.observation(ID);
		assert.equal(fake.calls.at(-1)?.url, `${ORIGIN}/api/observations/${ID}`);
	});

	it("refuses an exchange path with a query or another origin", async () => {
		for (const bad of ["/x?token=1", "//elsewhere.example.test/x", "https://elsewhere.example.test/x", "x"]) {
			const fake = new Fake();
			const error = await refusal(() => open(fake, new FakeClock(), { adapter: { ...adapter, path: bad } }));
			assert.equal(error.code, "adapter", bad);
			assert.equal(fake.contexts, 0);
		}
	});
});
