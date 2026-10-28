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
 * (the `ExchangeAdapter` below is the whole interface; no default exists).
 * It launches nothing when imported. Tests give it fake Playwright objects.
 *
 * What it holds to:
 * - One credential, read from a regular file of this account's, mode 0600,
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
 * - Reading only: the session has `GET`s of the observation routes and a
 *   read-only page. It has no Watch, End, setup or enrollment, and the
 *   context aborts a browser request that isn't a GET or HEAD.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The longest a session lasts, whatever the Worker allows. */
export const MAX_SESSION_MS = 30 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15_000;
/** The most requests and pages one session makes before it closes itself. */
export const MAX_REQUESTS = 50;
const MAX_CREDENTIAL_BYTES = 4096;
const MIN_CREDENTIAL_CHARS = 16;
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
 * The Worker's exchange, as the auth branch defines it. Expected to bind the
 * credential to the exact preview origin, the evaluation and the existing
 * owner, and to answer with a Secure HttpOnly cookie and its expiry. Until
 * that contract is supplied, no adapter exists and the harness cannot run.
 */
export interface ExchangeAdapter {
	/** The exchange route's path on the configured origin. A path only: no query, no origin. */
	readonly path: string;
	/** The exchange's headers and JSON body for this credential. It is the only place the credential goes, and only in a POST. */
	request(credential: string): { headers?: Record<string, string>; data?: unknown };
	/** The session's end in Unix milliseconds if the Worker accepted the exchange; `null` if it refused. */
	accept(status: number, body: unknown): { expiresAt: number } | null;
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
}
export interface BrowserRoute {
	request(): { url(): string; method(): string };
	abort(errorCode?: string): Promise<void>;
	continue(): Promise<void>;
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
export interface BrowserLauncher {
	launch(): Promise<Browser>;
}

/**
 * Playwright's own Chromium, a fresh browser launched headless for this run,
 * never attached to a human's browser (`connectOverCDP`) or profile
 * (`launchPersistentContext`). Playwright is not a dependency of this
 * repository: the operator installs it where the harness runs, and the
 * import is by name at call time. No test calls this.
 */
export const playwrightChromium: BrowserLauncher = {
	async launch() {
		const name = "playwright";
		const playwright = (await import(name)) as { chromium: { launch(options: { headless: true }): Promise<Browser> } };
		return playwright.chromium.launch({ headless: true });
	},
};

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
 * Reads the credential from `file`, and nothing else: an absolute, normalized
 * path; a directory of this account's with mode 0700, not a link; a regular
 * file of this account's with mode 0600 and one link, opened without
 * following a link; 16 to 4096 printable characters, with at most one line
 * end after them. Errors say what is wrong, never the path or content.
 */
export function readCredentialFile(file: string): string {
	const refuse = (why: string): never => {
		throw new AgentPreviewError("credential-file", `The credential file is not usable: ${why}.`);
	};
	if (!path.isAbsolute(file) || path.normalize(file) !== file) return refuse("its path is not absolute and normalized");
	const uid = process.getuid?.();
	const dir = fs.lstatSync(path.dirname(file), { throwIfNoEntry: false });
	if (!dir || !dir.isDirectory()) return refuse("its directory is missing or a link");
	if ((dir.mode & 0o777) !== 0o700 || dir.uid !== uid) return refuse("its directory is not this account's with mode 0700");
	const link = fs.lstatSync(file, { throwIfNoEntry: false });
	if (!link || !link.isFile()) return refuse("it is missing, not a regular file or a link");
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== uid) return refuse("it is not this account's with one link");
		if ((stat.mode & 0o777) !== 0o600) return refuse("its mode is not 0600");
		if (stat.size === 0 || stat.size > MAX_CREDENTIAL_BYTES) return refuse("its size is not within bounds");
		const text = fs.readFileSync(fd, "utf8").replace(/\r?\n$/, "");
		if (text.length < MIN_CREDENTIAL_CHARS || !/^[\x21-\x7e]+$/.test(text)) return refuse("its content is not one printable token");
		return text;
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
	/** The preview's origin, exactly as configured. */
	origin: string;
	/** Absolute path of the 0600 credential file in the 0700 operator directory. */
	credentialFile: string;
	adapter: ExchangeAdapter;
	/** The evaluation's deadline in Unix milliseconds; the session never outlasts it. */
	deadline: number;
	launcher?: BrowserLauncher;
	clock?: Clock;
}

/** What the harness may say about a session: nothing secret. */
export interface SessionMetadata {
	origin: string;
	expiresAt: string;
	requestsLeft: number;
}

/** An observation record as the harness reports it: where it stands, and not the host's launch identity. */
export interface ObservationSummary {
	observationId: string;
	status: string;
	notAfter: number | null;
	conflicting: boolean;
	hasHostLaunch: boolean;
}
export interface ObservationsReport {
	status: number;
	blocked: string | null;
	records: ObservationSummary[];
}

const summarize = (one: Record<string, unknown>): ObservationSummary => ({
	observationId: typeof one.observationId === "string" ? one.observationId : "?",
	status: typeof one.status === "string" ? one.status : "?",
	notAfter: typeof one.notAfter === "number" ? one.notAfter : null,
	conflicting: one.conflicting === true,
	hasHostLaunch: typeof one.hostLaunchId === "string",
});

/** The Worker's observation management routes (src/cua-observation-runtime.ts), the list and one record. */
const OBSERVATION_PATH = /^\/api\/observations(\/[A-Za-z0-9_-]{16,64})?$/;
const UI_PATH = /^\/[A-Za-z0-9._~\-/]*$/;

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

	/** `GET /api/observations`: the first request. Read only; no query, no body, and no other method exists here. */
	async observations(): Promise<ObservationsReport> {
		const { status, body } = await this.#get("/api/observations");
		const record = (body ?? {}) as { blocked?: unknown; observations?: unknown };
		const list = Array.isArray(record.observations) ? (record.observations as Record<string, unknown>[]) : [];
		return {
			status,
			blocked: typeof record.blocked === "string" ? this.redact(record.blocked).slice(0, 200) : null,
			records: list.map(summarize),
		};
	}

	/** `GET /api/observations/<id>`, for the status of one record. */
	async observation(id: string): Promise<ObservationSummary> {
		const { body } = await this.#get(`/api/observations/${id}`);
		return summarize((body ?? {}) as Record<string, unknown>);
	}

	/**
	 * Loads one page of the app in the session's context, reads its title and
	 * the preview banner's text, and closes the page. A page is read only
	 * here: the context aborts any request that isn't a GET or HEAD.
	 */
	async inspectPage(pagePath: string): Promise<{ path: string; title: string; banner: string | null }> {
		if (!UI_PATH.test(pagePath) || pagePath.startsWith("//") || pagePath.includes("..")) {
			throw new AgentPreviewError("path", "A page path is a plain path on the preview's origin.");
		}
		this.#spend();
		const page = await this.#context.newPage();
		try {
			await page.goto(`${this.#origin}${pagePath}`, { timeout: REQUEST_TIMEOUT_MS, waitUntil: "load" });
			if (new URL(page.url()).origin !== this.#origin) {
				await this.close();
				throw new AgentPreviewError("redirect", "The page left the preview's origin; the session is closed.");
			}
			const banner = await page.locator("[data-agent-preview-banner]").first().textContent({ timeout: 2_000 }).catch(() => null);
			return { path: pagePath, title: this.redact(await page.title()), banner: banner === null ? null : this.redact(banner).slice(0, 200) };
		} finally {
			await page.close().catch(() => undefined);
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

	/** A GET of an observation route with the context's cookie: no authorization header, no query, no redirect, no retry. */
	async #get(route: string): Promise<{ status: number; body: unknown }> {
		if (!OBSERVATION_PATH.test(route)) throw new AgentPreviewError("path", "Only the observation routes are read.");
		this.#spend();
		let response: ApiResponse;
		try {
			response = await this.#context.request.get(`${this.#origin}${route}`, { headers: { accept: "application/json" }, maxRedirects: 0, failOnStatusCode: false, timeout: REQUEST_TIMEOUT_MS });
		} catch {
			await this.close();
			throw new AgentPreviewError("network", "The request failed; the session is closed and nothing is retried.");
		}
		const status = response.status();
		if (status >= 300 && status < 400) {
			await this.close();
			throw new AgentPreviewError("redirect", "The preview redirected; the session is closed.", status);
		}
		if (status === 401 || status === 403) {
			await this.close();
			throw new AgentPreviewError("auth-refused", "The preview refused the session; it is closed and nothing is retried.", status);
		}
		if (status !== 200) throw new AgentPreviewError("status", "The preview answered with an unexpected status.", status);
		return { status, body: await response.json().catch(() => null) };
	}
}

/**
 * Opens the one session: validates the origin, reads the credential, makes
 * the private context, exchanges once through the context's own request
 * object, checks the cookie it set and the session's end, and returns the
 * session. Any failure closes what was made, once, and throws a redacted
 * `AgentPreviewError`. Nothing is retried.
 */
export async function openAgentPreview(options: OpenOptions): Promise<AgentPreviewSession> {
	const origin = exactOrigin(options.origin);
	const { adapter } = options;
	if (!adapter.path.startsWith("/") || adapter.path.startsWith("//") || /[?#]/.test(adapter.path)) {
		throw new AgentPreviewError("adapter", "The exchange path must be a plain path.");
	}
	const clock = options.clock ?? realClock;
	const credential = readCredentialFile(options.credentialFile);
	const browser = await (options.launcher ?? playwrightChromium).launch();
	let context: BrowserContext | undefined;
	const fail = async (code: string, message: string, status?: number): Promise<never> => {
		await context?.close().catch(() => undefined);
		await browser.close().catch(() => undefined);
		throw new AgentPreviewError(code, message, status);
	};
	try {
		context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block", ignoreHTTPSErrors: false, bypassCSP: false, javaScriptEnabled: true, permissions: [], baseURL: origin });
		await context.route("**/*", async (route) => {
			const request = route.request();
			const inside = new URL(request.url()).origin === origin;
			if (!inside || !["GET", "HEAD"].includes(request.method())) await route.abort("blockedbyclient");
			else await route.continue();
		});
		const built = adapter.request(credential);
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
		const unsafe = (cookie: BrowserCookie) => !cookie.secure || !cookie.httpOnly || cookie.domain !== host || (cookie.expires > 0 && cookie.expires * 1000 > accepted.expiresAt + COOKIE_SKEW_MS);
		if (cookies.length === 0 || cookies.some(unsafe)) return await fail("cookie", "The exchange did not leave only Secure HttpOnly cookies for the origin, ending with the session.");
		const secrets = [credential, ...cookies.map((cookie) => cookie.value)].filter((value) => value.length > 0);
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
