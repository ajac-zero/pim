/**
 * The operator's harness for an unsafe, agent-driven preview
 * (docs/agent-preview.md): it signs one agent in to the preview's web app
 * and API, with no human operating a passkey, in a Playwright isolated
 * BrowserContext. The context's own `request` object shares the context's
 * cookie jar, so one exchange gives both: the credential is POSTed once with
 * `context.request`, the Worker's Secure HttpOnly cookie lands in the
 * context's memory, and the same context then reads the API and navigates
 * the UI with it. The harness only checks that cookie's attributes; it never
 * stores it.
 *
 * What this file does not do: decide the authentication protocol. The
 * exchange route, its request and its answer belong to the Worker's auth
 * (the `ExchangeAdapter` below is the whole interface; agent-preview-automation.ts is the one implementation).
 * It launches nothing when imported. Tests give it fake Playwright objects.
 *
 * What it holds to:
 * - One configuration file (the credential among its fields), read from a regular file of this account's, mode 0600,
 *   one link, in a directory of this account's, mode 0700. Never from the
 *   environment, an argument, a URL, or the chat.
 * - One origin, exactly as configured (https, no path). The exchange and
 *   every request go to it; a redirect is an error, and the context aborts
 *   any browser request to another origin.
 * - A new, private context for the run: no saved state, no profile, no
 *   service workers, no downloads, no video or trace, and no
 *   `storageState` method on the session. Nothing of the human's browser.
 * - A session that lasts at most 30 minutes and never past the deadline,
 *   closed by a timer, and closed at the first refused request.
 * - One attempt to authenticate. A failure closes everything and is
 *   reported without the credential, a cookie, a path or a response body.
 * - Reading only: the session has one `GET` of the observation list and a
 *   read-only page. It has no Watch, End, setup or enrollment, no read of a
 *   single observation (the Worker's `GET /api/observations/<id>` asks the
 *   computer and may change the ledger). The context aborts every browser
 *   request but an allowlist (the app's shell, its static files and
 *   `/auth/session`, GET or HEAD, no query; no `/api` at all) and answers
 *   every WebSocket itself, without connecting it to the server, before any
 *   page loads.
 * - Bounds: the session makes at most 50 API reads and page loads, and lets
 *   its pages make at most 300 browser requests (subresources included); a
 *   request over either bound is refused. Time bounds the rest.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

/** The longest a session lasts, whatever the Worker allows. */
export const MAX_SESSION_MS = 30 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** The most API reads and page loads one session makes before it closes itself. */
export const MAX_REQUESTS = 50;
/** The most requests, subresources included, the browser's pages may make in one session; the rest are aborted. */
export const MAX_BROWSER_REQUESTS = 300;
/** The one Playwright release this harness is written for (`routeWebSocket` needs 1.48 or later). */
export const PLAYWRIGHT_VERSION = "1.59.1";
const MAX_CONFIG_BYTES = 4096;
/** How far past the session's end a cookie's own expiry may be, for clocks that differ a little. */
const COOKIE_SKEW_MS = 5_000;

/** Every failure: a fixed code and a fixed sentence, never data from a response, a file or an argument. */
export class AgentPreviewError extends Error {
	readonly code: string;
	readonly status: number | undefined;
	constructor(code: string, message: string, status?: number) {
		super(message);
		this.name = "AgentPreviewError";
		this.code = code;
		this.status = status;
	}
}

// --- The adapter the Worker's auth supplies ----------------------------------

/**
 * The Worker's exchange, as the auth branch defines it
 * (agent-preview-automation.ts is the one adapter). It holds the credential
 * itself, so the harness never handles it except to scrub it from output.
 */
export interface ExchangeAdapter {
	/** The exchange route's path on the configured origin. A path only: no query, no origin. */
	readonly path: string;
	/** The one cookie the exchange must leave in the context, by name. */
	readonly cookieName: string;
	/** The exchange's headers and JSON body. The credential goes only here, and only in a POST. */
	request(): { headers?: Record<string, string>; data?: unknown };
	/** The session's end in Unix milliseconds if the Worker accepted the exchange; `null` if it refused. */
	accept(status: number, body: unknown): { expiresAt: number } | null;
}

/** What a configuration file gives the harness: the origin, the adapter for it, and every secret in it, to scrub from output. */
export interface ParsedConfig {
	origin: string;
	adapter: ExchangeAdapter;
	secrets: readonly string[];
}

// --- The parts of Playwright used (structural, so tests can fake them) --------

export interface ApiResponse {
	status(): number;
	json(): Promise<unknown>;
}
export interface RequestOptions {
	headers?: Record<string, string>;
	data?: unknown;
	maxRedirects: 0;
	failOnStatusCode: false;
	timeout: number;
}
export interface ApiContext {
	post(url: string, options: RequestOptions): Promise<ApiResponse>;
	get(url: string, options: RequestOptions): Promise<ApiResponse>;
}
export interface BrowserCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	/** Seconds since the epoch; -1 for a session cookie. */
	expires: number;
	httpOnly: boolean;
	secure: boolean;
	sameSite?: string;
}
export interface BrowserRoute {
	request(): { url(): string; method(): string };
	abort(errorCode?: string): Promise<void>;
	continue(): Promise<void>;
}
export interface WebSocketRoute {
	close(options?: { code?: number; reason?: string }): Promise<void> | void;
}
export interface BrowserPage {
	goto(url: string, options: { timeout: number; waitUntil: "load" }): Promise<unknown>;
	url(): string;
	title(): Promise<string>;
	locator(selector: string): { first(): { textContent(options: { timeout: number }): Promise<string | null> } };
	close(): Promise<void>;
}
export interface BrowserContext {
	readonly request: ApiContext;
	cookies(urls: string): Promise<BrowserCookie[]>;
	route(url: string, handler: (route: BrowserRoute) => Promise<void> | void): Promise<void>;
	routeWebSocket(url: string | RegExp, handler: (ws: WebSocketRoute) => Promise<void> | void): Promise<void>;
	newPage(): Promise<BrowserPage>;
	close(): Promise<void>;
}
/** Every option the context is made with. There is no `storageState`, `recordHar`, `recordVideo`, `userDataDir` or extra headers. */
export interface ContextOptions {
	acceptDownloads: false;
	serviceWorkers: "block";
	ignoreHTTPSErrors: false;
	bypassCSP: false;
	javaScriptEnabled: true;
	permissions: [];
	baseURL: string;
}
export interface Browser {
	newContext(options: ContextOptions): Promise<BrowserContext>;
	close(): Promise<void>;
}
interface Chromium {
	launch(options: { headless: true; channel?: BrowserChannel }): Promise<Browser>;
}
export interface BrowserLauncher {
	launch(): Promise<Browser>;
}

/**
 * The only alternative to Playwright's bundled Chromium: the operating system's
 * Google Chrome Stable, chosen by Playwright's `channel: "chrome"`. There is no
 * executable path, launch argument or other channel.
 */
export type BrowserChannel = "chrome";

/**
 * Playwright's own Chromium (or, only when `channel` is exactly "chrome", the
 * system Google Chrome Stable), a fresh browser launched headless for this run,
 * never attached to a human's browser (`connectOverCDP`) or profile
 * (`launchPersistentContext`). Playwright is not a dependency of this
 * repository: the operator installs exactly `PLAYWRIGHT_VERSION` in a
 * directory of their own (docs/agent-preview.md), and this loads it from
 * there, refusing any other version. A failure says only that the launch
 * failed: Playwright's errors carry paths and environment. No test launches
 * a real browser.
 */
export function playwrightChromium(runtimeDir: string, channel?: BrowserChannel): BrowserLauncher {
	return {
		async launch() {
			try {
				const dir = path.join(runtimeDir, "node_modules", "playwright");
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown };
				if (pkg.version !== PLAYWRIGHT_VERSION) throw new Error("version");
				const entry = createRequire(path.join(runtimeDir, "package.json")).resolve("playwright");
				const playwright = (await import(pathToFileURL(entry).href)) as { chromium?: Chromium; default?: { chromium?: Chromium } };
				const chromium = playwright.chromium ?? playwright.default?.chromium;
				if (!chromium) throw new Error("chromium");
				if (channel === undefined) return await chromium.launch({ headless: true });
				if (channel !== "chrome") throw new Error("channel");
				return await chromium.launch({ headless: true, channel: "chrome" });
			} catch {
				throw new AgentPreviewError("launch", `The browser could not be launched; it needs Playwright ${PLAYWRIGHT_VERSION} installed in the runtime directory, and with a browser channel, a compatible system Chrome.`);
			}
		},
	};
}

// --- Origin and credential ----------------------------------------------------

/** The configured origin, only if it is exactly an `https` origin: no path, query, fragment or user. */
export function exactOrigin(configured: string): string {
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw new AgentPreviewError("origin", "The preview origin is not a URL.");
	}
	if (url.protocol !== "https:" || url.origin !== configured || url.username || url.password) {
		throw new AgentPreviewError("origin", "The preview origin must be exactly an https origin, such as https://host.example.");
	}
	return url.origin;
}

/**
 * Reads the protected configuration file, and nothing else: an absolute,
 * normalized path; a directory of this account's with mode 0700, not a link;
 * a regular file of this account's with mode 0600 and one link, opened
 * without following a link; 1 to 4096 bytes of UTF-8. Errors say what is
 * wrong, never the path or content. What the text means is the adapter's.
 */
export function readProtectedFile(file: string): string {
	const refuse = (why: string): never => {
		throw new AgentPreviewError("config-file", `The configuration file is not usable: ${why}.`);
	};
	if (!path.isAbsolute(file) || path.normalize(file) !== file) return refuse("its path is not absolute and normalized");
	const uid = process.getuid?.();
	let fd: number | undefined;
	try {
		const dir = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
		if (!dir || !dir.isDirectory()) return refuse("its directory is missing or a link");
		if ((dir.mode & 0o777) !== 0o700 || dir.uid !== uid) return refuse("its directory is not this account's with mode 0700");
		const link = fs.lstatSync(file, { throwIfNoEntry: false });
		if (!link || !link.isFile()) return refuse("it is missing, not a regular file or a link");
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid) return refuse("it is not this account's with one link");
		if ((stat.mode & 0o777) !== 0o600) return refuse("its mode is not 0600");
		if (stat.size === 0 || stat.size > MAX_CONFIG_BYTES) return refuse("its size is not within bounds");
		return fs.readFileSync(fd, "utf8");
	} catch (error) {
		if (error instanceof AgentPreviewError) throw error;
		return refuse("it could not be read");
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				// Nothing was written; the descriptor goes at exit.
			}
		}
	}
}

// --- The session --------------------------------------------------------------

export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
const realClock: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export interface OpenOptions {
	/** Absolute path of the 0600 configuration file in the 0700 operator directory. */
	configFile: string;
	/** Makes sense of the file: the origin, the adapter and the secrets (agent-preview-automation.ts's `parseAutomationConfig`). */
	parse(text: string): ParsedConfig;
	/** The evaluation's deadline in Unix milliseconds; the session never outlasts it. */
	deadline: number;
	/** Playwright, from its runtime directory (`playwrightChromium(dir)`); tests give fakes. */
	launcher: BrowserLauncher;
	clock?: Clock;
}

/** What the harness may say about a session: nothing secret. */
export interface SessionMetadata {
	origin: string;
	expiresAt: string;
	requestsLeft: number;
}

/**
 * An observation as the Worker lists it (`ObservationView`, src/cua-observation-runtime.ts):
 * its id, status, deadline and the evidence its last change was recorded with.
 * The Worker deliberately omits the host's launch, generation and viewer path,
 * so nothing here says whether the host holds anything.
 */
export interface ObservationSummary {
	id: string;
	status: string;
	notAfter: number;
	/** The Worker's own evidence text, redacted and capped; null if it has none. */
	evidence: string | null;
	/** The reason in "… was lost (<reason>)" evidence: how the host's answer failed. */
	lostReason: "timeout" | "unreachable" | "status" | "malformed" | "redirect" | null;
}
export interface ObservationsReport {
	status: number;
	blocked: string | null;
	observations: ObservationSummary[];
}

const STATUSES = ["pending_open", "open", "revoking", "unconfirmed", "closed_observed", "not_opened", "reconciled"];
const OBSERVATION_ID = /^[A-Za-z0-9_-]{16,64}$/;
const LOST = /\blost \((timeout|unreachable|status|malformed|redirect)\)/;
const MAX_EVIDENCE_CHARS = 300;

/** The observation list: the one route read. (One record's route asks the computer, and may change the ledger.) */
const OBSERVATION_LIST = "/api/observations";

/**
 * The only requests a page may make: the app's own shell, its static files and
 * the session answer that feeds the banner, with no query. Everything else,
 * `/api` included (the observation list is read by `context.request`, which
 * routes don't govern; a record's status is never read), is aborted before
 * it reaches the server.
 */
const PAGE_FILES = ["/", "/auth/session", "/favicon.svg", "/manifest.webmanifest", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];
const PAGE_ASSET = /^\/assets\/[A-Za-z0-9._~-]+\.(?:js|css|woff2?|svg|png|webp|ico|json)$/;
export function pageMayRequest(rawUrl: string, method: string, origin: string): boolean {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return false;
	}
	if (url.origin !== origin || url.search !== "" || url.hash !== "" || !["GET", "HEAD"].includes(method)) return false;
	return PAGE_FILES.includes(url.pathname) || PAGE_ASSET.test(url.pathname);
}

export class AgentPreviewSession {
	readonly #origin: string;
	readonly #context: BrowserContext;
	readonly #browser: Browser;
	readonly #clock: Clock;
	readonly #secrets: readonly string[];
	readonly #expiresAt: number;
	readonly #timer: unknown;
	#requests = 0;
	#closed = false;

	constructor(origin: string, context: BrowserContext, browser: Browser, clock: Clock, secrets: readonly string[], expiresAt: number) {
		this.#origin = origin;
		this.#context = context;
		this.#browser = browser;
		this.#clock = clock;
		this.#secrets = secrets;
		this.#expiresAt = expiresAt;
		this.#timer = clock.setTimeout(() => void this.close(), Math.max(0, expiresAt - clock.now()));
	}

	/** Metadata only: no cookie, credential or storage state. */
	metadata(): SessionMetadata {
		return { origin: this.#origin, expiresAt: new Date(this.#expiresAt).toISOString(), requestsLeft: Math.max(0, MAX_REQUESTS - this.#requests) };
	}

	/** Replaces this session's secrets in `text`, for anything that is about to be shown. */
	redact(text: string): string {
		return this.#secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
	}

	/**
	 * `GET /api/observations`: the first request. Read only: no query, no body,
	 * and no other method or route exists here. Each record is checked against
	 * the Worker's `ObservationView`; one that doesn't fit closes the session
	 * rather than being guessed at.
	 */
	async observations(): Promise<ObservationsReport> {
		const body = await this.#get(OBSERVATION_LIST);
		const record = body as { blocked?: unknown; observations?: unknown } | null;
		if (!record || typeof record !== "object" || !Array.isArray(record.observations) || (record.blocked !== null && typeof record.blocked !== "string")) return this.#end("malformed", "The preview's observation list isn't in the expected shape; the session is closed.");
		const observations: ObservationSummary[] = [];
		for (const raw of record.observations as unknown[]) {
			const one = raw as Record<string, unknown> | null;
			if (!one || typeof one !== "object" || typeof one.id !== "string" || !OBSERVATION_ID.test(one.id) || typeof one.status !== "string" || !STATUSES.includes(one.status) || typeof one.notAfter !== "number" || !Number.isFinite(one.notAfter) || (one.evidence !== null && typeof one.evidence !== "string")) {
				return this.#end("malformed", "An observation isn't in the expected shape; the session is closed.");
			}
			const evidence = typeof one.evidence === "string" ? this.redact(one.evidence).slice(0, MAX_EVIDENCE_CHARS) : null;
			observations.push({ id: one.id, status: one.status, notAfter: one.notAfter, evidence, lostReason: (evidence === null ? null : LOST.exec(evidence)?.[1]) as ObservationSummary["lostReason"] ?? null });
		}
		return { status: 200, blocked: typeof record.blocked === "string" ? this.redact(record.blocked).slice(0, MAX_EVIDENCE_CHARS) : null, observations };
	}

	/**
	 * Loads one page of the app in the session's context, reads its title and
	 * the preview banner's text, and closes the page. A page is read only
	 * here: the context aborts any request that isn't a GET or HEAD, and
	 * answers WebSockets itself. Any failure closes the session.
	 */
	async inspectPage(pagePath: string): Promise<{ path: string; title: string; banner: string | null }> {
		if (pagePath !== "/") throw new AgentPreviewError("path", "Only the app's root page is loaded.");
		this.#spend();
		let page: BrowserPage | undefined;
		try {
			page = await this.#context.newPage();
			await page.goto(`${this.#origin}${pagePath}`, { timeout: REQUEST_TIMEOUT_MS, waitUntil: "load" });
			if (new URL(page.url()).origin !== this.#origin) return await this.#end("redirect", "The page left the preview's origin; the session is closed.");
			const banner = await page.locator("[data-agent-preview-banner]").first().textContent({ timeout: 2_000 }).catch(() => null);
			return { path: pagePath, title: this.redact(await page.title()), banner: banner === null ? null : this.redact(banner).slice(0, 200) };
		} catch (error) {
			if (error instanceof AgentPreviewError) throw error;
			return await this.#end("page", "The page could not be loaded; the session is closed and nothing is retried.");
		} finally {
			await page?.close().catch(() => undefined);
		}
	}

	/** Ends the session: its timer, its context (and with it the cookie) and its browser. Safe to call twice. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#clock.clearTimeout(this.#timer);
		await this.#context.close().catch(() => undefined);
		await this.#browser.close().catch(() => undefined);
	}

	#spend(): void {
		if (this.#closed) throw new AgentPreviewError("closed", "The session is closed.");
		if (this.#clock.now() >= this.#expiresAt) {
			void this.close();
			throw new AgentPreviewError("expired", "The session has expired.");
		}
		if (++this.#requests > MAX_REQUESTS) {
			void this.close();
			throw new AgentPreviewError("limit", "The session's request limit is spent.");
		}
	}

	/** Closes the session, then throws the one fixed failure. */
	async #end(code: string, message: string, status?: number): Promise<never> {
		await this.close();
		throw new AgentPreviewError(code, message, status);
	}

	/** A GET with the context's cookie: no authorization header, no query, no redirect, no retry. Any answer but 200 closes the session. */
	async #get(route: string): Promise<unknown> {
		if (route !== OBSERVATION_LIST) throw new AgentPreviewError("path", "Only the observation list is read.");
		this.#spend();
		let response: ApiResponse;
		try {
			response = await this.#context.request.get(`${this.#origin}${route}`, { headers: { accept: "application/json" }, maxRedirects: 0, failOnStatusCode: false, timeout: REQUEST_TIMEOUT_MS });
		} catch {
			return this.#end("network", "The request failed; the session is closed and nothing is retried.");
		}
		const status = response.status();
		if (status >= 300 && status < 400) return this.#end("redirect", "The preview redirected; the session is closed.", status);
		if (status === 401 || status === 403) return this.#end("auth-refused", "The preview refused the session; it is closed and nothing is retried.", status);
		if (status !== 200) return this.#end("status", "The preview answered with an unexpected status; the session is closed.", status);
		return await response.json().catch(() => null);
	}
}

/**
 * Opens the one session: reads the configuration, validates the origin, makes
 * the private context, exchanges once through the context's own request
 * object, checks the cookie it set and the session's end, and returns the
 * session. Any failure closes what was made, once, and throws a redacted
 * `AgentPreviewError`. Nothing is retried.
 */
export async function openAgentPreview(options: OpenOptions): Promise<AgentPreviewSession> {
	const clock = options.clock ?? realClock;
	const text = readProtectedFile(options.configFile);
	let parsed: ParsedConfig;
	try {
		parsed = options.parse(text);
		exactOrigin(parsed.origin);
	} catch (error) {
		if (error instanceof AgentPreviewError) throw error;
		throw new AgentPreviewError("config", "The configuration file's content is not valid.");
	}
	const { origin, adapter, secrets: configured } = parsed;
	if (!adapter.path.startsWith("/") || adapter.path.startsWith("//") || /[?#]/.test(adapter.path)) {
		throw new AgentPreviewError("adapter", "The exchange path must be a plain path.");
	}
	const browser = await options.launcher.launch().catch(() => {
		throw new AgentPreviewError("launch", "The browser could not be launched.");
	});
	let context: BrowserContext | undefined;
	const fail = async (code: string, message: string, status?: number): Promise<never> => {
		await context?.close().catch(() => undefined);
		await browser.close().catch(() => undefined);
		throw new AgentPreviewError(code, message, status);
	};
	try {
		context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false, bypassCSP: false, javaScriptEnabled: true, permissions: [], baseURL: origin });
		// Installed before any page exists. A WebSocket is answered here and closed without `connectToServer`, so the page never reaches the server through one.
		await context.routeWebSocket(/.*/, (ws) => ws.close({ code: 1008, reason: "read only" }));
		let browserRequests = 0;
		await context.route("**/*", async (route) => {
			const request = route.request();
			if (pageMayRequest(request.url(), request.method(), origin) && ++browserRequests <= MAX_BROWSER_REQUESTS) await route.continue();
			else await route.abort("blockedbyclient");
		});
		const built = adapter.request();
		// A write to the Worker must name its own origin (src/cua-observation-runtime.ts), and Playwright's request context doesn't add one.
		const headers = { ...built.headers, origin };
		let response: ApiResponse;
		try {
			response = await context.request.post(`${origin}${adapter.path}`, { headers, data: built.data, maxRedirects: 0, failOnStatusCode: false, timeout: REQUEST_TIMEOUT_MS });
		} catch {
			return await fail("network", "The exchange could not be made; nothing is retried.");
		}
		const status = response.status();
		const accepted = adapter.accept(status, await response.json().catch(() => null));
		if (!accepted) return await fail("exchange-refused", "The preview did not accept the credential; nothing is retried.", status);
		const now = clock.now();
		if (!Number.isFinite(accepted.expiresAt) || accepted.expiresAt <= now || accepted.expiresAt > now + MAX_SESSION_MS || accepted.expiresAt > options.deadline) {
			return await fail("lifetime", "The session's end is already over, or past its deadline or 30 minutes.");
		}
		const cookies = await context.cookies(origin);
		const host = new URL(origin).hostname;
		const unsafe = (cookie: BrowserCookie) => cookie.name !== adapter.cookieName || !cookie.secure || !cookie.httpOnly || cookie.sameSite !== "Strict" || cookie.domain !== host || cookie.path !== "/" || (cookie.expires > 0 && cookie.expires * 1000 > accepted.expiresAt + COOKIE_SKEW_MS);
		if (cookies.length !== 1 || cookies.some(unsafe)) return await fail("cookie", "The exchange did not leave exactly the Secure HttpOnly SameSite=Strict host-only session cookie, ending with the session.");
		const secrets = [...configured, ...cookies.map((cookie) => cookie.value)].filter((value) => value.length > 0);
		return new AgentPreviewSession(origin, context, browser, clock, secrets, accepted.expiresAt);
	} catch (error) {
		if (error instanceof AgentPreviewError) throw error;
		return await fail("harness", "The harness failed before a session was made.");
	}
}

/**
 * The first live command: a read-only look at the existing observations and
 * at the app. One `GET /api/observations`, one page load of `/`. It starts,
 * ends and sets up nothing, and always closes the session.
 */
export async function diagnoseObservations(session: AgentPreviewSession): Promise<{ observations: ObservationsReport; ui: { path: string; title: string; banner: string | null } }> {
	try {
		const observations = await session.observations();
		const ui = await session.inspectPage("/");
		return { observations, ui };
	} finally {
		await session.close();
	}
}
