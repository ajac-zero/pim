/**
 * The one-use launch evaluator for the preview's Cua evaluation
 * (docs/launch-evaluator.md). It qualifies exactly one new viewer
 * observation for the evaluation's owner, in this order and no other:
 *
 *   1. one `POST /auth/launch-evaluator/launch`, which asks the owner's space
 *      for one fresh observation and answers its ID, the viewer's address on
 *      the bridge's host and a run token;
 *   2. one page load of that viewer, in a fresh isolated browser context,
 *      watched until its media stream is view only and has a frame;
 *   3. one `POST /auth/launch-evaluator/end` for that same ID, whether the
 *      viewer qualified or failed;
 *   4. the browser closed, and with it everything the run held. The Worker
 *      makes the grant spent for good at step 1, whatever happens after.
 *
 * It is not the read-only diagnosis (agent-preview.ts and
 * agent-preview-cli.ts), which it leaves as it was, and it uses no automation
 * session or cookie: its credential is the evaluator grant's own, in its own
 * `Authorization` scheme, and the Worker answers it only on these two routes.
 *
 * What it holds to:
 * - **One launch, never retried.** A launch that fails, or whose result is
 *   anything but exactly an open fresh observation with a run token and a
 *   deadline, stops the run: no viewer and no End. A refusal means nothing
 *   started; anything else is uncertain, and an uncertain launch is never
 *   ended from here (`OneUseRun`).
 * - **One End, never retried, only of the launch's own ID.** Sent once the
 *   viewer step is over, however it went, while the run's deadline allows.
 *   A failed or uncertain End stops the run. Nothing takes an observation ID
 *   as input: the only ID is the one the launch answered.
 * - **Ten minutes at most.** The run ends by the earliest of the Worker's run
 *   deadline, the evaluation's `--deadline` and 10 minutes after it started;
 *   the viewer step stops early enough to leave time for the End, and a timer
 *   closes the browser at the end regardless.
 * - **The page reaches only the viewer.** Before any page exists the context
 *   aborts every browser request but the viewer's own files and its seven
 *   view-only calls under the new launch's path on the bridge's origin, and
 *   only while the viewer step runs; nothing of Pim's origin, so no page API
 *   call. It answers every WebSocket itself and closes it, but the one media
 *   socket of the new launch, which it connects while the viewer step runs.
 *   Up that socket go only the keyframe requests and frame acknowledgements
 *   the view-only relay takes; anything else (input, actions, geometry,
 *   microphone packets) is not forwarded and closes it. A script added
 *   before any page refuses microphone, screen capture, clipboard and file
 *   pickers. The harness itself never types, clicks, grants a permission or
 *   sets a file: the page it holds has `goto`, `url` and `close` only.
 * - **A fresh browser.** Playwright's bundled Chromium, or exactly the system
 *   Chrome with `--browser-channel chrome` (agent-preview.ts's
 *   `playwrightChromium`), headless, sandboxed, with a new context: no
 *   profile, storage state, CDP attach, executable path or launch argument.
 * - **No secret in output.** The credential, the run token, the viewer's
 *   address and its ticket are never printed, logged or put in an error, and
 *   no screenshot or trace is taken. The report holds fixed words, counts,
 *   statuses and the fresh observation's ID.
 */

import { AgentPreviewError, type BrowserChannel, type Clock, exactOrigin, playwrightChromium, readProtectedFile } from "./agent-preview.ts";

export const LAUNCH_PATH = "/auth/launch-evaluator/launch";
export const END_PATH = "/auth/launch-evaluator/end";
export const EVALUATOR_SCHEME = "Pim-Launch-Evaluator";
export const RUN_HEADER = "x-pim-launch-evaluator-run";
/** The longest a run lasts, whatever else allows. */
export const MAX_RUN_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** The time kept back from the viewer step for the End. */
export const END_RESERVE_MS = 20_000;
/** The longest the viewer is watched for a view-only frame. */
export const OBSERVE_MS = 30_000;
/** The least time a run must have left to begin at all. */
export const MIN_START_MS = 2 * 60 * 1000;
/** The most requests, subresources and calls included, the viewer's page may make; the rest are aborted. */
export const MAX_BROWSER_REQUESTS = 1000;
/** The most media sockets the viewer may open (it opens a new one when a media ticket runs out). */
export const MAX_MEDIA_SOCKETS = 4;
/** How far the Worker's run deadline may be past 10 minutes from the launch, for clocks that differ a little. */
const SKEW_MS = 5_000;
const MAX_UP_BYTES = 1024;

const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const OWNER = /^o_[0-9a-z]{26}$/;
const EVALUATION = /^[a-z0-9][a-z0-9-]{2,62}$/;
const DEPLOYMENT = /^cua-eval@[a-z0-9][a-z0-9-]{0,30}$/;
const OBSERVATION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$/;

// --- The operator's protected input ---------------------------------------------

/** The evaluator's input: the grant's identity, Pim's and the viewer's origins, and the credential. */
export type EvaluatorConfig = Readonly<{ origin: string; viewerOrigin: string; owner: string; evaluation: string; deployment: string; credential: string }>;

const KEYS = ["credential", "deployment", "evaluation", "kind", "origin", "owner", "version", "viewerOrigin"];
const invalid = () => new AgentPreviewError("config", "The configuration file's content is not valid.");

/**
 * Parses the file `scripts/preview-launch-evaluator-grant.mjs` writes: exactly
 * these fields, `version` 1 and `kind` "launch-evaluator", so an automation
 * runner's file is refused here as this one is refused there. The viewer's
 * origin must be another host than Pim's, as the Worker requires of a bridge.
 */
export function parseEvaluatorConfig(text: string): EvaluatorConfig {
	let config: Record<string, unknown>;
	try {
		config = JSON.parse(text);
	} catch {
		throw invalid();
	}
	if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).sort().join() !== KEYS.join() || config.version !== 1 || config.kind !== "launch-evaluator") throw invalid();
	const { origin, viewerOrigin, owner, evaluation, deployment, credential } = config;
	if ([origin, viewerOrigin, owner, evaluation, deployment, credential].some((value) => typeof value !== "string")) throw invalid();
	if (!OWNER.test(owner as string) || !EVALUATION.test(evaluation as string) || !DEPLOYMENT.test(deployment as string) || !CREDENTIAL.test(credential as string)) throw invalid();
	try {
		exactOrigin(origin as string);
		exactOrigin(viewerOrigin as string);
	} catch {
		throw invalid();
	}
	if (new URL(origin as string).hostname === new URL(viewerOrigin as string).hostname) throw invalid();
	return Object.freeze({ origin, viewerOrigin, owner, evaluation, deployment, credential } as EvaluatorConfig);
}

// --- The parts of Playwright used (structural, so tests can fake them) ------------

export interface EvaluatorResponse {
	status(): number;
	json(): Promise<unknown>;
}
export interface EvaluatorRequestOptions {
	headers: Record<string, string>;
	data: unknown;
	maxRedirects: 0;
	failOnStatusCode: false;
	timeout: number;
}
export interface EvaluatorRoute {
	request(): { url(): string; method(): string };
	abort(errorCode?: string): Promise<void>;
	continue(): Promise<void>;
}
export type SocketMessage = string | Uint8Array;
/** The server side of a routed WebSocket. */
export interface ServerSocket {
	onMessage(handler: (message: SocketMessage) => void): void;
	send(message: SocketMessage): void;
	close(options?: { code?: number; reason?: string }): Promise<void> | void;
}
/** A page's WebSocket, as the context's route gets it. */
export interface PageSocket {
	url(): string;
	connectToServer(): ServerSocket;
	onMessage(handler: (message: SocketMessage) => void): void;
	send(message: SocketMessage): void;
	close(options?: { code?: number; reason?: string }): Promise<void> | void;
}
/** All of a page the harness uses: no input, clipboard, file, permission, screenshot or evaluation method. */
export interface EvaluatorPage {
	goto(url: string, options: { timeout: number; waitUntil: "load" }): Promise<unknown>;
	url(): string;
	close(): Promise<void>;
}
export interface EvaluatorContext {
	readonly request: { post(url: string, options: EvaluatorRequestOptions): Promise<EvaluatorResponse> };
	cookies(): Promise<readonly unknown[]>;
	addInitScript(script: { content: string }): Promise<void>;
	route(url: string, handler: (route: EvaluatorRoute) => Promise<void> | void): Promise<void>;
	routeWebSocket(url: RegExp, handler: (ws: PageSocket) => Promise<void> | void): Promise<void>;
	newPage(): Promise<EvaluatorPage>;
	close(): Promise<void>;
}
/** Every option the context is made with: nothing stored, granted, recorded or bypassed. */
export interface EvaluatorContextOptions {
	acceptDownloads: false;
	serviceWorkers: "block";
	ignoreHTTPSErrors: false;
	bypassCSP: false;
	javaScriptEnabled: true;
	permissions: [];
}
export interface EvaluatorBrowser {
	newContext(options: EvaluatorContextOptions): Promise<EvaluatorContext>;
	close(): Promise<void>;
}
export interface EvaluatorLauncher {
	launch(): Promise<EvaluatorBrowser>;
}

export const CONTEXT_OPTIONS: EvaluatorContextOptions = Object.freeze({ acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false, bypassCSP: false, javaScriptEnabled: true, permissions: [] as [] });

/** The same fresh, headless, sandboxed launch as the diagnosis: bundled Chromium, or exactly the system Chrome. */
export function evaluatorChromium(runtimeDir: string, channel?: BrowserChannel): EvaluatorLauncher {
	return playwrightChromium(runtimeDir, channel) as unknown as EvaluatorLauncher;
}

/**
 * Added to every page before its own scripts: microphone and screen capture,
 * the clipboard and the file pickers all refuse. The viewer is view only and
 * has its clipboard off already; this is a layer under that, not instead.
 */
export const HARDENING = `(() => {
	const refuse = () => Promise.reject(new DOMException("The launch evaluator allows no capture, clipboard or files.", "NotAllowedError"));
	const lock = (target, name) => {
		try {
			if (target && name in target) Object.defineProperty(target, name, { value: refuse, configurable: false, writable: false });
		} catch {}
	};
	if (globalThis.MediaDevices) for (const name of ["getUserMedia", "getDisplayMedia"]) lock(MediaDevices.prototype, name);
	if (globalThis.navigator && navigator.mediaDevices) for (const name of ["getUserMedia", "getDisplayMedia"]) lock(navigator.mediaDevices, name);
	if (globalThis.Clipboard) for (const name of ["read", "readText", "write", "writeText"]) lock(Clipboard.prototype, name);
	for (const name of ["showOpenFilePicker", "showSaveFilePicker", "showDirectoryPicker"]) lock(globalThis, name);
})();`;

// --- What the viewer's page may do ------------------------------------------------

const LAUNCH_ID = "[A-Za-z0-9_-]{22}";
const VIEWER_FILES = ["", "index.html", "viewer.js", "index.css", "audioWorklet.js", "captureWorklet.js"];
/** The view-only adapter's seven calls (docs/cua-viewer-adapter.md); clipboard, files, input and every other service are refused. */
const VIEWER_CALLS = [
	"SystemService/GetCapabilities",
	"StreamService/ListTargets",
	"StreamService/OpenMedia",
	"StreamService/SetPreferences",
	"StreamService/RequestKeyframe",
	"StreamService/CloseMedia",
	"PresenceService/Join",
];

/** The viewer's address, if it is exactly the adapter's for one launch at `viewerOrigin`: `/<launch>/viewer/#ticket=<43>&clipboard=0`. */
export function viewerAddress(viewer: unknown, viewerOrigin: string): { url: string; launchId: string; ticket: string } | null {
	if (typeof viewer !== "string" || !URL.canParse(viewer)) return null;
	const url = new URL(viewer);
	const path = new RegExp(`^/(${LAUNCH_ID})/viewer/$`).exec(url.pathname);
	const hash = /^#ticket=([A-Za-z0-9_-]{43})&clipboard=0$/.exec(url.hash);
	if (url.href !== viewer || url.origin !== viewerOrigin || url.search !== "" || url.username !== "" || url.password !== "" || !path || !hash) return null;
	return { url: viewer, launchId: path[1]!, ticket: hash[1]! };
}

/** Whether the viewer's page may make this request: the launch's own files (GET or HEAD) and view-only calls (POST), at the viewer's origin, with no query. */
export function viewerMayRequest(rawUrl: string, method: string, viewerOrigin: string, launchId: string): boolean {
	if (!URL.canParse(rawUrl) || !new RegExp(`^${LAUNCH_ID}$`).test(launchId)) return false;
	const url = new URL(rawUrl);
	if (url.origin !== viewerOrigin || url.search !== "" || url.username !== "" || url.password !== "") return false;
	const prefix = `/${launchId}/`;
	if (!url.pathname.startsWith(prefix)) return false;
	const rest = url.pathname.slice(prefix.length);
	if (rest.startsWith("viewer/")) return (method === "GET" || method === "HEAD") && VIEWER_FILES.includes(rest.slice("viewer/".length));
	if (rest.startsWith("cua.env.v1.")) return method === "POST" && VIEWER_CALLS.includes(rest.slice("cua.env.v1.".length));
	return false;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a page's WebSocket is the launch's media socket: `wss://<viewer host>/<launch>/media?ticket=<attach token>`, exactly. */
export function viewerMaySocket(rawUrl: string, viewerOrigin: string, launchId: string): boolean {
	if (!new RegExp(`^${LAUNCH_ID}$`).test(launchId)) return false;
	const socketOrigin = `wss://${new URL(viewerOrigin).host}`;
	return new RegExp(`^${escape(socketOrigin)}/${launchId}/media\\?ticket=[A-Za-z0-9_-]{43}$`).test(rawUrl);
}

/** Whether a message from the page may go up the media socket: only the view-only relay's keyframe request and frame acknowledgement, as text. */
export function mayGoUp(message: SocketMessage): boolean {
	if (typeof message !== "string" || new TextEncoder().encode(message).length > MAX_UP_BYTES) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(message);
	} catch {
		return false;
	}
	const m = parsed as { type?: unknown; payload?: Record<string, unknown> } | null;
	const p = m?.payload;
	if (!m || typeof m !== "object" || Object.keys(m).sort().join() !== "payload,type" || !p || typeof p !== "object" || typeof p.session_id !== "string") return false;
	const keys = Object.keys(p).sort().join();
	if (m.type === "request_keyframe") return keys === "session_id";
	return m.type === "frame_ack" && keys === "decode_queue,sequence,session_id" && Number.isSafeInteger(p.sequence) && Number.isSafeInteger(p.decode_queue);
}

/** A control message from the relay: its type and payload, unwrapping the `{direction, message}` form, as the adapter reads them. */
function control(text: string): { type: string; payload: Record<string, unknown> } | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	let o = value as Record<string, unknown> | null;
	if (o && typeof o === "object" && "direction" in o) o = o.direction === "server" ? (o.message as Record<string, unknown>) : null;
	if (!o || typeof o !== "object" || typeof o.type !== "string") return undefined;
	return { type: o.type, payload: o.payload && typeof o.payload === "object" ? (o.payload as Record<string, unknown>) : {} };
}

// --- The one-use run ------------------------------------------------------------

/**
 * The run's own order: launch once, then end once, and only after a launch
 * that certainly opened. Anything else throws before a request is made.
 */
export class OneUseRun {
	#phase: "ready" | "launching" | "launched" | "ending" | "over" = "ready";

	get phase(): string {
		return this.#phase;
	}

	launch(): void {
		if (this.#phase !== "ready") throw new AgentPreviewError("one-use", "This run has launched already; it launches once.");
		this.#phase = "launching";
	}

	launched(): void {
		if (this.#phase !== "launching") throw new AgentPreviewError("one-use", "Only a launch in progress can be recorded as open.");
		this.#phase = "launched";
	}

	end(): void {
		if (this.#phase !== "launched") throw new AgentPreviewError("one-use", "Only a run whose launch certainly opened ends, and only once.");
		this.#phase = "ending";
	}

	stop(): void {
		this.#phase = "over";
	}
}

export type Outcome = "qualified" | "viewer-failed" | "launch-refused" | "launch-uncertain" | "end-refused" | "end-uncertain" | "expired";
export type ViewerFailure = "address" | "page" | "redirect" | "no-stream" | "not-view-only" | "upward" | "cookie";

export interface ViewerEvidence {
	loaded: boolean;
	failure: ViewerFailure | null;
	mediaSockets: number;
	sessionOpened: boolean;
	viewOnly: boolean;
	packets: number;
	refusedRequests: number;
	refusedSockets: number;
	refusedMessages: number;
}

/** What the run reports: fixed words, counts and statuses, and the fresh observation's ID. Never a secret, an address or a body. */
export interface EvaluationReport {
	outcome: Outcome;
	launch: { status: number | null; phase: string | null; observation: { id: string; notAfter: number } | null; deadline: string | null };
	viewer: ViewerEvidence | null;
	end: { sent: boolean; status: number | null; phase: string | null; observationStatus: string | null } | null;
}

export interface EvaluateOptions {
	/** Absolute path of the 0600 input in the operator's 0700 directory. */
	configFile: string;
	/** Pim's origin and the viewer's, as the operator names them; each must equal the file's. */
	origin: string;
	viewerOrigin: string;
	/** The evaluation's deadline in Unix milliseconds. */
	deadline: number;
	launcher: EvaluatorLauncher;
	clock?: Clock;
	/** How long the viewer is watched for a frame; tests shorten it. */
	observeMs?: number;
}

const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

const LAUNCH_PHASES = ["launch_refused", "launch_uncertain", "launching", "open", "expired", "ending", "ended", "end_refused", "end_uncertain"];
/** Statuses the Worker answers only before it has claimed the grant's run or asked the space anything, or for a launch the space started nothing for. */
const NOTHING_LAUNCHED = [401, 403, 404, 405, 409, 429];
const NOTHING_ENDED = [401, 403, 404, 405, 409, 429];
const OBSERVATION_STATUSES = ["pending_open", "open", "revoking", "unconfirmed", "closed_observed", "not_opened", "reconciled"];

/** The launch's answer, read strictly: open with everything the run needs, refused (nothing started), or uncertain. */
function readLaunch(status: number, body: unknown, now: number): { kind: "open"; id: string; notAfter: number; deadline: number; runToken: string; viewer: unknown } | { kind: "refused" | "uncertain"; phase: string | null } {
	const answer = body as { run?: { phase?: unknown; deadline?: unknown; observation?: { id?: unknown; status?: unknown; notAfter?: unknown } }; viewer?: unknown; runToken?: unknown } | null;
	const phase = typeof answer?.run?.phase === "string" && LAUNCH_PHASES.includes(answer.run.phase) ? answer.run.phase : null;
	if (status === 201 && answer && typeof answer === "object" && phase === "open") {
		const { deadline, observation } = answer.run!;
		const ends = typeof deadline === "string" && ISO.test(deadline) ? Date.parse(deadline) : Number.NaN;
		const id = observation?.id;
		if (
			typeof id === "string" &&
			OBSERVATION_ID.test(id) &&
			observation?.status === "open" &&
			typeof observation.notAfter === "number" &&
			Number.isFinite(observation.notAfter) &&
			Number.isFinite(ends) &&
			ends > now &&
			ends <= now + MAX_RUN_MS + SKEW_MS &&
			typeof answer.runToken === "string" &&
			CREDENTIAL.test(answer.runToken)
		) {
			return { kind: "open", id, notAfter: observation.notAfter, deadline: ends, runToken: answer.runToken, viewer: answer.viewer };
		}
		return { kind: "uncertain", phase };
	}
	// A refusal before anything was claimed or asked, a grant already spent, or a space that started nothing; `launch_uncertain` never counts as one.
	if (NOTHING_LAUNCHED.includes(status) && phase !== "launch_uncertain" && phase !== "open") return { kind: "refused", phase };
	return { kind: "uncertain", phase };
}

/**
 * Runs the one evaluation. Problems before the launch is sent (the file, the
 * origins, the deadline, the browser) throw an `AgentPreviewError` and launch
 * nothing. From the launch on, it returns a report, and the browser is
 * always closed.
 */
export async function evaluateLaunch(options: EvaluateOptions): Promise<EvaluationReport> {
	const clock = options.clock ?? realClock;
	const config = parseEvaluatorConfig(readProtectedFile(options.configFile));
	if (config.origin !== options.origin || config.viewerOrigin !== options.viewerOrigin) throw new AgentPreviewError("config", "The configuration file is for another origin.");
	const startedAt = clock.now();
	const clientDeadline = Math.min(options.deadline, startedAt + MAX_RUN_MS);
	if (!Number.isFinite(clientDeadline) || clientDeadline - startedAt < MIN_START_MS) throw new AgentPreviewError("deadline", "The run needs at least two minutes before its deadline; nothing was launched.");
	const browser = await options.launcher.launch().catch(() => {
		throw new AgentPreviewError("launch", "The browser could not be launched; nothing was launched.");
	});

	let context: EvaluatorContext | undefined;
	let closed = false;
	const closeAll = async () => {
		if (closed) return;
		closed = true;
		await context?.close().catch(() => undefined);
		await browser.close().catch(() => undefined);
	};
	const hardStop = clock.setTimeout(() => void closeAll(), Math.max(0, clientDeadline - startedAt));

	const run = new OneUseRun();
	const secrets: string[] = [config.credential];
	const viewing = { on: false, launchId: "", requests: 0, sockets: 0 };
	const evidence: ViewerEvidence = { loaded: false, failure: null, mediaSockets: 0, sessionOpened: false, viewOnly: false, packets: 0, refusedRequests: 0, refusedSockets: 0, refusedMessages: 0 };
	let settleViewer: () => void = () => undefined;
	const fail = (failure: ViewerFailure) => {
		evidence.failure ??= failure;
		settleViewer();
	};

	try {
		try {
			context = await browser.newContext(CONTEXT_OPTIONS);
			await context.addInitScript({ content: HARDENING });
			// Installed before any page exists. Every socket is answered here; only the new launch's media socket, while the viewer step runs, is connected.
			await context.routeWebSocket(/.*/, (ws) => {
				if (!viewing.on || !viewerMaySocket(ws.url(), config.viewerOrigin, viewing.launchId) || viewing.sockets >= MAX_MEDIA_SOCKETS) {
					evidence.refusedSockets++;
					void ws.close({ code: 1008, reason: "not this viewer" });
					return;
				}
				viewing.sockets++;
				evidence.mediaSockets++;
				const server = ws.connectToServer();
				const shut = () => {
					void ws.close({ code: 1008, reason: "view only" });
					void server.close({ code: 1008, reason: "view only" });
				};
				ws.onMessage((message) => {
					if (viewing.on && mayGoUp(message)) return server.send(message);
					shut();
					if (!viewing.on) return;
					evidence.refusedMessages++;
					fail("upward");
				});
				server.onMessage((message) => {
					if (!viewing.on) return shut();
					if (typeof message === "string") {
						const m = control(message);
						if (m?.type === "session_opened") {
							const p = m.payload;
							if (p.policy !== "view_only" || (p.geometry_control !== undefined && p.geometry_control !== "observe_only")) {
								shut();
								return fail("not-view-only");
							}
							evidence.sessionOpened = true;
							evidence.viewOnly = true;
						}
					} else if (evidence.sessionOpened) {
						evidence.packets++;
						settleViewer();
					}
					ws.send(message);
				});
			});
			await context.route("**/*", async (route) => {
				const request = route.request();
				if (viewing.on && viewerMayRequest(request.url(), request.method(), config.viewerOrigin, viewing.launchId) && ++viewing.requests <= MAX_BROWSER_REQUESTS) {
					await route.continue().catch(() => undefined);
				} else {
					evidence.refusedRequests++;
					await route.abort("blockedbyclient").catch(() => undefined);
				}
			});
		} catch {
			throw new AgentPreviewError("harness", "The browser context could not be prepared; nothing was launched.");
		}

		// 1. The one launch.
		run.launch();
		const identity = { owner: config.owner, evaluation: config.evaluation, deployment: config.deployment };
		const headers = { authorization: `${EVALUATOR_SCHEME} ${config.credential}`, origin: config.origin, "content-type": "application/json" };
		let status: number;
		let body: unknown;
		try {
			const response = await context.request.post(`${config.origin}${LAUNCH_PATH}`, { headers, data: identity, maxRedirects: 0, failOnStatusCode: false, timeout: REQUEST_TIMEOUT_MS });
			status = response.status();
			body = await response.json().catch(() => null);
		} catch {
			run.stop();
			return scrub({ outcome: "launch-uncertain", launch: { status: null, phase: null, observation: null, deadline: null }, viewer: null, end: null }, secrets);
		}
		const launched = readLaunch(status, body, clock.now());
		if (launched.kind !== "open") {
			run.stop();
			return scrub({ outcome: launched.kind === "refused" ? "launch-refused" : "launch-uncertain", launch: { status, phase: launched.phase, observation: null, deadline: null }, viewer: null, end: null }, secrets);
		}
		run.launched();
		secrets.push(launched.runToken);
		const endBy = Math.min(launched.deadline, clientDeadline);
		const launch = { status, phase: "open", observation: { id: launched.id, notAfter: launched.notAfter }, deadline: new Date(launched.deadline).toISOString() };

		// 2. The viewer, for the new launch only. Any failure here still goes on to the End.
		const address = viewerAddress(launched.viewer, config.viewerOrigin);
		if (typeof launched.viewer === "string") secrets.push(launched.viewer);
		if (!address) fail("address");
		else {
			secrets.push(address.ticket);
			const stopAt = endBy - END_RESERVE_MS;
			let page: EvaluatorPage | undefined;
			viewing.launchId = address.launchId;
			viewing.on = true;
			try {
				page = await context.newPage();
				await page.goto(address.url, { timeout: REQUEST_TIMEOUT_MS, waitUntil: "load" });
				if (!URL.canParse(page.url()) || new URL(page.url()).origin !== config.viewerOrigin) fail("redirect");
				else {
					evidence.loaded = true;
					if (!(evidence.sessionOpened && evidence.packets > 0) && evidence.failure === null) {
						let timer: unknown;
						await new Promise<void>((resolve) => {
							settleViewer = resolve;
							timer = clock.setTimeout(resolve, Math.max(0, Math.min(options.observeMs ?? OBSERVE_MS, stopAt - clock.now())));
						});
						clock.clearTimeout(timer);
					}
					if (evidence.failure === null && !(evidence.sessionOpened && evidence.packets > 0)) fail("no-stream");
				}
			} catch {
				fail("page");
			} finally {
				viewing.on = false;
				settleViewer = () => undefined;
				await page?.close().catch(() => undefined);
			}
		}
		// Nothing the evaluator does signs it in: the context must hold no cookie at all.
		if (!closed && (await context.cookies().catch(() => [null])).length !== 0) fail("cookie");

		// 3. The one End, of the launch's own ID, while the run's deadline allows.
		if (closed || clock.now() >= endBy) {
			run.stop();
			return scrub({ outcome: "expired", launch, viewer: evidence, end: { sent: false, status: null, phase: null, observationStatus: null } }, secrets);
		}
		run.end();
		let endStatus: number;
		let endBody: unknown;
		try {
			const response = await context.request.post(`${config.origin}${END_PATH}`, {
				headers: { ...headers, [RUN_HEADER]: launched.runToken },
				data: { ...identity, observation: launched.id },
				maxRedirects: 0,
				failOnStatusCode: false,
				timeout: REQUEST_TIMEOUT_MS,
			});
			endStatus = response.status();
			endBody = await response.json().catch(() => null);
		} catch {
			run.stop();
			return scrub({ outcome: "end-uncertain", launch, viewer: evidence, end: { sent: true, status: null, phase: null, observationStatus: null } }, secrets);
		}
		run.stop();
		const answered = (endBody as { run?: { phase?: unknown; observation?: { id?: unknown; status?: unknown } } } | null)?.run;
		const endPhase = typeof answered?.phase === "string" && LAUNCH_PHASES.includes(answered.phase) ? answered.phase : null;
		const observationStatus = typeof answered?.observation?.status === "string" && OBSERVATION_STATUSES.includes(answered.observation.status) ? answered.observation.status : null;
		const end = { sent: true, status: endStatus, phase: endPhase, observationStatus };
		if ((endStatus === 200 || endStatus === 202) && endPhase === "ended" && answered?.observation?.id === launched.id) {
			const qualified = evidence.failure === null && evidence.loaded && evidence.sessionOpened && evidence.viewOnly && evidence.packets > 0;
			return scrub({ outcome: qualified ? "qualified" : "viewer-failed", launch, viewer: evidence, end }, secrets);
		}
		const refused = NOTHING_ENDED.includes(endStatus) || endPhase === "end_refused";
		return scrub({ outcome: refused && endPhase !== "end_uncertain" ? "end-refused" : "end-uncertain", launch, viewer: evidence, end }, secrets);
	} finally {
		clock.clearTimeout(hardStop);
		await closeAll();
	}
}

/** The report, checked last for any secret the run held; one found is replaced, though by construction none is there. */
function scrub(report: EvaluationReport, secrets: readonly string[]): EvaluationReport {
	const text = JSON.stringify(report);
	const clean = secrets.filter((secret) => secret.length > 0).reduce((out, secret) => out.split(secret).join("[redacted]"), text);
	return clean === text ? report : (JSON.parse(clean) as EvaluationReport);
}
