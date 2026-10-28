/**
 * The one-use launch evaluator (../launch-evaluator.ts, ../launch-evaluator-cli.ts)
 * against fake Playwright objects: no browser, socket, process or network. The
 * page, context and browser it gets are proxies that throw on any member the
 * harness isn't meant to use (input, clipboard, files, permissions, storage
 * state, CDP), so a use of one fails the test that made it. The credential,
 * run token, ticket and attach token here are test strings, not secrets.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { AgentPreviewError, PLAYWRIGHT_VERSION } from "../agent-preview.ts";
import { run, USAGE } from "../launch-evaluator-cli.ts";
import {
	CONTEXT_OPTIONS,
	END_PATH,
	EVALUATOR_SCHEME,
	type EvaluateOptions,
	type EvaluationReport,
	type EvaluatorBrowser,
	type EvaluatorContext,
	type EvaluatorLauncher,
	type EvaluatorPage,
	type EvaluatorRoute,
	evaluateLaunch,
	evaluatorChromium,
	HARDENING,
	LAUNCH_PATH,
	MAX_MEDIA_SOCKETS,
	mayGoUp,
	OneUseRun,
	type PageSocket,
	parseEvaluatorConfig,
	RUN_HEADER,
	type SocketMessage,
	viewerAddress,
	viewerMayRequest,
	viewerMaySocket,
} from "../launch-evaluator.ts";

const ORIGIN = "https://pim-eval.example.test";
const VIEWER = "https://bridge-eval.example.test";
const OWNER = "o_87r9p7fs0qkbs5e5q0qzetztdn";
const EVALUATION = "cua-eval-test";
const DEPLOYMENT = "cua-eval@cloudflare";
const CREDENTIAL = "evaluator-credential-".padEnd(43, "C");
const RUN = "evaluator-run-token-".padEnd(43, "R");
const TICKET = "viewer-ticket-".padEnd(43, "T");
const ATTACH = "attach-token-".padEnd(43, "A");
const LAUNCH = "L".repeat(11) + "x".repeat(11);
const OTHER_LAUNCH = "M".repeat(22);
/** The fresh observation the launch creates, and an older one the evaluator must never name. */
const ID = "5b0b3f0e-9f0d-4c61-8c0e-2f0e8f6a1c11";
const OLD_ID = "attempted-watch-0001-unresolved";
const VIEWER_URL = `${VIEWER}/${LAUNCH}/viewer/#ticket=${TICKET}&clipboard=0`;
const MEDIA = `wss://bridge-eval.example.test/${LAUNCH}/media?ticket=${ATTACH}`;
const SECRETS = [CREDENTIAL, RUN, TICKET, ATTACH, VIEWER_URL];

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** The operator's input, as scripts/preview-launch-evaluator-grant.mjs writes it, in a 0700 directory. */
function configFile(fields: Record<string, unknown> = {}): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-evaluator-"));
	dirs.push(dir);
	fs.chmodSync(dir, 0o700);
	const file = path.join(dir, "evaluator.json");
	fs.writeFileSync(file, JSON.stringify({ version: 1, kind: "launch-evaluator", origin: ORIGIN, viewerOrigin: VIEWER, owner: OWNER, evaluation: EVALUATION, deployment: DEPLOYMENT, credential: CREDENTIAL, ...fields }), { mode: 0o600 });
	return file;
}

/** Throws unless `object` is only ever asked for `allowed` (and `then`, which `await` reads). */
function strict<T extends object>(name: string, object: T, allowed: string[]): T {
	return new Proxy(object, {
		get(target, key, receiver) {
			if (key === "then") return undefined;
			if (typeof key !== "string" || !allowed.includes(key)) throw new Error(`the harness used ${name}.${String(key)}`);
			return Reflect.get(target, key, receiver);
		},
	});
}

type Answer = { status: number; body: unknown } | "throw";
const openAnswer = (overrides: Record<string, unknown> = {}, now = Date.now()): Answer => ({
	status: 201,
	body: { run: { phase: "open", classification: "certain_open", deadline: new Date(now + 10 * 60_000).toISOString(), observation: { id: ID, status: "open", notAfter: now + 10 * 60_000 } }, viewer: VIEWER_URL, runToken: RUN, ...overrides },
});
const endAnswer: Answer = { status: 202, body: { run: { phase: "ended", observation: { id: ID, status: "revoking" } } } };

/** One page WebSocket as the context's route gets it, and its server side if connected. */
class Socket {
	closed: number | null = null;
	serverClosed: number | null = null;
	connected = false;
	up: SocketMessage[] = [];
	down: SocketMessage[] = [];
	#fromPage: ((message: SocketMessage) => void) | undefined;
	#fromServer: ((message: SocketMessage) => void) | undefined;
	readonly ws: PageSocket;
	constructor(url: string) {
		this.ws = strict("socket", {
			url: () => url,
			connectToServer: () => {
				this.connected = true;
				return strict("server", { onMessage: (handler: (m: SocketMessage) => void) => void (this.#fromServer = handler), send: (m: SocketMessage) => void this.up.push(m), close: (o?: { code?: number }) => void (this.serverClosed = o?.code ?? 1000) }, ["onMessage", "send", "close"]);
			},
			onMessage: (handler: (m: SocketMessage) => void) => void (this.#fromPage = handler),
			send: (m: SocketMessage) => void this.down.push(m),
			close: (o?: { code?: number }) => void (this.closed = o?.code ?? 1000),
		}, ["url", "connectToServer", "onMessage", "send", "close"]);
	}
	fromServer(message: SocketMessage) {
		this.#fromServer?.(message);
	}
	fromPage(message: SocketMessage) {
		this.#fromPage?.(message);
	}
}

const hello = JSON.stringify({ type: "hello", payload: { version: 2 } });
const opened = (policy = "view_only") => JSON.stringify({ type: "session_opened", payload: { session_id: "media-1", policy, geometry_control: "observe_only", target: { kind: "display", display_id: "0" } } });
const ack = JSON.stringify({ type: "frame_ack", payload: { session_id: "media-1", sequence: 1, decode_queue: 0 } });

/** What a page does once the harness loads it: its requests, judged by the context's route, and its sockets. */
type PageScript = (page: { request(url: string, method?: string): Promise<"continue" | "abort">; socket(url: string): Promise<Socket> }) => Promise<void>;

/** The viewer as it works: its files and calls, one media socket that opens view only and sends a frame, and the page's acknowledgement. */
const viewerWorks: PageScript = async (page) => {
	await page.request(`${VIEWER}/${LAUNCH}/viewer/`);
	await page.request(`${VIEWER}/${LAUNCH}/viewer/viewer.js`);
	await page.request(`${VIEWER}/${LAUNCH}/cua.env.v1.StreamService/OpenMedia`, "POST");
	const media = await page.socket(MEDIA);
	media.fromServer(hello);
	media.fromServer(opened());
	media.fromServer(new Uint8Array([1, 2, 3]));
	media.fromPage(ack);
};

class Fake {
	/** Everything, in order: what was launched, installed, requested and closed. */
	events: string[] = [];
	posts: { url: string; headers: Record<string, string>; data: unknown; options: Record<string, unknown> }[] = [];
	contextOptions: unknown[] = [];
	initScripts: string[] = [];
	sockets: Socket[] = [];
	requests: { url: string; method: string; verdict: string }[] = [];
	closed = { browser: 0, context: 0, page: 0 };
	launchAnswer: Answer = openAnswer();
	endAnswer: Answer = endAnswer;
	page: PageScript = viewerWorks;
	pageUrl = `${VIEWER}/${LAUNCH}/viewer/`;
	gotoThrows = false;
	cookies: unknown[] = [];
	launchThrows = false;
	onGoto: () => void = () => undefined;
	#route: ((route: EvaluatorRoute) => Promise<void> | void) | undefined;
	#socket: ((ws: PageSocket) => Promise<void> | void) | undefined;

	launcher: EvaluatorLauncher = {
		launch: async () => {
			this.events.push("launch");
			if (this.launchThrows) throw new Error(`spawn /opt/google/chrome/chrome ENOENT ${CREDENTIAL}`);
			return this.browser();
		},
	};

	browser(): EvaluatorBrowser {
		return strict("browser", {
			newContext: async (options: unknown) => {
				this.events.push("newContext");
				this.contextOptions.push(options);
				return this.context();
			},
			close: async () => void this.closed.browser++,
		}, ["newContext", "close"]);
	}

	answer(answer: Answer) {
		if (answer === "throw") throw new Error(`socket hang up ${CREDENTIAL} ${RUN}`);
		return { status: () => answer.status, json: async () => structuredClone(answer.body) };
	}

	context(): EvaluatorContext {
		const fake = this;
		const request = strict("request", {
			async post(url: string, options: { headers: Record<string, string>; data: unknown }) {
				const { pathname } = new URL(url);
				fake.events.push(`post ${pathname}`);
				fake.posts.push({ url, headers: options.headers, data: options.data, options: options as unknown as Record<string, unknown> });
				return fake.answer(pathname === LAUNCH_PATH ? fake.launchAnswer : fake.endAnswer);
			},
		}, ["post"]);
		return strict("context", {
			request,
			cookies: async () => fake.cookies,
			addInitScript: async (script: { content: string }) => {
				fake.events.push("addInitScript");
				fake.initScripts.push(script.content);
			},
			route: async (url: string, handler: (route: EvaluatorRoute) => Promise<void>) => {
				fake.events.push(`route ${url}`);
				fake.#route = handler;
			},
			routeWebSocket: async (url: RegExp, handler: (ws: PageSocket) => Promise<void>) => {
				fake.events.push(`routeWebSocket ${url}`);
				fake.#socket = handler;
			},
			newPage: async () => {
				fake.events.push("newPage");
				return fake.newPage();
			},
			close: async () => void fake.closed.context++,
		}, ["request", "cookies", "addInitScript", "route", "routeWebSocket", "newPage", "close"]);
	}

	newPage(): EvaluatorPage {
		const fake = this;
		const helpers = {
			async request(url: string, method = "GET") {
				let verdict: "continue" | "abort" = "abort";
				await fake.#route!(strict("route", { request: () => ({ url: () => url, method: () => method }), continue: async () => void (verdict = "continue"), abort: async () => void (verdict = "abort") }, ["request", "continue", "abort"]));
				fake.requests.push({ url, method, verdict });
				return verdict;
			},
			async socket(url: string) {
				const socket = new Socket(url);
				fake.sockets.push(socket);
				await fake.#socket!(socket.ws);
				return socket;
			},
		};
		return strict("page", {
			goto: async (url: string) => {
				fake.events.push(url === VIEWER_URL ? "goto viewer" : "goto other");
				fake.onGoto();
				if (fake.gotoThrows) throw new Error(`net::ERR_FAILED at ${url}`);
				await fake.page(helpers);
			},
			url: () => fake.pageUrl,
			close: async () => void fake.closed.page++,
		}, ["goto", "url", "close"]);
	}

	/** A socket or request the page makes after the viewer step, as a page left open would. */
	late = () => this.newPage();
}

const evaluate = (fake: Fake, options: Partial<EvaluateOptions> = {}) =>
	evaluateLaunch({ configFile: configFile(), origin: ORIGIN, viewerOrigin: VIEWER, deadline: Date.now() + 60 * 60_000, launcher: fake.launcher, observeMs: 40, ...options });

const refusal = async (run: () => Promise<unknown>): Promise<AgentPreviewError> => {
	try {
		await run();
	} catch (error) {
		assert.ok(error instanceof AgentPreviewError, `expected AgentPreviewError, got ${String(error)}`);
		return error;
	}
	assert.fail("expected a refusal");
};

const posted = (fake: Fake) => fake.posts.map((post) => new URL(post.url).pathname);
const assertNoSecrets = (text: string) => {
	for (const secret of SECRETS) assert.equal(text.includes(secret), false, "a secret reached the output");
};
const assertClosedOnce = (fake: Fake) => assert.deepEqual([fake.closed.context, fake.closed.browser], [1, 1]);

describe("the evaluator's input", () => {
	it("reads exactly its own file, and refuses an automation runner's, another kind, extra fields and a viewer on Pim's host", () => {
		const text = (fields: Record<string, unknown> = {}) => JSON.stringify({ version: 1, kind: "launch-evaluator", origin: ORIGIN, viewerOrigin: VIEWER, owner: OWNER, evaluation: EVALUATION, deployment: DEPLOYMENT, credential: CREDENTIAL, ...fields });
		assert.deepEqual(parseEvaluatorConfig(text()), { origin: ORIGIN, viewerOrigin: VIEWER, owner: OWNER, evaluation: EVALUATION, deployment: DEPLOYMENT, credential: CREDENTIAL });
		const automation = JSON.stringify({ version: 1, origin: ORIGIN, owner: OWNER, evaluation: EVALUATION, deployment: DEPLOYMENT, credential: CREDENTIAL });
		for (const bad of [
			automation,
			text({ kind: "automation" }),
			text({ kind: undefined }),
			text({ observation: OLD_ID }),
			text({ viewerOrigin: "https://pim-eval.example.test:8443" }),
			text({ viewerOrigin: "http://bridge-eval.example.test" }),
			text({ viewerOrigin: `${VIEWER}/` }),
			text({ credential: CREDENTIAL.slice(1) }),
			text({ version: 2 }),
			"not json",
		]) {
			const error = (() => {
				try {
					parseEvaluatorConfig(bad);
				} catch (thrown) {
					return thrown as AgentPreviewError;
				}
				assert.fail("expected a refusal");
			})();
			assert.equal(error.code, "config");
			assert.equal(error.message.includes(CREDENTIAL), false);
		}
	});
});

describe("the one-use order", () => {
	it("launches once, ends once and only after a launch that opened, and never after it stopped", () => {
		const fresh = new OneUseRun();
		assert.throws(() => fresh.end(), /certainly opened/);
		fresh.launch();
		assert.throws(() => fresh.launch(), /launches once/);
		assert.throws(() => fresh.end(), /certainly opened/);
		fresh.launched();
		fresh.end();
		assert.throws(() => fresh.end(), /only once/);
		assert.throws(() => fresh.launch(), /launches once/);
		const uncertain = new OneUseRun();
		uncertain.launch();
		uncertain.stop();
		assert.throws(() => uncertain.end(), /certainly opened/);
		assert.throws(() => uncertain.launched(), /in progress/);
		assert.throws(() => uncertain.launch(), /launches once/);
	});
});

describe("a qualified run", () => {
	it("launches once, loads only the new launch's viewer, ends that same observation once, and closes", async () => {
		const fake = new Fake();
		const report = await evaluate(fake);
		assert.deepEqual(report, {
			outcome: "qualified",
			launch: { status: 201, phase: "open", classification: "certain_open", observation: { id: ID, notAfter: (report.launch.observation as { notAfter: number }).notAfter }, deadline: report.launch.deadline },
			viewer: { loaded: true, failure: null, mediaSockets: 1, sessionOpened: true, viewOnly: true, packets: 1, refusedRequests: 0, refusedSockets: 0, refusedMessages: 0 },
			end: { sent: true, status: 202, phase: "ended", observationStatus: "revoking" },
		});
		// Everything is installed before the launch, the launch comes before the page, and the End after it.
		assert.deepEqual(fake.events, ["launch", "newContext", "addInitScript", "routeWebSocket /.*/", "route **/*", `post ${LAUNCH_PATH}`, "newPage", "goto viewer", `post ${END_PATH}`]);
		assert.deepEqual(fake.contextOptions, [CONTEXT_OPTIONS]);
		assert.deepEqual(CONTEXT_OPTIONS, { acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false, bypassCSP: false, javaScriptEnabled: true, permissions: [] });
		assert.deepEqual(fake.initScripts, [HARDENING]);
		// Exactly two requests to Pim: the launch with the evaluator credential and the grant's identity, and the End of the launch's own ID with the run token.
		const [launch, end] = fake.posts;
		assert.equal(fake.posts.length, 2);
		assert.equal(launch!.url, `${ORIGIN}${LAUNCH_PATH}`);
		assert.deepEqual(launch!.headers, { authorization: `${EVALUATOR_SCHEME} ${CREDENTIAL}`, origin: ORIGIN, "content-type": "application/json" });
		assert.deepEqual(launch!.data, { owner: OWNER, evaluation: EVALUATION, deployment: DEPLOYMENT });
		assert.equal(end!.url, `${ORIGIN}${END_PATH}`);
		assert.deepEqual(end!.headers, { authorization: `${EVALUATOR_SCHEME} ${CREDENTIAL}`, origin: ORIGIN, "content-type": "application/json", [RUN_HEADER]: RUN });
		assert.deepEqual(end!.data, { owner: OWNER, evaluation: EVALUATION, deployment: DEPLOYMENT, observation: ID });
		for (const post of fake.posts) assert.deepEqual([post.options.maxRedirects, post.options.failOnStatusCode], [0, false]);
		// The credential and run token never ride in a URL; the report holds no secret.
		for (const post of fake.posts) assertNoSecrets(post.url);
		assertNoSecrets(JSON.stringify(report));
		// The media socket was connected, its acknowledgement went up, and its frames came down.
		const [media] = fake.sockets;
		assert.deepEqual([media!.connected, media!.closed, media!.up, media!.down.length], [true, null, [ack], 3]);
		assert.deepEqual(fake.requests.map((r) => r.verdict), ["continue", "continue", "continue"]);
		assert.deepEqual([fake.closed.page, fake.closed.context, fake.closed.browser], [1, 1, 1]);
	});

	it("never lets the page reach Pim, another launch, another call or another socket, and stops connecting once the viewer step ends", async () => {
		const fake = new Fake();
		let late: Socket | undefined;
		fake.page = async (page) => {
			for (const url of [`${ORIGIN}/api/observations`, `${ORIGIN}/api/observations/${OLD_ID}`, `${ORIGIN}/api/observations/${ID}/end`, `${ORIGIN}/`]) assert.equal(await page.request(url), "abort");
			assert.equal(await page.request(`${ORIGIN}/api/observations`, "POST"), "abort");
			assert.equal(await page.request(`${VIEWER}/${OTHER_LAUNCH}/viewer/`), "abort");
			for (const call of ["ClipboardService/Read", "FileService/List", "InputService/Send", "PresenceService/UpdateCursor", "PresenceService/Leave", "SessionService/CreateViewerTicket"]) {
				assert.equal(await page.request(`${VIEWER}/${LAUNCH}/cua.env.v1.${call}`, "POST"), "abort");
			}
			for (const url of [`wss://pim-eval.example.test/api/ws`, `wss://pim-eval.example.test/api/browser/live`, `wss://bridge-eval.example.test/${OTHER_LAUNCH}/media?ticket=${ATTACH}`, `${MEDIA}&x=1`, `wss://bridge-eval.example.test/${LAUNCH}/media`]) {
				const socket = await page.socket(url);
				assert.deepEqual([socket.connected, socket.closed], [false, 1008]);
			}
			await viewerWorks(page);
		};
		const report = await evaluate(fake);
		assert.equal(report.outcome, "qualified");
		assert.equal(report.viewer!.refusedRequests, 12);
		assert.equal(report.viewer!.refusedSockets, 5);
		// After the viewer step, the page's sockets and requests are refused as before the launch.
		const page = fake.late();
		await page.goto(VIEWER_URL, { timeout: 1, waitUntil: "load" }).catch(() => undefined);
		late = fake.sockets.at(-1);
		assert.deepEqual([late!.connected, late!.closed], [false, 1008]);
		assert.equal(fake.requests.at(-1)!.verdict, "abort");
	});
});

describe("a launch that fails or is uncertain stops: no viewer and no End", () => {
	const cases: [string, Answer, EvaluationReport["outcome"]][] = [
		["the request throws", "throw", "launch-uncertain"],
		["the Worker answers launch_uncertain", { status: 502, body: { error: "x", run: { phase: "launch_uncertain" } } }, "launch-uncertain"],
		["the Worker fails", { status: 500, body: null }, "launch-uncertain"],
		["the answer has no run token", { status: 201, body: { ...(openAnswer() as { body: Record<string, unknown> }).body, runToken: undefined } }, "launch-uncertain"],
		["the answer's deadline is past 10 minutes", openAnswer({ run: { phase: "open", deadline: new Date(Date.now() + 11 * 60_000).toISOString(), observation: { id: ID, status: "open", notAfter: 1 } } }), "launch-uncertain"],
		["the answer's ID isn't an observation ID", openAnswer({ run: { phase: "open", deadline: new Date(Date.now() + 60_000).toISOString(), observation: { id: "../x", status: "open", notAfter: 1 } } }), "launch-uncertain"],
		["a 409 says launch_uncertain", { status: 409, body: { run: { phase: "launch_uncertain" } } }, "launch-uncertain"],
		["a redirect", { status: 302, body: null }, "launch-uncertain"],
		["the space started nothing", { status: 409, body: { error: "x", run: { phase: "launch_refused", reason: "unresolved" } } }, "launch-refused"],
		["the grant was spent", { status: 409, body: { error: "x", run: { phase: "ended" } } }, "launch-refused"],
		["the credential is refused", { status: 401, body: { error: "x" } }, "launch-refused"],
		["the evaluator is off", { status: 404, body: { error: "x" } }, "launch-refused"],
	];
	for (const [name, answer, outcome] of cases) {
		it(`when ${name}`, async () => {
			const fake = new Fake();
			fake.launchAnswer = answer;
			const report = await evaluate(fake);
			assert.equal(report.outcome, outcome);
			assert.deepEqual([report.viewer, report.end, report.launch.observation], [null, null, null]);
			assert.deepEqual(posted(fake), [LAUNCH_PATH]);
			assert.equal(fake.events.includes("newPage"), false);
			assertClosedOnce(fake);
			assertNoSecrets(JSON.stringify(report));
		});
	}
});

describe("an uncertain launch reports the Worker's fixed classification, and nothing else of its answer", () => {
	it("passes each known classification through, and drops anything else", async () => {
		for (const classification of ["owner_space_rpc_failure", "post_rpc_recording_failure", "space_launch_uncertain", "space_answer_malformed", `leaked ${CREDENTIAL}`, 42]) {
			const fake = new Fake();
			fake.launchAnswer = { status: 502, body: { error: "x", run: { phase: "launch_uncertain", classification } } };
			const report = await evaluate(fake);
			const known = typeof classification === "string" && !classification.startsWith("leaked");
			assert.deepEqual(report.launch, { status: 502, phase: "launch_uncertain", classification: known ? classification : null, observation: null, deadline: null });
			assert.deepEqual([report.outcome, report.end], ["launch-uncertain", null]);
			assert.deepEqual(posted(fake), [LAUNCH_PATH]);
			assertNoSecrets(JSON.stringify(report));
		}
	});
});

describe("after a certain launch, any viewer failure still ends that observation, exactly once", () => {
	const cases: [string, (fake: Fake) => void, string][] = [
		["the page doesn't load", (fake) => void (fake.gotoThrows = true), "page"],
		["the viewer's address is at another origin", (fake) => void (fake.launchAnswer = openAnswer({ viewer: VIEWER_URL.replace(VIEWER, "https://elsewhere.example.test") })), "address"],
		["the viewer's address isn't the adapter's", (fake) => void (fake.launchAnswer = openAnswer({ viewer: VIEWER_URL.replace("clipboard=0", "clipboard=1") })), "address"],
		["the viewer's address names Pim's observation route", (fake) => void (fake.launchAnswer = openAnswer({ viewer: `${ORIGIN}/api/observations/${OLD_ID}` })), "address"],
		["the page ends up elsewhere", (fake) => void (fake.pageUrl = `${ORIGIN}/`), "redirect"],
		["no frame comes", (fake) => void (fake.page = async (page) => void (await page.socket(MEDIA)).fromServer(hello)), "no-stream"],
		["the stream opens with input allowed", (fake) => void (fake.page = async (page) => void (await page.socket(MEDIA)).fromServer(opened("allow_activation"))), "not-view-only"],
		["the context holds a cookie", (fake) => void (fake.cookies = [{ name: "__Host-pim-automation" }]), "cookie"],
	];
	for (const [name, set, failure] of cases) {
		it(`when ${name}`, async () => {
			const fake = new Fake();
			set(fake);
			const report = await evaluate(fake);
			assert.equal(report.outcome, "viewer-failed");
			assert.equal(report.viewer!.failure, failure);
			assert.deepEqual(posted(fake), [LAUNCH_PATH, END_PATH]);
			assert.equal(fake.posts[1]!.data && (fake.posts[1]!.data as { observation: string }).observation, ID);
			assert.deepEqual(report.end, { sent: true, status: 202, phase: "ended", observationStatus: "revoking" });
			assertClosedOnce(fake);
			assertNoSecrets(JSON.stringify(report));
		});
	}

	it("when the page sends input, a microphone packet or a geometry change: none goes up, the socket closes", async () => {
		for (const message of [
			JSON.stringify({ type: "input", payload: { session_id: "media-1", kind: "key", key: "a" } }),
			JSON.stringify({ type: "set_window_geometry", payload: { session_id: "media-1", width: 1 } }),
			new Uint8Array([9, 9, 9]),
			JSON.stringify({ type: "frame_ack", payload: { session_id: "media-1", sequence: 1, decode_queue: 0, extra: 1 } }),
		]) {
			const fake = new Fake();
			fake.page = async (page) => {
				const media = await page.socket(MEDIA);
				media.fromServer(opened());
				media.fromPage(message);
				media.fromServer(new Uint8Array([1]));
			};
			const report = await evaluate(fake);
			const [media] = fake.sockets;
			assert.deepEqual([report.outcome, report.viewer!.failure, report.viewer!.refusedMessages], ["viewer-failed", "upward", 1]);
			assert.deepEqual([media!.up, media!.closed, media!.serverClosed], [[], 1008, 1008]);
			assert.deepEqual(posted(fake), [LAUNCH_PATH, END_PATH]);
		}
	});

	it("when the page opens more media sockets than the bound", async () => {
		const fake = new Fake();
		fake.page = async (page) => {
			for (let i = 0; i <= MAX_MEDIA_SOCKETS; i++) await page.socket(MEDIA);
		};
		const report = await evaluate(fake);
		assert.deepEqual([report.viewer!.mediaSockets, report.viewer!.refusedSockets, fake.sockets.at(-1)!.connected], [MAX_MEDIA_SOCKETS, 1, false]);
		assert.deepEqual(posted(fake), [LAUNCH_PATH, END_PATH]);
	});
});

describe("an End that fails is never retried", () => {
	const cases: [string, Answer, EvaluationReport["outcome"]][] = [
		["the request throws", "throw", "end-uncertain"],
		["the Worker answers end_uncertain", { status: 502, body: { run: { phase: "end_uncertain", observation: { id: ID, status: "unconfirmed" } } } }, "end-uncertain"],
		["the Worker answers for another observation", { status: 202, body: { run: { phase: "ended", observation: { id: OLD_ID, status: "revoking" } } } }, "end-uncertain"],
		["the Worker fails", { status: 500, body: null }, "end-uncertain"],
		["the run can't end now", { status: 409, body: { run: { phase: "expired" } } }, "end-refused"],
		["the space didn't ask for the end", { status: 502, body: { run: { phase: "end_refused", observation: { id: ID, status: "revoking" } } } }, "end-refused"],
	];
	for (const [name, answer, outcome] of cases) {
		it(`when ${name}`, async () => {
			const fake = new Fake();
			fake.endAnswer = answer;
			const report = await evaluate(fake);
			assert.equal(report.outcome, outcome);
			assert.deepEqual(posted(fake), [LAUNCH_PATH, END_PATH]);
			assert.equal(report.end!.sent, true);
			assertClosedOnce(fake);
			assertNoSecrets(JSON.stringify(report));
		});
	}
});

describe("ten minutes at most", () => {
	it("refuses to begin with under two minutes left, before a browser exists", async () => {
		const fake = new Fake();
		const error = await refusal(() => evaluate(fake, { deadline: Date.now() + 60_000 }));
		assert.equal(error.code, "deadline");
		assert.deepEqual(fake.events, []);
	});

	it("sends no End once the run's deadline has passed, and says it expired", async () => {
		const fake = new Fake();
		let offset = 0;
		// The run's own long timer is left inert here; the viewer's short one is real.
		const clock = { now: () => Date.now() + offset, setTimeout: (fn: () => void, ms: number) => setTimeout(ms > 60_000 ? () => undefined : fn, ms > 60_000 ? 0 : ms), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
		// The page takes 11 minutes, past the Worker's run deadline and the client's.
		fake.onGoto = () => void (offset = 11 * 60_000);
		const report = await evaluate(fake, { clock });
		assert.equal(report.outcome, "expired");
		assert.deepEqual(report.end, { sent: false, status: null, phase: null, observationStatus: null });
		assert.deepEqual(posted(fake), [LAUNCH_PATH]);
		assertClosedOnce(fake);
	});

	it("closes the browser at the client's deadline, whatever is running, and then ends nothing", async () => {
		const fake = new Fake();
		const timers: { fn: () => void; ms: number }[] = [];
		const clock = { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), setTimeout(() => undefined, 0)), clearTimeout: () => undefined };
		// The page hangs until the hard stop, which the test fires as the deadline would.
		fake.page = async () => {
			const stop = timers.find((timer) => timer.ms > 9 * 60_000 && timer.ms <= 10 * 60_000)!;
			stop.fn();
			throw new Error("Target page, context or browser has been closed");
		};
		const report = await evaluate(fake, { clock });
		assert.deepEqual([report.outcome, report.viewer!.failure, report.end!.sent], ["expired", "page", false]);
		assert.deepEqual(posted(fake), [LAUNCH_PATH]);
		assertClosedOnce(fake);
	});

	it("watches the viewer no longer than leaves time for the End", async () => {
		const fake = new Fake();
		const asked: number[] = [];
		const clock = { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => (asked.push(ms), setTimeout(fn, ms > 60_000 ? 2 ** 30 : ms)), clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
		// The run's deadline is 20.3 s away: the viewer is given at most 0.3 s, keeping 20 s for the End.
		fake.launchAnswer = openAnswer({ run: { phase: "open", deadline: new Date(Date.now() + 20_300).toISOString(), observation: { id: ID, status: "open", notAfter: Date.now() + 20_300 } } });
		fake.page = async (page) => void (await page.socket(MEDIA)).fromServer(opened());
		const report = await evaluate(fake, { clock, observeMs: 60_000 });
		assert.ok(asked[1]! <= 300 && asked[1]! > 0, `the viewer was given ${asked[1]} ms`);
		assert.deepEqual([report.outcome, report.viewer!.failure], ["viewer-failed", "no-stream"]);
		assert.deepEqual(posted(fake), [LAUNCH_PATH, END_PATH]);
	});
});

describe("what the page may request and send", () => {
	it("allows the new launch's viewer files by GET or HEAD and its seven view-only calls by POST, at the viewer's origin, and nothing else", () => {
		for (const file of ["", "index.html", "viewer.js", "index.css", "audioWorklet.js", "captureWorklet.js"]) {
			assert.equal(viewerMayRequest(`${VIEWER}/${LAUNCH}/viewer/${file}`, "GET", VIEWER, LAUNCH), true, file);
			assert.equal(viewerMayRequest(`${VIEWER}/${LAUNCH}/viewer/${file}`, "HEAD", VIEWER, LAUNCH), true, file);
			assert.equal(viewerMayRequest(`${VIEWER}/${LAUNCH}/viewer/${file}`, "POST", VIEWER, LAUNCH), false, file);
		}
		for (const call of ["SystemService/GetCapabilities", "StreamService/ListTargets", "StreamService/OpenMedia", "StreamService/SetPreferences", "StreamService/RequestKeyframe", "StreamService/CloseMedia", "PresenceService/Join"]) {
			assert.equal(viewerMayRequest(`${VIEWER}/${LAUNCH}/cua.env.v1.${call}`, "POST", VIEWER, LAUNCH), true, call);
			assert.equal(viewerMayRequest(`${VIEWER}/${LAUNCH}/cua.env.v1.${call}`, "GET", VIEWER, LAUNCH), false, call);
		}
		for (const [url, method] of [
			[`${ORIGIN}/api/observations`, "GET"],
			[`${ORIGIN}/api/observations`, "POST"],
			[`${ORIGIN}/api/observations/${OLD_ID}`, "GET"],
			[`${ORIGIN}/auth/launch-evaluator/end`, "POST"],
			[`${VIEWER}/${OTHER_LAUNCH}/viewer/`, "GET"],
			[`${VIEWER}/${LAUNCH}/viewer/other.js`, "GET"],
			[`${VIEWER}/${LAUNCH}/viewer/?x=1`, "GET"],
			[`${VIEWER}/${LAUNCH}/cua.env.v1.ClipboardService/Read`, "POST"],
			[`${VIEWER}/${LAUNCH}/cua.env.v1.FileSystemService/Read`, "POST"],
			[`${VIEWER}/${LAUNCH}/cua.env.v1.PresenceService/UpdateCursor`, "POST"],
			[`${VIEWER}/${LAUNCH}/cua.env.v1.PresenceService/Leave`, "POST"],
			[`${VIEWER}/${LAUNCH}/cua.env.v1.ViewerService/CreateViewerTicket`, "POST"],
			[`${VIEWER}/${LAUNCH}/media`, "GET"],
			[`${VIEWER}/${LAUNCH}/files`, "GET"],
			[`${VIEWER}/mcp`, "POST"],
			[`http://bridge-eval.example.test/${LAUNCH}/viewer/`, "GET"],
			[`https://user@bridge-eval.example.test/${LAUNCH}/viewer/`, "GET"],
			["not a url", "GET"],
		]) {
			assert.equal(viewerMayRequest(url!, method!, VIEWER, LAUNCH), false, `${method} ${url}`);
		}
		// With no launch yet, nothing at all.
		assert.equal(viewerMayRequest(`${VIEWER}/${LAUNCH}/viewer/`, "GET", VIEWER, ""), false);
	});

	it("connects only the new launch's media socket, exactly", () => {
		assert.equal(viewerMaySocket(MEDIA, VIEWER, LAUNCH), true);
		for (const url of [`wss://pim-eval.example.test/api/ws`, `ws://bridge-eval.example.test/${LAUNCH}/media?ticket=${ATTACH}`, MEDIA.replace(LAUNCH, OTHER_LAUNCH), `${MEDIA}&x=1`, MEDIA.replace("media", "presence"), `wss://bridge-eval.example.test.evil.test/${LAUNCH}/media?ticket=${ATTACH}`]) {
			assert.equal(viewerMaySocket(url, VIEWER, LAUNCH), false, url);
		}
		assert.equal(viewerMaySocket(MEDIA, VIEWER, ""), false);
	});

	it("lets only keyframe requests and frame acknowledgements go up, as text", () => {
		assert.equal(mayGoUp(ack), true);
		assert.equal(mayGoUp(JSON.stringify({ type: "request_keyframe", payload: { session_id: "media-1" } })), true);
		for (const message of [
			new Uint8Array([1]),
			JSON.stringify({ type: "input", payload: { session_id: "media-1" } }),
			JSON.stringify({ type: "request_keyframe", payload: { session_id: "media-1", extra: true } }),
			JSON.stringify({ type: "frame_ack", payload: { session_id: "media-1", sequence: "1", decode_queue: 0 } }),
			JSON.stringify({ type: "frame_ack", payload: { session_id: "media-1", sequence: 1, decode_queue: 0 }, extra: 1 }),
			JSON.stringify({ type: "request_keyframe", payload: { session_id: "x".repeat(2000) } }),
			"not json",
		]) {
			assert.equal(mayGoUp(message), false);
		}
	});

	it("takes the viewer's address only as exactly the adapter's for one launch at the viewer's origin", () => {
		assert.deepEqual(viewerAddress(VIEWER_URL, VIEWER), { url: VIEWER_URL, launchId: LAUNCH, ticket: TICKET });
		for (const bad of [
			VIEWER_URL.replace(VIEWER, ORIGIN),
			VIEWER_URL.replace("clipboard=0", "clipboard=1"),
			VIEWER_URL.replace("viewer/#", "viewer/?x=1#"),
			VIEWER_URL.replace(`${LAUNCH}/viewer/`, `${LAUNCH}/../viewer/`),
			VIEWER_URL.replace(TICKET, "short"),
			`${ORIGIN}/api/observations/${OLD_ID}`,
			42,
		]) {
			assert.equal(viewerAddress(bad, VIEWER), null, String(bad));
		}
	});

	it("refuses capture, the clipboard and file pickers in every page before its scripts run", () => {
		for (const name of ["getUserMedia", "getDisplayMedia", "readText", "writeText", "showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) assert.ok(HARDENING.includes(`"${name}"`), name);
		assert.doesNotThrow(() => new Function(HARDENING));
	});
});

describe("the browser and the files that drive it", () => {
	const SOURCES = ["launch-evaluator.ts", "launch-evaluator-cli.ts"];

	it("strip under Node's own type stripping, and load only Node's modules and their siblings", () => {
		for (const name of SOURCES) {
			const source = fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
			assert.doesNotThrow(() => stripTypeScriptTypes(source, { mode: "strip" }));
			for (const [, specifier] of source.matchAll(/^import .* from "([^"]+)";/gm)) assert.match(specifier!, /^(node:[a-z:]+|\.\/(agent-preview|launch-evaluator)\.ts)$/, `${name}: ${specifier}`);
		}
	});

	it("never use input, clipboard, files, permissions, stored state, CDP, profiles, executables, launch arguments or screenshots", () => {
		const forbidden = [
			".keyboard",
			".mouse",
			".touchscreen",
			".click(",
			".dblclick(",
			".fill(",
			".type(",
			".press(",
			".tap(",
			"setInputFiles",
			"grantPermissions",
			"storageState",
			"launchPersistentContext",
			"connectOverCDP",
			"newCDPSession",
			"userDataDir",
			"executablePath",
			"--no-sandbox",
			"chromiumSandbox",
			"ignoreDefaultArgs",
			"chromium.launch",
			"headless:",
			"channel:",
			"screenshot(",
			"tracing",
			"recordVideo",
			"recordHar",
			"addCookies",
			"setExtraHTTPHeaders",
			".evaluate(",
			"exposeFunction",
			"exposeBinding",
			"/api/observations",
		];
		for (const name of SOURCES) {
			const source = fs.readFileSync(new URL(`../${name}`, import.meta.url), "utf8").replace(HARDENING, "");
			for (const word of forbidden) assert.equal(source.includes(word), false, `${name} mentions ${word}`);
		}
	});

	function runtime(version: string) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launch-evaluator-runtime-"));
		dirs.push(dir);
		const module = path.join(dir, "node_modules", "playwright");
		fs.mkdirSync(module, { recursive: true });
		fs.writeFileSync(path.join(dir, "package.json"), "{}");
		fs.writeFileSync(path.join(module, "package.json"), JSON.stringify({ name: "playwright", version, main: "index.cjs" }));
		fs.writeFileSync(path.join(module, "index.cjs"), "exports.chromium = { launch: async (options) => ({ fakeLaunch: options }) };");
		return dir;
	}

	it("launches Playwright's bundled Chromium headless by default, and the system Chrome only for exactly the chrome channel", async () => {
		const bundled = (await evaluatorChromium(runtime(PLAYWRIGHT_VERSION)).launch()) as unknown as { fakeLaunch: object };
		assert.deepEqual(bundled.fakeLaunch, { headless: true });
		const chrome = (await evaluatorChromium(runtime(PLAYWRIGHT_VERSION), "chrome").launch()) as unknown as { fakeLaunch: object };
		assert.deepEqual(chrome.fakeLaunch, { headless: true, channel: "chrome" });
		for (const other of ["chrome-beta", "msedge", "", "/opt/google/chrome/chrome"]) {
			const error = await refusal(() => evaluatorChromium(runtime(PLAYWRIGHT_VERSION), other as never).launch());
			assert.equal(error.code, "launch");
		}
		assert.equal((await refusal(() => evaluatorChromium(runtime("1.0.0")).launch())).code, "launch");
	});

	it("launches nothing when the browser fails, and says nothing the launcher said", async () => {
		const fake = new Fake();
		fake.launchThrows = true;
		const error = await refusal(() => evaluate(fake));
		assert.equal(error.code, "launch");
		assert.equal(`${error.message}${error.stack?.split("\n")[0]}`.match(/ENOENT|chrome|evaluator-credential/), null);
		assert.deepEqual(fake.posts, []);
	});

	it("launches nothing for a file that names another origin or viewer, or that isn't protected", async () => {
		for (const options of [{ origin: "https://other.example.test" }, { viewerOrigin: "https://other-bridge.example.test" }]) {
			const fake = new Fake();
			assert.equal((await refusal(() => evaluate(fake, options))).code, "config");
			assert.deepEqual(fake.events, []);
		}
		const loose = configFile();
		fs.chmodSync(loose, 0o644);
		const fake = new Fake();
		assert.equal((await refusal(() => evaluate(fake, { configFile: loose }))).code, "config-file");
		assert.deepEqual(fake.events, []);
	});
});

describe("the entry point", () => {
	const capture = () => {
		const out: string[] = [];
		const err: string[] = [];
		return { out, err, streams: { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) } };
	};
	const args = (file = configFile(), extra: string[] = []) => ["--origin", ORIGIN, "--viewer-origin", VIEWER, "--config-file", file, "--deadline", new Date(Date.now() + 60 * 60_000).toISOString(), "--playwright-dir", "/unused", ...extra];

	it("runs one evaluation and prints one line of metadata, with no secret, exiting 0 only when it qualified", async () => {
		const fake = new Fake();
		const io = capture();
		assert.equal(await run(args(), io.streams, fake.launcher, 40), 0);
		assert.deepEqual(io.err, []);
		assert.equal(io.out.length, 1);
		const line = JSON.parse(io.out[0]!) as Record<string, unknown>;
		assert.deepEqual([line.event, line.outcome], ["launch-evaluator.result", "qualified"]);
		assertNoSecrets(io.out[0]!);
		assert.deepEqual(posted(fake), [LAUNCH_PATH, END_PATH]);

		const uncertain = new Fake();
		uncertain.launchAnswer = "throw";
		const again = capture();
		assert.equal(await run(args(), again.streams, uncertain.launcher, 40), 1);
		assert.equal((JSON.parse(again.out[0]!) as { outcome: string }).outcome, "launch-uncertain");
		assertNoSecrets(again.out.join("\n"));
		assert.deepEqual(posted(uncertain), [LAUNCH_PATH]);
	});

	it("refuses unknown, repeated and missing options, any channel but chrome, and any way to name an observation, before a browser exists", async () => {
		const file = configFile();
		const refused = [
			[],
			args(file).slice(2),
			[...args(file), "--executable-path", "/opt/google/chrome/chrome"],
			[...args(file), "--user-data-dir", "/home/operator/.config/google-chrome"],
			[...args(file), "--cdp-url", "http://127.0.0.1:9222"],
			[...args(file), "--storage-state", "/tmp/state.json"],
			[...args(file), "--args", "--no-sandbox"],
			[...args(file), "--channel", "chrome"],
			[...args(file), "--observation", OLD_ID],
			[...args(file), "--retry"],
			[...args(file), OLD_ID],
			[...args(file), "--origin", ORIGIN],
			[...args(file), "--browser-channel", "msedge"],
			[...args(file), "--browser-channel", ""],
			[...args(file), "--browser-channel", "chrome", "--browser-channel", "chrome"],
			args(file).map((value, i, all) => (all[i - 1] === "--deadline" ? new Date(Date.now() - 1000).toISOString() : value)),
		];
		for (const argv of refused) {
			const fake = new Fake();
			const io = capture();
			assert.equal(await run(argv, io.streams, fake.launcher), 2, argv.join(" "));
			assert.deepEqual([io.out, io.err], [[], [USAGE]]);
			assert.deepEqual(fake.events, []);
		}
		const chrome = new Fake();
		assert.equal(await run([...args(file), "--browser-channel", "chrome"], capture().streams, chrome.launcher, 40), 0);
	});

	it("does nothing when imported: it runs only as the entry point", () => {
		assert.equal(process.exitCode, undefined);
	});
});
