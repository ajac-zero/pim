import { createExecutionContext, env, evictDurableObject, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import * as fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { EvalDirectory } from "../preview/cua-eval";
import { FIXTURE_KEY } from "../preview/cua-fixture";
import { evaluatorAdmission, LaunchEvaluatorLedger } from "../preview/launch-evaluator";
import previewWorker from "../preview/worker";
import { applyObservationEvent, initialObservationState, type ObservationState } from "../src/cua-observation";
import { OBSERVATION_KEY } from "../src/cua-observation-runtime";
import { MANAGE_MS } from "../src/cua-viewer";
import productionWorker from "../src/index";
import { Authenticator } from "./webauthn";
import { PreviewPim } from "./worker";

/**
 * Automation sign-in for the preview's Cua evaluation (preview/automation.ts,
 * docs/preview-automation.md). The preview's Worker is called directly, as
 * the operator's ingress reaches it, with a Directory of the preview's class
 * for each test, as test/preview-cua-fixture.test.ts does. The owner is set
 * up as a real one is: the operator's claim code, then a passkey made in the
 * real ceremony by the tests' software authenticator. Nothing leaves the
 * isolate: no browser, socket, service or host is started or reached, and
 * time moves only by `Date.now`.
 */

const SECRET = "preview-automation-ingress-secret-0123456789";
const CODE = "autoclaim".padEnd(43, "x");
const ORIGIN = "https://pim.test";
const EVALUATION = "cua-eval-test-1";
const DEPLOYMENT = "cua-eval@celld";
const MINUTE = 60_000;
const KEYS = [
	"PREVIEW_MODE",
	"PIM_RUNTIME",
	"PIM_INGRESS_SECRET",
	"PREVIEW_EVAL_CLAIM_SHA256",
	"PREVIEW_AUTOMATION",
	"PREVIEW_AUTOMATION_GRANT",
	"PREVIEW_LAUNCH_EVALUATOR",
	"PREVIEW_LAUNCH_EVALUATOR_GRANT",
	"PREVIEW_CUA_FIXTURE",
	"PREVIEW_CUA_FIXTURE_OWNER",
	"CUA_BRIDGES",
] as const;

const settings = env as unknown as Record<string, unknown>;
const previews = (env as unknown as { PREVIEW_PIM: DurableObjectNamespace<PreviewPim> }).PREVIEW_PIM;
const previewDirectories = (env as unknown as { PREVIEW_DIRECTORY: DurableObjectNamespace<EvalDirectory> }).PREVIEW_DIRECTORY;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
/** A credential as the operator makes one: 32 random bytes, base64url. */
const credential = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** Where the harness's test reads its configuration file from. */
const HARNESS_DIR = "/tmp/pim-agent-preview-harness";

// workerd's file system has no owners' modes: every file reads as 0666. The harness (computer/cua-host/agent-preview.ts)
// takes its configuration only from a 0600 file in a 0700 directory, which its own tests check on a real file system, so
// here files in HARNESS_DIR report the modes the operator gives them. Nothing else about the file system changes.
vi.mock("node:fs", async (original) => {
	const real = await original<typeof import("node:fs")>();
	const dir = "/tmp/pim-agent-preview-harness";
	const opened = new Set<number>();
	const ours = (file: unknown) => String(file) === dir || String(file).startsWith(`${dir}/`);
	const moded = (stat: import("node:fs").Stats, mode: number) =>
		({
			mode: (stat.mode & ~0o777) | mode,
			uid: stat.uid,
			nlink: stat.nlink,
			size: stat.size,
			isFile: () => stat.isFile(),
			isDirectory: () => stat.isDirectory(),
			isSymbolicLink: () => stat.isSymbolicLink(),
		}) as import("node:fs").Stats;
	const lstatSync = ((file: string, options?: object) => {
		const stat = real.lstatSync(file, options as never);
		return stat && ours(file) ? moded(stat, stat.isDirectory() ? 0o700 : 0o600) : stat;
	}) as typeof real.lstatSync;
	const openSync = ((file: string, flags: number) => {
		const fd = real.openSync(file, flags);
		if (ours(file)) opened.add(fd);
		return fd;
	}) as typeof real.openSync;
	const fstatSync = ((fd: number, options?: object) => {
		const stat = real.fstatSync(fd, options as never);
		return opened.has(fd) ? moded(stat, 0o600) : stat;
	}) as typeof real.fstatSync;
	const closeSync = (fd: number) => {
		opened.delete(fd);
		real.closeSync(fd);
	};
	return { ...real, lstatSync, openSync, fstatSync, closeSync, default: { ...real, lstatSync, openSync, fstatSync, closeSync } };
});

const logged: unknown[][] = [];
/** Every request that left the isolate. */
const sent: string[] = [];
let kept: (readonly [string, unknown])[] = [];

// The test helpers learn which namespaces are this Worker's from `cloudflare:workers`' `env` on their first use, which after
// a request to the preview's Worker can be that request's environment, whose Directory is the test's own lookup: so use them once first.
beforeAll(() => runInDurableObject(previewDirectories.getByName("first-use"), () => undefined));

beforeEach(() => {
	logged.length = 0;
	sent.length = 0;
	kept = KEYS.map((key) => [key, settings[key]] as const);
	for (const method of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args));
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		sent.push(new URL(input instanceof Request ? input.url : String(input)).href);
		throw new Error("This test reaches nothing");
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const [key, value] of kept) {
		if (value === undefined) delete settings[key];
		else settings[key] = value;
	}
});

type Ask = {
	method?: string;
	body?: unknown;
	cookie?: string;
	headers?: Record<string, string>;
	/** The operator's credential, in its header. */
	credential?: string;
	at?: string;
	/** Send only the headers given: no `Origin` on a write, as Playwright's request context sends none of its own. */
	asIs?: true;
};

/**
 * An evaluation with its owner set up and signed in with a passkey, and a
 * grant for them in the environment unless `grant` is false. `ask` reaches
 * the preview's Worker, and `production` a deployment's (src/index.ts), with
 * the same environment and Directory.
 */
async function evaluation(setUp: { grant?: boolean } = {}) {
	settings.PREVIEW_MODE = "cua-eval";
	settings.PIM_RUNTIME = "celld";
	settings.PIM_INGRESS_SECRET = SECRET;
	settings.PREVIEW_EVAL_CLAIM_SHA256 = await sha256(CODE);
	for (const key of ["PREVIEW_AUTOMATION", "PREVIEW_AUTOMATION_GRANT", "PREVIEW_LAUNCH_EVALUATOR", "PREVIEW_LAUNCH_EVALUATOR_GRANT", "PREVIEW_CUA_FIXTURE", "PREVIEW_CUA_FIXTURE_OWNER", "CUA_BRIDGES"]) delete settings[key];
	const run = crypto.randomUUID();
	const directory = previewDirectories.getByName(`${run}:directory`);
	const target = Object.assign(Object.create(env as object) as object, {
		Directory: { getByName: (name: string) => previewDirectories.getByName(`${run}:${name}`) },
		Pim: previews,
	}) as unknown as Env;
	const request = (path: string, init: Ask) => {
		const headers = new Headers(init.headers);
		headers.set("x-pim-ingress-secret", SECRET);
		headers.set("x-pim-client-ip", "192.0.2.60");
		if (init.cookie) headers.set("cookie", init.cookie);
		if (init.credential !== undefined) headers.set("authorization", `Pim-Automation ${init.credential}`);
		const method = init.method ?? (init.body === undefined ? "GET" : "POST");
		if (init.body !== undefined) headers.set("content-type", "application/json");
		if (method !== "GET" && method !== "HEAD" && !headers.has("origin") && !init.asIs) headers.set("origin", ORIGIN);
		return new Request(`${init.at ?? ORIGIN}${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
	};
	const through = (worker: { fetch: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> }) => async (path: string, init: Ask = {}) => {
		const ctx = createExecutionContext();
		const answer = await worker.fetch(request(path, init), target, ctx);
		await waitOnExecutionContext(ctx);
		return answer;
	};
	const ask = through(previewWorker as never);
	const production = through(productionWorker as never);

	// The owner, as the evaluation sets one up: the claim, then a passkey made for Pim's own host.
	const claimed = await ask("/auth/register", { body: { username: "autoowner", claim: CODE } });
	expect(claimed.status).toBe(201);
	const { setup } = (await claimed.json()) as { setup: string };
	const owner = setup.split(".")[0]!;
	const options = await ask("/auth/passkeys/options", { body: { setup } });
	const challenge = options.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
	const authenticator = await Authenticator.make("ES256", { rpId: "pim.test", origin: ORIGIN });
	const created = await ask("/auth/passkeys", { body: { ...(await authenticator.register((await options.json()) as never)), name: "Evaluation" }, cookie: challenge });
	expect(created.ok).toBe(true);
	const passkeySet = created.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-pim-session="))!;
	const passkey = passkeySet.split(";")[0]!;

	const secret = credential();
	/** The grant the operator puts in the preview's private environment, with `changes`. */
	const grant = async (changes: Record<string, unknown> = {}, given = secret) => {
		settings.PREVIEW_AUTOMATION = "on";
		settings.PREVIEW_AUTOMATION_GRANT = JSON.stringify({
			owner,
			evaluation: EVALUATION,
			deployment: DEPLOYMENT,
			origin: ORIGIN,
			credentialSha256: await sha256(given),
			notAfter: new Date(Date.now() + 6 * 60 * MINUTE).toISOString(),
			...changes,
		});
	};
	if (setUp.grant !== false) await grant();
	const identity = { owner, evaluation: EVALUATION, deployment: DEPLOYMENT };
	/** The runner's exchange, as docs/preview-automation.md specifies it. */
	const exchange = (init: Ask = {}, via = ask) => via("/auth/automation/session", { body: identity, credential: secret, ...init });
	/** The cookie an exchange set, as the runner hands it to its browser. */
	const cookieOf = (answer: Response) => answer.headers.getSetCookie().find((cookie) => cookie.startsWith("__Host-pim-automation="))?.split(";")[0];
	const signIn = async () => {
		const answer = await exchange();
		expect(answer.status).toBe(201);
		return cookieOf(answer)!;
	};
	/** The sessions the Directory holds, read with SQL of the test's own. */
	const rows = () =>
		runInDurableObject(directory, (_instance, state) =>
			state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'preview_automation_sessions'").toArray().length === 0
				? []
				: state.storage.sql.exec("SELECT * FROM preview_automation_sessions").toArray(),
		);
	return { ask, production, owner, passkey, passkeySet, secret, grant, identity, exchange, cookieOf, signIn, rows, directory };
}

const errorOf = async (answer: Response) => [answer.status, ((await answer.json()) as { error: string }).error];
const at = (time: number) => vi.spyOn(Date, "now").mockReturnValue(time);

describe("automation sign-in for the preview's evaluation", () => {
	it("signs a runner's browser and its API calls in as the claimed owner, for 30 minutes, to read only", async () => {
		const pim = await evaluation();
		const now = Date.now();
		at(now);
		const answer = await pim.exchange();
		expect(answer.status).toBe(201);
		const [set] = answer.headers.getSetCookie();
		// Its own cookie: host-only, Secure, HttpOnly, Strict, for 30 minutes, not the passkey session's 30 days.
		expect(set).toMatch(/^__Host-pim-automation=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=1800$/);
		expect(pim.passkeySet).toMatch(/Max-Age=2592000$/);
		const cookie = pim.cookieOf(answer)!;
		const session = {
			kind: "automation",
			access: "read-only",
			owner: pim.owner,
			username: "autoowner",
			evaluation: EVALUATION,
			deployment: DEPLOYMENT,
			origin: ORIGIN,
			expiresAt: new Date(now + 30 * MINUTE).toISOString(),
			notAfter: new Date(now + 6 * 60 * MINUTE).toISOString(),
		};
		expect(await answer.json()).toEqual({ mode: "enabled", session });

		// The browser's app sees an automation session, never a passkey; the banner reads the same from its own route.
		expect(await (await pim.ask("/auth/session", { cookie })).json()).toEqual({
			signedIn: true,
			method: "automation",
			passkey: null,
			credential: null,
			account: { username: "autoowner", role: "admin" },
			name: null,
			providers: [],
			automation: session,
			agentPreview: { enabled: true, expiresAt: now + 30 * MINUTE },
		});
		// Every other browser's app learns only that automation is on here, with no expiry: signed out, as here, or a passkey's (below).
		expect(await (await pim.ask("/auth/session")).json()).toMatchObject({ signedIn: false, agentPreview: { enabled: true, expiresAt: null } });
		expect(await (await pim.ask("/auth/automation/session", { cookie })).json()).toEqual({ mode: "enabled", session });
		expect(await (await pim.ask("/auth/automation/session")).json()).toEqual({ mode: "enabled", session: null });

		// The API reads, as the owner, from Pim's own origin or with none.
		expect((await pim.ask("/api/settings", { cookie })).status).toBe(200);
		expect((await pim.ask("/api/account", { cookie, headers: { origin: ORIGIN } })).status).toBe(200);
		expect((await pim.ask("/api/settings", { cookie, headers: { origin: "https://evil.example" } })).status).toBe(403);
		// It writes nothing, opens no socket, and makes no read that reaches out or exports everything.
		const readOnly = [403, "An automation session only reads, and not this."];
		expect(await errorOf(await pim.ask("/api/settings", { cookie, method: "PUT", body: { theme: "dark" } }))).toEqual(readOnly);
		expect(await errorOf(await pim.ask("/api/sessions/any/messages", { cookie, body: { content: "hello" } }))).toEqual(readOnly);
		// No socket opens, on any path or spelling: the gateway refuses the handshake before a space sees it.
		for (const path of ["/api/ws", "/api/browser/live", "/api/observations", "/api/settings"]) {
			for (const upgrade of ["websocket", "WebSocket"]) {
				const answer = await pim.ask(path, { cookie, headers: { upgrade, connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: ORIGIN } });
				expect([path, upgrade, answer.webSocket ?? null, ...(await errorOf(answer))]).toEqual([path, upgrade, null, ...readOnly]);
			}
		}
		for (const path of ["/api/export", "/api/account/export", "/api/browser", "/api/browser/screenshot", "/api/chatgpt/login", "/api/agents/any/suggestions"]) {
			expect([path, ...(await errorOf(await pim.ask(path, { cookie })))]).toEqual([path, ...readOnly]);
		}
		// Nor does it manage sign-in, make tokens or passkeys, delete the account or run the Pim: those are a passkey session's.
		expect((await pim.ask("/auth/tokens", { cookie })).status).toBe(401);
		expect((await pim.ask("/auth/tokens", { cookie, body: { name: "cli" } })).status).toBe(401);
		expect((await pim.ask("/auth/passkeys/options", { cookie, body: {} })).status).toBe(401);
		expect((await pim.ask("/auth/device-link", { cookie, body: {} })).status).toBe(401);
		expect((await pim.ask("/auth/recovery-codes", { cookie, body: {} })).status).toBe(401);
		expect(await errorOf(await pim.ask("/api/admin/stats", { cookie }))).toEqual([403, "Running this Pim needs you signed in to the app."]);
		expect((await pim.ask("/auth/connections", { cookie })).status).toBe(401);

		// Neither the credential nor the cookie was logged; the exchange was, without them.
		const logs = JSON.stringify(logged);
		expect(logs).not.toContain(pim.secret);
		expect(logs).not.toContain(cookie.split("=")[1]);
		expect(logged.filter(([line]) => String(line).includes('"preview.automation"')).map(([line]) => JSON.parse(String(line)))).toEqual([
			{ event: "preview.automation", action: "exchange", outcome: "issued", owner: pim.owner, expiresAt: now + 30 * MINUTE },
		]);
		// The Directory keeps the cookie's SHA-256, never the cookie.
		const [row] = await pim.rows();
		expect(row).toMatchObject({ digest: await sha256(cookie.split("=")[1]!), owner: pim.owner, evaluation: EVALUATION, deployment: DEPLOYMENT, origin: ORIGIN, expires_at: now + 30 * MINUTE, ended_at: null });
		expect(JSON.stringify(row)).not.toContain(pim.secret);
		expect(sent).toEqual([]);
	});

	it("is off without the flag, and refuses any other origin, evaluation, deployment, owner or credential", async () => {
		const pim = await evaluation();
		const invalid = [401, "That automation credential isn't valid for this preview."];
		// From another site, or with no Origin at all.
		expect(await errorOf(await pim.exchange({ headers: { origin: "https://evil.example" } }))).toEqual([403, "Requests must come from this app"]);
		expect(await errorOf(await pim.exchange({ headers: { origin: "http://pim.test" } }))).toEqual([403, "Requests must come from this app"]);
		// At any other address, the evaluation answers nothing.
		expect((await pim.exchange({ at: "https://evil.example" })).status).toBe(421);
		// Another credential, or the right one anywhere but its header.
		expect(await errorOf(await pim.exchange({ credential: credential() }))).toEqual(invalid);
		expect(await errorOf(await pim.exchange({ credential: undefined, headers: { authorization: `Bearer ${pim.secret}` } }))).toEqual(invalid);
		expect(await errorOf(await pim.exchange({ credential: undefined, body: { ...pim.identity, credential: pim.secret } }))).toEqual(invalid);
		expect(await errorOf(await pim.exchange({ credential: pim.secret.slice(1) }))).toEqual(invalid);
		// Another evaluation, deployment or owner than the grant's.
		for (const wrong of [{ evaluation: "cua-eval-test-2" }, { deployment: "cua-eval@cloudflare" }, { owner: "o_00000000000000000000000000" }, { owner: undefined }]) {
			expect(await errorOf(await pim.exchange({ body: { ...pim.identity, ...wrong } }))).toEqual(invalid);
		}
		// A grant for anyone but the claimed owner, even one well formed, signs nobody in.
		await pim.grant({ owner: "o_00000000000000000000000000" });
		expect(await errorOf(await pim.exchange({ body: { ...pim.identity, owner: "o_00000000000000000000000000" } }))).toEqual(invalid);

		// Off, it isn't there: the routes answer as a deployment's do.
		const off = [401, "Sign in to Pim"];
		await pim.grant();
		delete settings.PREVIEW_AUTOMATION;
		expect(await (await pim.ask("/auth/session")).json()).not.toHaveProperty("agentPreview");
		expect(await (await pim.ask("/auth/session", { cookie: pim.passkey })).json()).not.toHaveProperty("agentPreview");
		const grants: [string, () => Promise<void>][] = [
			["no flag", async () => {
				await pim.grant();
				delete settings.PREVIEW_AUTOMATION;
			}],
			["another flag", async () => {
				await pim.grant();
				settings.PREVIEW_AUTOMATION = "true";
			}],
			["no grant", async () => {
				await pim.grant();
				delete settings.PREVIEW_AUTOMATION_GRANT;
			}],
			["another origin", () => pim.grant({ origin: "https://other.pim.test" })],
			["another runtime", () => pim.grant({ deployment: "cua-eval@cloudflare" })],
			["a past deadline", () => pim.grant({ notAfter: new Date(Date.now() - 1000).toISOString() })],
			["a deadline too far ahead", () => pim.grant({ notAfter: new Date(Date.now() + 8 * 24 * 60 * MINUTE).toISOString() })],
			["a malformed digest", () => pim.grant({ credentialSha256: "not-a-digest" })],
			["an extra field", () => pim.grant({ access: "write" })],
		];
		for (const [name, set] of grants) {
			await set();
			const answer = await pim.exchange();
			expect([name, ...(await errorOf(answer)), answer.headers.getSetCookie()]).toEqual([name, ...off, []]);
		}
		// Nor does the local preview offer it, whatever its environment says.
		await pim.grant();
		delete settings.PREVIEW_MODE;
		delete settings.PIM_RUNTIME;
		settings.PIM_PUBLIC_URL = "http://localhost:8787";
		try {
			const local = await previewWorker.fetch(new Request("http://localhost:8787/auth/automation/session", { method: "POST", headers: { origin: "http://localhost:8787", authorization: `Pim-Automation ${pim.secret}` }, body: JSON.stringify(pim.identity) }) as never, env as never, createExecutionContext());
			expect(local.headers.getSetCookie()).toEqual([]);
			expect(local.status).toBe(401);
		} finally {
			settings.PIM_PUBLIC_URL = ORIGIN;
		}
		expect(await pim.rows()).toEqual([]);
		expect(JSON.stringify(logged)).not.toContain(pim.secret);
	});

	it("isn't mounted by a deployment's entry point, even with every preview variable copied into it", async () => {
		const pim = await evaluation();
		const cookie = await pim.signIn();
		// The control: the preview takes it.
		expect((await pim.ask("/api/settings", { cookie })).status).toBe(200);
		// The deployment's Worker, with the same environment, flag, grant, Directory and session: nothing of it is there.
		expect(await errorOf(await pim.exchange({}, pim.production))).toEqual([401, "Sign in to Pim"]);
		expect((await pim.exchange({}, pim.production)).headers.getSetCookie()).toEqual([]);
		expect((await pim.production("/auth/automation/session", { cookie })).status).toBe(401);
		expect((await pim.production("/auth/automation/revoke", { body: pim.identity, credential: pim.secret })).status).toBe(401);
		const deployed = await (await pim.production("/auth/session", { cookie })).json();
		expect(deployed).toMatchObject({ signedIn: false, method: null });
		expect(deployed).not.toHaveProperty("agentPreview");
		expect(await (await pim.production("/auth/session", { cookie: pim.passkey })).json()).not.toHaveProperty("agentPreview");
		expect((await pim.production("/api/settings", { cookie })).status).toBe(401);
		expect((await pim.production("/api/settings", { cookie, headers: { upgrade: "websocket" } })).status).toBe(401);
		// The owner's passkey still opens the deployment as it always has.
		expect((await pim.production("/api/settings", { cookie: pim.passkey })).status).toBe(200);
		// Nothing it was asked revoked or recorded anything: the preview's session is as it was, and still the only one.
		expect((await pim.ask("/api/settings", { cookie })).status).toBe(200);
		expect(await pim.rows()).toHaveLength(1);
	});

	it("checks every request again: an ended session, a revoked or changed grant, and an expired one stop at once", async () => {
		const pim = await evaluation();
		const first = await pim.signIn();
		const second = await pim.signIn();
		const reads = async (cookie: string) => (await pim.ask("/api/settings", { cookie })).status;
		// Ending one session ends that one only, sockets included.
		expect((await pim.ask("/auth/automation/session", { cookie: first, method: "DELETE" })).headers.getSetCookie()).toEqual(["__Host-pim-automation=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0"]);
		expect(await reads(first)).toBe(401);
		expect((await pim.ask("/api/ws", { cookie: first, headers: { upgrade: "websocket" } })).status).toBe(401);
		expect(await reads(second)).toBe(200);

		// Revoking the grant, with its credential, ends every session it made, on the next request in this same isolate, and it makes no more.
		expect((await pim.ask("/auth/automation/revoke", { body: pim.identity, credential: credential() })).status).toBe(401);
		expect(await reads(second)).toBe(200);
		expect((await pim.ask("/auth/automation/revoke", { body: pim.identity, credential: pim.secret })).status).toBe(200);
		expect(await reads(second)).toBe(401);
		for (const path of ["/api/ws", "/api/browser/live"]) expect([path, (await pim.ask(path, { cookie: second, headers: { upgrade: "websocket", origin: ORIGIN } })).status]).toEqual([path, 401]);
		expect(await (await pim.ask("/auth/session", { cookie: second })).json()).toMatchObject({ signedIn: false });
		expect((await pim.exchange()).status).toBe(401);
		// Restarted, the Directory still holds the revocation.
		await evictDurableObject(pim.directory);
		expect((await pim.exchange()).status).toBe(401);

		// A new credential is a new grant. Changing the grant in the environment, or turning it off, ends its sessions too.
		const renewed = credential();
		await pim.grant({}, renewed);
		const third = await pim.exchange({ credential: renewed });
		expect(third.status).toBe(201);
		const cookie = pim.cookieOf(third)!;
		expect(await reads(cookie)).toBe(200);
		await pim.grant({}, credential());
		expect(await reads(cookie)).toBe(401);
		await pim.grant({}, renewed);
		expect(await reads(cookie)).toBe(200);
		await pim.grant({ evaluation: "cua-eval-test-2" }, renewed);
		expect(await reads(cookie)).toBe(401);
		await pim.grant({}, renewed);
		delete settings.PREVIEW_AUTOMATION;
		expect(await reads(cookie)).toBe(401);
		settings.PREVIEW_AUTOMATION = "on";
		expect(await reads(cookie)).toBe(200);

		// A suspended owner is refused as a passkey session is.
		await runInDurableObject(pim.directory, (instance: EvalDirectory) => instance.setStatus(pim.owner, "suspended", "test"));
		expect(await reads(cookie)).not.toBe(200);
		expect((await pim.exchange({ credential: renewed })).status).toBe(401);
		await runInDurableObject(pim.directory, (instance: EvalDirectory) => instance.setStatus(pim.owner, "active", null));
		expect(await reads(cookie)).toBe(200);

		// 30 minutes is the most: a second past it, the session is over.
		const now = Date.now();
		const late = await pim.exchange({ credential: renewed });
		const later = pim.cookieOf(late)!;
		at(now + 30 * MINUTE + 1000);
		expect(await reads(later)).toBe(401);
		expect(await (await pim.ask("/auth/automation/session", { cookie: later })).json()).toEqual({ mode: "enabled", session: null });
		expect((await pim.ask("/api/ws", { cookie: later, headers: { upgrade: "websocket", origin: ORIGIN } })).status).toBe(401);
	});

	it("never outlasts the evaluation's cleanup deadline, and holds no more than eight sessions at once", async () => {
		const pim = await evaluation();
		const now = Date.now();
		at(now);
		const deadline = now + 10 * MINUTE;
		await pim.grant({ notAfter: new Date(deadline).toISOString() });
		const answer = await pim.exchange();
		expect(answer.headers.getSetCookie()[0]).toMatch(/; Max-Age=600$/);
		expect(((await answer.json()) as { session: { expiresAt: string } }).session.expiresAt).toBe(new Date(deadline).toISOString());
		const cookie = pim.cookieOf(answer)!;
		at(deadline - 1000);
		expect((await pim.ask("/api/settings", { cookie })).status).toBe(200);
		at(deadline);
		expect((await pim.ask("/api/settings", { cookie })).status).toBe(401);
		expect((await pim.exchange()).status).toBe(401);

		// A grant whose deadline the operator brings forward cuts its sessions short.
		at(now);
		await pim.grant({ notAfter: new Date(now + 60 * MINUTE).toISOString() });
		const open = [];
		for (let index = 0; index < 7; index++) open.push(await pim.signIn());
		expect(await errorOf(await pim.exchange())).toEqual([429, "This grant already has 8 sessions open. End one first."]);
		await pim.grant({ notAfter: new Date(now + 5 * MINUTE).toISOString() });
		at(now + 4 * MINUTE);
		const shortened = (await (await pim.ask("/auth/automation/session", { cookie: open[0] })).json()) as { session: { expiresAt: string } };
		expect(shortened.session.expiresAt).toBe(new Date(now + 5 * MINUTE).toISOString());
		at(now + 5 * MINUTE);
		expect((await pim.ask("/api/settings", { cookie: open[0] })).status).toBe(401);
	});

	it("leaves the owner's passkey session as it was, and takes a browser that carries both for automation", async () => {
		const pim = await evaluation();
		const passkey = await pim.ask("/auth/session", { cookie: pim.passkey });
		expect(await passkey.json()).toMatchObject({ signedIn: true, method: "passkey", account: { username: "autoowner", role: "admin" } });
		const human = await (await pim.ask("/auth/session", { cookie: pim.passkey })).json();
		expect(human).not.toHaveProperty("automation");
		expect(human).toMatchObject({ agentPreview: { enabled: true, expiresAt: null } });
		expect((await pim.ask("/api/settings", { cookie: pim.passkey, method: "PUT", body: {} })).status).not.toBe(403);
		const token = await pim.ask("/auth/tokens", { cookie: pim.passkey, body: { name: "cli" } });
		expect(token.status).toBe(201);
		expect((await pim.ask("/api/admin/stats", { cookie: pim.passkey })).status).toBe(200);
		// An automation session in the same browser counts as automation, not as the person.
		const cookie = await pim.signIn();
		const both = `${pim.passkey}; ${cookie}`;
		expect(await (await pim.ask("/auth/session", { cookie: both })).json()).toMatchObject({ method: "automation" });
		expect((await pim.ask("/api/sessions/any/messages", { cookie: both, body: { content: "hello" } })).status).toBe(403);
		// Once it ends, the passkey session is the browser's again, unchanged.
		await pim.ask("/auth/automation/session", { cookie: both, method: "DELETE" });
		expect(await (await pim.ask("/auth/session", { cookie: both })).json()).toMatchObject({ method: "passkey" });
		expect((await pim.ask("/api/admin/stats", { cookie: both })).status).toBe(200);
	});

	it("changes no observation, tool, identity, token or journal state: it lists the unresolved record and settles nothing", async () => {
		const pim = await evaluation();
		// The owner's space, seeded with the operator's computer, holding one unresolved observation, as the live evaluation does.
		const bridge = "https://bridge.preview-automation.test";
		settings.PREVIEW_CUA_FIXTURE = "seed";
		settings.PREVIEW_CUA_FIXTURE_OWNER = pim.owner;
		settings.CUA_BRIDGES = JSON.stringify({ [pim.owner]: { url: `${bridge}/${pim.owner}`, token: "preview-automation-bridge-token-0123456789" } });
		const space = previews.getByName(pim.owner);
		await evictDurableObject(space).catch(() => undefined);
		const id = "attempted-watch-0001";
		let ledger: ObservationState = initialObservationState(pim.owner);
		ledger = applyObservationEvent(ledger, { type: "open_requested", owner: pim.owner, observationId: id, notAfter: Date.now() + 30 * MINUTE, now: Date.now() }).state;
		ledger = applyObservationEvent(ledger, { type: "unconfirmed", observationId: id, evidence: "the host's answer to launch was lost (test)" }).state;
		expect(ledger.records).toEqual([expect.objectContaining({ observationId: id, status: "unconfirmed" })]);
		await runInDurableObject(space, (instance: PreviewPim) => instance.store.setMeta(OBSERVATION_KEY, JSON.stringify(ledger)));
		await evictDurableObject(space).catch(() => undefined);

		/** Everything the space, the owner's sign-in and the Directory's account hold that automation could touch. */
		const snapshot = async () => ({
			space: await runInDurableObject(space, (_instance, state) =>
				state.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name")
					.toArray()
					.map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()]),
			),
			tokens: await (await pim.ask("/auth/tokens", { cookie: pim.passkey })).json(),
			passkeys: await (await pim.ask("/auth/passkeys", { cookie: pim.passkey })).json(),
			identities: await (await pim.ask("/auth/identities", { cookie: pim.passkey })).json(),
			account: await pim.directory.account(pim.owner),
		});
		const before = await snapshot();
		expect(JSON.stringify(before.space)).toContain(id);

		const cookie = await pim.signIn();
		await pim.ask("/auth/session", { cookie });
		await pim.ask("/auth/automation/session", { cookie });
		// The list is a read of what the space holds, and shows the record as it is.
		const listing = await pim.ask("/api/observations", { cookie });
		expect(listing.status).toBe(200);
		expect(((await listing.json()) as { observations: { id: string; status: string }[] }).observations).toEqual([expect.objectContaining({ id, status: "unconfirmed" })]);
		// Its status (which may ask the host and settle it), a new Watch and an End are refused before the space is asked.
		for (const [path, method] of [[`/api/observations/${id}`, "GET"], ["/api/observations", "POST"], [`/api/observations/${id}/end`, "POST"]] as const) {
			expect([path, method, (await pim.ask(path, { cookie, method })).status]).toEqual([path, method, 403]);
		}
		await pim.ask("/auth/automation/session", { cookie, method: "DELETE" });
		await pim.signIn();
		await pim.ask("/auth/automation/revoke", { body: pim.identity, credential: pim.secret });

		expect(await snapshot()).toEqual(before);
		// No host, bridge or anything else was reached.
		expect(sent).toEqual([]);
	});
});

/**
 * The isolated-browser harness (computer/cua-host/agent-preview.ts) and the
 * web app's banner, run against this Worker. They are type-checked as their
 * own projects (Node's, and the web app's), so they're imported by a path
 * TypeScript doesn't follow, with only the shapes used here.
 */
type Session = { metadata(): unknown };
type Harness = {
	openAgentPreview(options: { configFile: string; parse(text: string): unknown; deadline: number; launcher: unknown }): Promise<Session>;
	diagnoseObservations(session: Session): Promise<unknown>;
};
type Adapter = { parseAutomationConfig(text: string): unknown };
type Banner = { agentPreviewText(preview: unknown, now: number): string | null };
const load = <T>(path: string) => import(/* @vite-ignore */ path) as Promise<T>;

type Cookie = { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: string };
type Route = { request(): { url(): string; method(): string }; continue(): Promise<void>; abort(code?: string): Promise<void> };

/**
 * The parts of Playwright the harness uses, over this Worker: a context with
 * one cookie jar, which keeps each `Set-Cookie` as Chromium does (host-only
 * without `Domain`), and a page whose requests go through the context's route
 * and WebSocket handlers first, as Playwright's do. Loading `/` makes the
 * requests the app's shell makes as it starts (web/index.html's stylesheet,
 * web/src/lib/auth.ts's `/auth/session`), then a read of one observation's
 * status and a socket, as a page that wanted them would. The banner is the
 * app's own text for what `/auth/session` answered. No browser, process or
 * socket is started, and nothing leaves the isolate.
 */
function playwrightOver(ask: (path: string, init: Ask) => Promise<Response>, banner: Banner, record: string) {
	/** Requests the Worker was asked, in order. */
	const reached: string[] = [];
	/** Page requests the context's route aborted. */
	const aborted: string[] = [];
	/** WebSockets the context answered itself. */
	const sockets: string[] = [];
	let jar: Cookie[] = [];
	/** The jar as the context held it when the harness closed it. */
	let closedWith: Cookie[] = [];
	let route: ((route: Route) => Promise<void> | void) | undefined;
	let socket: ((ws: { close(options?: { code?: number; reason?: string }): void }) => Promise<void> | void) | undefined;
	const host = new URL(ORIGIN).hostname;

	const keep = (answer: Response) => {
		for (const line of answer.headers.getSetCookie()) {
			const [pair = "", ...parts] = line.split(";").map((part) => part.trim());
			const [name = "", ...value] = pair.split("=");
			const attributes = new Map(parts.map((part) => [part.split("=")[0]!.toLowerCase(), part.split("=").slice(1).join("=")] as const));
			const maxAge = attributes.get("max-age");
			jar = jar.filter((cookie) => cookie.name !== name);
			if (maxAge === "0") continue;
			const sameSite = attributes.get("samesite")?.toLowerCase();
			jar.push({
				name,
				value: value.join("="),
				domain: attributes.has("domain") ? `.${attributes.get("domain")}` : host,
				path: attributes.get("path") || "/",
				expires: maxAge ? Math.floor(Date.now() / 1000) + Number(maxAge) : -1,
				httpOnly: attributes.has("httponly"),
				secure: attributes.has("secure"),
				sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax",
			});
		}
	};
	const send = async (method: string, url: string, headers: Record<string, string> = {}, data?: unknown) => {
		const { origin, pathname, search } = new URL(url);
		expect(origin).toBe(ORIGIN);
		reached.push(`${method} ${pathname}${search}`);
		const cookie = jar.map(({ name, value }) => `${name}=${value}`).join("; ");
		const answer = await ask(`${pathname}${search}`, { method, headers, asIs: true, ...(cookie ? { cookie } : {}), ...(data === undefined ? {} : { body: data }) });
		keep(answer);
		return answer;
	};
	const api = (answer: Response) => ({ status: () => answer.status, json: () => answer.json() });
	/** A page's request: the context's route decides first. */
	const browse = async (path: string) => {
		let verdict = "none";
		await route!({ request: () => ({ url: () => `${ORIGIN}${path}`, method: () => "GET" }), continue: async () => void (verdict = "continue"), abort: async () => void (verdict = "abort") });
		if (verdict === "continue") return send("GET", `${ORIGIN}${path}`);
		aborted.push(`GET ${path}`);
		return null;
	};

	let shown: string | null = null;
	const context = {
		request: {
			post: async (url: string, options: { headers?: Record<string, string>; data?: unknown }) => api(await send("POST", url, options.headers, options.data)),
			get: async (url: string, options: { headers?: Record<string, string> }) => api(await send("GET", url, options.headers)),
		},
		cookies: async (url: string) => jar.filter((cookie) => cookie.domain === new URL(url).hostname || (cookie.domain.startsWith(".") && new URL(url).hostname.endsWith(cookie.domain))),
		route: async (_url: string, handler: typeof route) => void (route = handler),
		routeWebSocket: async (_url: unknown, handler: typeof socket) => void (socket = handler),
		newPage: async () => ({
			goto: async (url: string) => {
				await browse(new URL(url).pathname);
				const session = await browse("/auth/session");
				await browse("/api/themes.css");
				await browse(`/api/observations/${record}`);
				await socket!({ close: (options) => void sockets.push(`${ORIGIN.replace("https", "wss")}/api/ws ${options?.code} ${options?.reason}`) });
				shown = banner.agentPreviewText(session ? ((await session.json()) as { agentPreview?: unknown }).agentPreview : undefined, Date.now());
			},
			url: () => `${ORIGIN}/`,
			title: async () => "Pim",
			locator: () => ({ first: () => ({ textContent: async () => shown }) }),
			close: async () => undefined,
		}),
		close: async () => {
			closedWith = jar;
			jar = [];
		},
	};
	const contexts: unknown[] = [];
	const launcher = { launch: async () => ({ newContext: async (options: unknown) => (contexts.push(options), context), close: async () => undefined }) };
	return { launcher, reached, aborted, sockets, contexts, jar: () => jar, closedWith: () => closedWith };
}

describe("the agent-preview harness against this Worker", () => {
	it("makes its first diagnosis through the real exchange: the list, the app and its banner, and nothing else", async () => {
		const pim = await evaluation();
		// The owner's space holds one unresolved observation, as in the evaluation's other test above.
		settings.PREVIEW_CUA_FIXTURE = "seed";
		settings.PREVIEW_CUA_FIXTURE_OWNER = pim.owner;
		settings.CUA_BRIDGES = JSON.stringify({ [pim.owner]: { url: `https://bridge.preview-automation.test/${pim.owner}`, token: "preview-automation-bridge-token-0123456789" } });
		const space = previews.getByName(pim.owner);
		await evictDurableObject(space).catch(() => undefined);
		const id = "attempted-watch-0002";
		const notAfter = Date.now() + 30 * MINUTE;
		let ledger: ObservationState = initialObservationState(pim.owner);
		ledger = applyObservationEvent(ledger, { type: "open_requested", owner: pim.owner, observationId: id, notAfter, now: Date.now() }).state;
		ledger = applyObservationEvent(ledger, { type: "unconfirmed", observationId: id, evidence: "the host's answer to launch was lost (timeout)" }).state;
		await runInDurableObject(space, (instance: PreviewPim) => instance.store.setMeta(OBSERVATION_KEY, JSON.stringify(ledger)));
		await evictDurableObject(space).catch(() => undefined);
		const held = () => runInDurableObject(space, (instance: PreviewPim) => instance.store.meta(OBSERVATION_KEY));
		const before = await held();

		// The runner's input, as scripts/preview-automation-grant.mjs writes it, in the operator's protected directory.
		fs.mkdirSync(HARNESS_DIR, { recursive: true });
		onTestFinished(() => fs.rmSync(HARNESS_DIR, { recursive: true, force: true }));
		const file = `${HARNESS_DIR}/automation.json`;
		fs.writeFileSync(file, `${JSON.stringify({ version: 1, origin: ORIGIN, ...pim.identity, credential: pim.secret })}\n`);
		const deadline = JSON.parse(String(settings.PREVIEW_AUTOMATION_GRANT)).notAfter as string;

		// What agent-preview-cli.ts runs, but its arguments: workerd has no `parseArgs`, and the harness's own tests run the entry point.
		const { openAgentPreview, diagnoseObservations } = await load<Harness>("../computer/cua-host/agent-preview.ts");
		const { parseAutomationConfig } = await load<Adapter>("../computer/cua-host/agent-preview-automation.ts");
		const banner = await load<Banner>("../web/src/components/agent-preview-banner.tsx");
		const browser = playwrightOver(pim.ask, banner, id);
		const now = Date.now();
		at(now);
		const opened = await openAgentPreview({ configFile: file, parse: parseAutomationConfig, deadline: Date.parse(deadline), launcher: browser.launcher });
		const metadata = opened.metadata();
		const diagnosis = await diagnoseObservations(opened);

		const ends = new Date(now + 30 * MINUTE);
		const printed = JSON.stringify({ metadata, diagnosis });
		expect({ metadata, diagnosis }).toEqual({
			metadata: { origin: ORIGIN, expiresAt: ends.toISOString(), requestsLeft: 50 },
			diagnosis: {
				observations: { status: 200, blocked: null, observations: [{ id, status: "unconfirmed", notAfter, evidence: "the host's answer to launch was lost (timeout)", lostReason: "timeout" }] },
				ui: { path: "/", title: "Pim", banner: `UNSAFE PREVIEW — agent access enabled · automation session ends ${ends.toISOString().slice(11, 16)} UTC` },
			},
		});
		// One fresh context, and the Worker was asked exactly this: the exchange, the list, the page and the banner's session.
		expect(browser.contexts).toHaveLength(1);
		expect(browser.reached).toEqual(["POST /auth/automation/session", "GET /api/observations", "GET /", "GET /auth/session"]);
		// The page's request for one observation's status (which may ask the host and settle the record) never reached the Worker, nor did any socket.
		expect(browser.aborted).toEqual(["GET /api/themes.css", `GET /api/observations/${id}`]);
		expect(browser.sockets).toEqual(["wss://pim.test/api/ws 1008 read only"]);

		// The context held exactly the Worker's session cookie, and dropped it on closing. The Worker's session isn't ended: it lasts until it expires.
		const [issued, ...others] = browser.closedWith();
		expect([issued?.name, others, browser.jar()]).toEqual(["__Host-pim-automation", [], []]);
		const cookie = `${issued!.name}=${issued!.value}`;
		expect(await pim.rows()).toEqual([expect.objectContaining({ digest: await sha256(issued!.value), owner: pim.owner, evaluation: EVALUATION, deployment: DEPLOYMENT, origin: ORIGIN, expires_at: now + 30 * MINUTE, ended_at: null })]);

		// Had the record's read or the socket got past the context, the Worker refuses both on that session.
		const readOnly = [403, "An automation session only reads, and not this."];
		expect(await errorOf(await pim.ask(`/api/observations/${id}`, { cookie }))).toEqual(readOnly);
		for (const headers of [{ origin: ORIGIN }, {}] as Record<string, string>[]) {
			const answer = await pim.ask("/api/ws", { cookie, headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });
			expect([answer.status, answer.webSocket ?? null]).toEqual([403, null]);
		}

		// Nothing about the record changed, nothing left the isolate, and the diagnosis holds neither the credential nor a cookie.
		expect(await held()).toBe(before);
		expect(sent).toEqual([]);
		expect(printed).not.toContain(pim.secret);
		expect(printed).not.toContain(issued!.value);
	});
});

/**
 * The one-use launch evaluator (preview/launch-evaluator.ts,
 * docs/launch-evaluator.md) against the real preview Worker and the owner's
 * seeded space, whose bridge is a `fetch` written here: it answers the viewer
 * host's management for the owner's bridge and nothing else. No browser,
 * socket or host is involved.
 */
describe("the launch evaluator", () => {
	const BRIDGE = "https://bridge.launch-evaluator.test";
	const BRIDGE_TOKEN = "launch-evaluator-bridge-token-0123456789";
	const LAUNCH_ID = "EvaluatorLaunch0000001";
	const TICKET = "evaluator-ticket-".padEnd(43, "q");
	const OLD = "attempted-watch-0003-earlier";
	const OTHER_OLD = "attempted-watch-0004-another";
	const LAUNCH = "/auth/launch-evaluator/launch";
	const END = "/auth/launch-evaluator/end";
	const NOT_VALID = [401, "That launch evaluator credential isn't valid for this preview."];

	type Host = { launch: "launched" | "lost" | "refused"; end: "requested" | "lost" };

	/**
	 * An evaluation whose owner's space the fixture seeded, holding one earlier
	 * observation in `old`'s status, with an evaluator grant for its owner and
	 * a bridge that answers as `host` says.
	 */
	async function evaluator(setUp: { old?: "not_opened" | "unconfirmed" | "open" | "two-unconfirmed"; host?: Partial<Host>; existingUnconfirmed?: string } = {}) {
		const pim = await evaluation();
		settings.PREVIEW_CUA_FIXTURE = "seed";
		settings.PREVIEW_CUA_FIXTURE_OWNER = pim.owner;
		settings.CUA_BRIDGES = JSON.stringify({ [pim.owner]: { url: `${BRIDGE}/${pim.owner}`, token: BRIDGE_TOKEN } });
		const space = previews.getByName(pim.owner);
		await evictDurableObject(space).catch(() => undefined);
		const now = Date.now();
		let ledger: ObservationState = initialObservationState(pim.owner);
		ledger = applyObservationEvent(ledger, { type: "open_requested", owner: pim.owner, observationId: OLD, notAfter: now + 30 * MINUTE, now }).state;
		const old = setUp.old ?? "not_opened";
		if (old === "not_opened") ledger = applyObservationEvent(ledger, { type: "open_refused", observationId: OLD, evidence: "the host refused the launch (blocked)" }).state;
		if (old === "unconfirmed" || old === "two-unconfirmed") ledger = applyObservationEvent(ledger, { type: "unconfirmed", observationId: OLD, evidence: "the host's answer to launch was lost (timeout)" }).state;
		if (old === "two-unconfirmed") {
			ledger = applyObservationEvent(ledger, { type: "open_requested", owner: pim.owner, observationId: OTHER_OLD, notAfter: now + 30 * MINUTE, now }).state;
			ledger = applyObservationEvent(ledger, { type: "unconfirmed", observationId: OTHER_OLD, evidence: "the host's answer to launch was lost (timeout)" }).state;
		}
		if (old === "open") ledger = applyObservationEvent(ledger, { type: "open_acknowledged", observationId: OLD, hostLaunchId: "OldLaunch0000000000001", hostGeneration: "gen-0" }).state;
		expect(ledger.records[0]).toEqual(expect.objectContaining({ observationId: OLD, status: old === "two-unconfirmed" ? "unconfirmed" : old }));
		await runInDurableObject(space, (instance: PreviewPim) => instance.store.setMeta(OBSERVATION_KEY, JSON.stringify(ledger)));
		await evictDurableObject(space).catch(() => undefined);
		const records = async () => (JSON.parse((await runInDurableObject(space, (instance: PreviewPim) => instance.store.meta(OBSERVATION_KEY)))!) as ObservationState).records;
		const oldRecord = async () => JSON.stringify((await records()).filter((record) => record.observationId === OLD || record.observationId === OTHER_OLD));
		const before = await oldRecord();

		const secret = credential();
		const grant = async (changes: Record<string, unknown> = {}, given = secret) => {
			settings.PREVIEW_LAUNCH_EVALUATOR = "on";
			settings.PREVIEW_LAUNCH_EVALUATOR_GRANT = JSON.stringify({
				kind: "launch-evaluator",
				owner: pim.owner,
				evaluation: EVALUATION,
				deployment: DEPLOYMENT,
				origin: ORIGIN,
				credentialSha256: await sha256(given),
				notAfter: new Date(Date.now() + 6 * 60 * MINUTE).toISOString(),
				existingUnconfirmed: setUp.existingUnconfirmed ?? null,
				...changes,
			});
		};
		await grant();

		// The bridge's viewer host: management for this owner only, answered as `host` says; everything else is refused and counted.
		const host: Host = { launch: "launched", end: "requested", ...setUp.host };
		const asked: { action: string; body: Record<string, unknown>; authorization: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const prefix = `${BRIDGE}/${pim.owner}/observations/`;
			if (!request.url.startsWith(prefix)) {
				sent.push(request.url);
				throw new Error("This test reaches only its bridge's management");
			}
			const action = request.url.slice(prefix.length);
			const body = JSON.parse(await request.text()) as Record<string, unknown>;
			asked.push({ action, body, authorization: request.headers.get("authorization") });
			if (action === "launch") {
				if (host.launch === "lost") throw new Error("connection reset");
				if (host.launch === "refused") return Response.json({ outcome: "refused", reason: "blocked" });
				return Response.json({ outcome: "launched", key: body.key, launchId: LAUNCH_ID, generation: "gen-1", notAfter: body.notAfter, viewerPath: `/${LAUNCH_ID}/viewer/#ticket=${TICKET}&clipboard=0`, replayed: false });
			}
			if (action === "end") {
				if (host.end === "lost") throw new Error("connection reset");
				return Response.json({ outcome: "requested", recorded: true });
			}
			throw new Error(`The evaluator asked the bridge for ${action}`);
		});

		const authorization = (given = secret) => ({ authorization: `Pim-Launch-Evaluator ${given}` });
		const launch = (init: Ask = {}) => pim.ask(LAUNCH, { body: pim.identity, ...init, headers: { ...authorization(), ...init.headers } });
		const end = (run: string, observation: string, init: Ask = {}) =>
			pim.ask(END, { body: { ...pim.identity, observation }, ...init, headers: { ...authorization(), "x-pim-launch-evaluator-run": run, ...init.headers } });
		/** The evaluator's runs, as the Directory holds them. */
		const runs = () =>
			runInDurableObject(pim.directory, (_instance, state) =>
				state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'preview_launch_evaluator_runs'").toArray().length === 0
					? []
					: state.storage.sql.exec("SELECT * FROM preview_launch_evaluator_runs").toArray(),
			);
		/** The evaluator's own log lines, parsed. */
		const lines = () => logged.filter(([line]) => String(line).includes('"preview.launch-evaluator"')).map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
		return { ...pim, secret, evaluatorGrant: grant, asked, launch, end, runs, records, oldRecord, before, authorization, space, lines };
	}

	type Launched = { run: { phase: string; deadline: string; observation: { id: string; status: string; notAfter: number } }; viewer: string; runToken: string };

	it("launches one fresh observation for the claimed owner, ends exactly it once, and is then spent for good", async () => {
		const pim = await evaluator();
		const now = Date.now();
		at(now);
		const answer = await pim.launch();
		expect(answer.status).toBe(201);
		// No session: no cookie of any kind is set.
		expect(answer.headers.getSetCookie()).toEqual([]);
		expect(answer.headers.get("cache-control")).toBe("no-store");
		const launched = (await answer.json()) as Launched;
		const fresh = launched.run.observation.id;
		expect(fresh).not.toBe(OLD);
		expect(launched).toEqual({
			run: { phase: "open", classification: "certain_open", deadline: new Date(now + 10 * MINUTE).toISOString(), observation: { id: fresh, status: "open", notAfter: expect.any(Number) }, alongside: null },
			viewer: `${BRIDGE}/${LAUNCH_ID}/viewer/#ticket=${TICKET}&clipboard=0`,
			runToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
		});
		// The space's own 10 minutes, by its own clock, which the test doesn't move.
		const { notAfter } = launched.run.observation;
		expect(Math.abs(notAfter - (now + 10 * MINUTE))).toBeLessThan(MINUTE);
		// The bridge was asked once, for the fresh key, with the bridge's own token, which never reaches the evaluator.
		expect(pim.asked).toEqual([{ action: "launch", body: { key: fresh, owner: pim.owner, notAfter }, authorization: `Bearer ${BRIDGE_TOKEN}` }]);
		expect(JSON.stringify(launched)).not.toContain(BRIDGE_TOKEN);
		const [row] = await pim.runs();
		expect(row).toMatchObject({ grant_digest: await sha256(pim.secret), owner: pim.owner, evaluation: EVALUATION, deployment: DEPLOYMENT, origin: ORIGIN, run_digest: await sha256(launched.runToken), phase: "open", observation_id: fresh, deadline: now + 10 * MINUTE });
		expect(JSON.stringify(row)).not.toContain(pim.secret);
		expect(JSON.stringify(row)).not.toContain(launched.runToken);

		// The one End: of the fresh observation, with the run token.
		const ended = await pim.end(launched.runToken, fresh);
		expect(ended.status).toBe(202);
		expect(await ended.json()).toEqual({ run: { phase: "ended", observation: { id: fresh, status: "revoking" } } });
		expect(pim.asked.map(({ action, body }) => [action, body.key])).toEqual([
			["launch", fresh],
			["end", fresh],
		]);
		expect(pim.asked[1]!.body).toEqual({ owner: pim.owner, key: fresh, generation: "gen-1" });
		expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "ended", observation_id: fresh })]);

		// Spent: a second launch or End does nothing, and asks nothing.
		expect(await errorOf(await pim.launch())).toEqual([409, "This launch evaluator grant has run already; it runs once."]);
		expect(await errorOf(await pim.end(launched.runToken, fresh))).toEqual([409, "This run can't end that observation now."]);
		expect(pim.asked).toHaveLength(2);
		// The earlier observation is exactly as it was; the space holds it and the fresh one.
		expect(await pim.oldRecord()).toBe(pim.before);
		expect((await pim.records()).map((record) => [record.observationId, record.status])).toEqual([
			[OLD, "not_opened"],
			[fresh, "revoking"],
		]);
		// Nothing secret was logged, and nothing but the bridge's management was reached.
		const logs = JSON.stringify(logged);
		for (const secret of [pim.secret, launched.runToken, TICKET, BRIDGE_TOKEN]) expect(logs).not.toContain(secret);
		expect(logged.filter(([line]) => String(line).includes('"preview.launch-evaluator"')).map(([line]) => JSON.parse(String(line)))).toEqual([
			{ event: "preview.launch-evaluator", action: "launch", outcome: "open", classification: "certain_open", owner: pim.owner, observation: fresh, alongside: null, deadline: now + 10 * MINUTE },
			{ event: "preview.launch-evaluator", action: "end", outcome: "ended", owner: pim.owner, observation: fresh },
			{ event: "preview.launch-evaluator", action: "launch", outcome: "refused", reason: "spent" },
			{ event: "preview.launch-evaluator", action: "end", outcome: "refused", reason: "phase", phase: "ended" },
		]);
		expect(sent).toEqual([]);

		// A new grant takes a new credential; the spent one then does nothing at all.
		await pim.evaluatorGrant({}, credential());
		expect(await errorOf(await pim.launch())).toEqual(NOT_VALID);
		expect(pim.asked).toHaveLength(2);
	});

	it("refuses before anything is recorded or asked: another origin, credential, scheme, owner, evaluation or deployment, and any other route or method", async () => {
		const pim = await evaluator();
		for (const [init, expected] of [
			[{ headers: { origin: "https://evil.example" } }, [403, "Requests must come from this app"]],
			[{ asIs: true }, [403, "Requests must come from this app"]],
			[{ headers: pim.authorization(credential()) }, NOT_VALID],
			[{ headers: { authorization: `Pim-Automation ${pim.secret}` } }, NOT_VALID],
			[{ headers: { authorization: `Bearer ${pim.secret}` } }, NOT_VALID],
			[{ body: { ...pim.identity, owner: "o_00000000000000000000000000" } }, NOT_VALID],
			[{ body: { ...pim.identity, evaluation: "cua-eval-test-2" } }, NOT_VALID],
			[{ body: { ...pim.identity, deployment: "cua-eval@cloudflare" } }, NOT_VALID],
			[{ body: { ...pim.identity, observation: OLD } }, NOT_VALID],
			[{ body: { ...pim.identity, credential: pim.secret }, headers: { authorization: "" } }, NOT_VALID],
		] as [Ask, unknown[]][]) {
			expect(await errorOf(await pim.launch(init))).toEqual(expected);
		}
		expect((await pim.launch({ at: "https://evil.example" })).status).toBe(421);
		expect(await errorOf(await pim.ask(LAUNCH, { headers: pim.authorization() }))).toEqual([405, "/auth/launch-evaluator/launch takes POST"]);
		for (const path of ["/auth/launch-evaluator", "/auth/launch-evaluator/status", "/auth/launch-evaluator/reset", "/auth/launch-evaluator/reconcile", `/auth/launch-evaluator/observations/${OLD}`]) {
			expect([path, (await pim.ask(path, { body: pim.identity, headers: pim.authorization() })).status]).toEqual([path, 404]);
		}
		expect((await pim.ask(`${LAUNCH}?observation=${OLD}`, { body: pim.identity, headers: pim.authorization() })).status).toBe(404);
		expect((await pim.launch({ headers: { upgrade: "websocket", connection: "Upgrade" } })).status).toBe(404);

		// Its credential is no API token or session, and the automation session gains nothing from the evaluator's existence.
		expect((await pim.ask("/api/observations", { headers: pim.authorization() })).status).toBe(401);
		expect((await pim.ask("/api/observations", { method: "POST", headers: pim.authorization() })).status).toBe(401);
		await pim.grant();
		const cookie = await pim.signIn();
		const readOnly = [403, "An automation session only reads, and not this."];
		expect(await errorOf(await pim.ask("/api/observations", { cookie, method: "POST" }))).toEqual(readOnly);
		expect(await errorOf(await pim.ask(`/api/observations/${OLD}/end`, { cookie, method: "POST" }))).toEqual(readOnly);
		expect(await errorOf(await pim.ask(`/api/observations/${OLD}`, { cookie }))).toEqual(readOnly);
		expect(await errorOf(await pim.launch({ cookie, headers: { authorization: "" } }))).toEqual(NOT_VALID);
		expect(await errorOf(await pim.launch({ headers: { authorization: `Pim-Launch-Evaluator ${pim.secret.replace(/./, "x")}` } }))).toEqual(NOT_VALID);
		expect(await errorOf(await pim.end("r".repeat(43), OLD, { cookie }))).toEqual(NOT_VALID);

		// Nothing was recorded or asked, the earlier record is as it was, and the grant still runs once.
		expect(await pim.runs()).toEqual([]);
		expect(pim.asked).toEqual([]);
		expect(await pim.oldRecord()).toBe(pim.before);
		expect((await pim.launch()).status).toBe(201);
		expect(pim.asked).toHaveLength(1);
	});

	it("is off unless granted on its own terms, and a deployment's entry point never has it, even with every variable copied", async () => {
		const pim = await evaluator();
		// What a deployment's entry point answers at the evaluator's route, with the evaluator granted in the same environment.
		const production = async () => errorOf(await pim.production(LAUNCH, { body: pim.identity, headers: pim.authorization() }));
		const offAnswer = await production();
		expect(offAnswer).toEqual([401, "Sign in to Pim"]);
		const automation = credential();
		await pim.grant({}, automation);
		const off: [string, () => Promise<void>][] = [
			["no flag", async () => void delete settings.PREVIEW_LAUNCH_EVALUATOR],
			["another flag", async () => void (settings.PREVIEW_LAUNCH_EVALUATOR = "true")],
			["no grant", async () => void delete settings.PREVIEW_LAUNCH_EVALUATOR_GRANT],
			["an automation-shaped grant", async () => {
				const grant = JSON.parse(String(settings.PREVIEW_LAUNCH_EVALUATOR_GRANT));
				delete grant.kind;
				settings.PREVIEW_LAUNCH_EVALUATOR_GRANT = JSON.stringify(grant);
			}],
			["another kind", () => pim.evaluatorGrant({ kind: "automation" })],
			["an extra field", () => pim.evaluatorGrant({ observation: OLD })],
			["no existingUnconfirmed field", async () => {
				const grant = JSON.parse(String(settings.PREVIEW_LAUNCH_EVALUATOR_GRANT));
				delete grant.existingUnconfirmed;
				settings.PREVIEW_LAUNCH_EVALUATOR_GRANT = JSON.stringify(grant);
			}],
			["a malformed existingUnconfirmed", () => pim.evaluatorGrant({ existingUnconfirmed: "../observations" })],
			["an existingUnconfirmed of another type", () => pim.evaluatorGrant({ existingUnconfirmed: [OLD] })],
			["the automation grant's credential", () => pim.evaluatorGrant({}, automation)],
			["another owner", () => pim.evaluatorGrant({ owner: "o_00000000000000000000000000" })],
			["another origin", () => pim.evaluatorGrant({ origin: "https://other.test" })],
			["another runtime", () => pim.evaluatorGrant({ deployment: "cua-eval@cloudflare" })],
			["a past deadline", () => pim.evaluatorGrant({ notAfter: new Date(Date.now() - 1000).toISOString() })],
			["a deadline more than a day ahead", () => pim.evaluatorGrant({ notAfter: new Date(Date.now() + 25 * 60 * MINUTE).toISOString() })],
		];
		for (const [name, turnOff] of off) {
			await pim.evaluatorGrant();
			await turnOff();
			const answer = name === "the automation grant's credential" ? await pim.launch({ headers: pim.authorization(automation) }) : await pim.launch();
			// Off, the route isn't there: `/auth` answers as a deployment's does. A grant for another owner is on but signs in nobody.
			if (name === "another owner") expect([name, ...(await errorOf(answer))]).toEqual([name, 401, NOT_VALID[1]]);
			else expect([name, ...(await errorOf(answer))]).toEqual([name, ...offAnswer]);
		}
		// A deployment's entry point, with the evaluator granted in the same environment, has no such route either.
		await pim.evaluatorGrant();
		expect(await production()).toEqual(offAnswer);
		expect(await errorOf(await pim.production(END, { body: { ...pim.identity, observation: OLD }, headers: { ...pim.authorization(), "x-pim-launch-evaluator-run": "r".repeat(43) } }))).toEqual(offAnswer);
		// The space's own RPC methods refuse while the evaluator is off, whoever calls them.
		delete settings.PREVIEW_LAUNCH_EVALUATOR;
		const space = previews.getByName(pim.owner);
		expect(await runInDurableObject(space, (instance: PreviewPim) => instance.launchForEvaluator())).toEqual({ outcome: "refused", reason: "off" });
		expect(await runInDurableObject(space, (instance: PreviewPim) => instance.endForEvaluator(OLD))).toEqual({ outcome: "refused", status: null });
		expect(await pim.runs()).toEqual([]);
		expect(pim.asked).toEqual([]);
		expect(await pim.oldRecord()).toBe(pim.before);
		expect(sent).toEqual([]);
	});

	it("never touches an earlier observation: an unresolved or open one refuses the launch, which nothing retries", async () => {
		for (const old of ["unconfirmed", "open"] as const) {
			const pim = await evaluator({ old });
			const refused = await pim.launch();
			expect([old, refused.status, await refused.json()]).toEqual([old, 409, { error: "The space started no observation.", run: { phase: "launch_refused", reason: "unresolved" } }]);
			// Not a replay of the open record, nor any request about the earlier one: the bridge was asked nothing.
			expect(pim.asked).toEqual([]);
			expect(await pim.oldRecord()).toBe(pim.before);
			expect(await pim.records()).toHaveLength(1);
			expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "launch_refused", observation_id: null })]);
			expect((await pim.launch()).status).toBe(409);
			expect((await pim.end("r".repeat(43), OLD)).status).toBe(401);
			expect(pim.asked).toEqual([]);
		}
	});

	it("ends only the recorded observation, with its run token, while open and before the run's deadline", async () => {
		const pim = await evaluator();
		const now = Date.now();
		at(now);
		const launched = (await (await pim.launch()).json()) as Launched;
		const fresh = launched.run.observation.id;
		// The earlier observation, any other ID, another run token or none, and the automation session are all refused, and nothing is asked.
		expect(await errorOf(await pim.end(launched.runToken, OLD))).toEqual([409, "This run can't end that observation now."]);
		expect(await errorOf(await pim.end(launched.runToken, crypto.randomUUID()))).toEqual([409, "This run can't end that observation now."]);
		expect(await errorOf(await pim.end("r".repeat(43), fresh))).toEqual(NOT_VALID);
		expect(await errorOf(await pim.end("", fresh))).toEqual(NOT_VALID);
		expect(await errorOf(await pim.end(launched.runToken, "../observations"))).toEqual(NOT_VALID);
		expect(await errorOf(await pim.end(launched.runToken, fresh, { headers: { origin: "https://evil.example" } }))).toEqual([403, "Requests must come from this app"]);
		expect(await errorOf(await pim.end(launched.runToken, fresh, { headers: pim.authorization(credential()) }))).toEqual(NOT_VALID);
		expect(pim.asked.map(({ action }) => action)).toEqual(["launch"]);
		expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "open" })]);

		// Past the run's deadline the run is over: it never ends from here, and stays so.
		at(now + 10 * MINUTE);
		expect(await (await pim.end(launched.runToken, fresh)).json()).toEqual({ error: "This run can't end that observation now.", run: { phase: "expired" } });
		at(now);
		expect(await (await pim.end(launched.runToken, fresh)).json()).toEqual({ error: "This run can't end that observation now.", run: { phase: "expired" } });
		expect(pim.asked.map(({ action }) => action)).toEqual(["launch"]);
		expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "expired", observation_id: fresh })]);
		expect((await pim.launch()).status).toBe(409);
	});

	it("stops at an uncertain or refused launch: no End is possible, and nothing is retried", async () => {
		const lost = await evaluator({ host: { launch: "lost" } });
		const uncertain = await lost.launch();
		expect([uncertain.status, await uncertain.json()]).toEqual([
			502,
			{ error: "Whether an observation started is uncertain. Nothing is retried, and nothing may end it from here.", run: { phase: "launch_uncertain", classification: "space_launch_uncertain" } },
		]);
		const [record] = (await lost.records()).filter((one) => one.observationId !== OLD);
		expect(record).toMatchObject({ status: "unconfirmed" });
		expect(await lost.runs()).toEqual([expect.objectContaining({ phase: "launch_uncertain", observation_id: record!.observationId })]);
		// No run token was answered, so no End can name the run; and the grant is spent.
		expect((await lost.end("r".repeat(43), record!.observationId)).status).toBe(401);
		expect((await lost.launch()).status).toBe(409);
		expect(lost.asked.map(({ action }) => action)).toEqual(["launch"]);

		const refusing = await evaluator({ host: { launch: "refused" } });
		const refused = await refusing.launch();
		expect([refused.status, await refused.json()]).toEqual([409, { error: "The space started no observation.", run: { phase: "launch_refused", reason: "not-opened" } }]);
		expect(await refusing.runs()).toEqual([expect.objectContaining({ phase: "launch_refused", observation_id: null })]);
		expect((await refusing.launch()).status).toBe(409);
		expect(refusing.asked.map(({ action }) => action)).toEqual(["launch"]);
	});

	it("does not retry an End whose answer was lost, and the run is over", async () => {
		const pim = await evaluator({ host: { end: "lost" } });
		const launched = (await (await pim.launch()).json()) as Launched;
		const fresh = launched.run.observation.id;
		const ended = await pim.end(launched.runToken, fresh);
		expect([ended.status, await ended.json()]).toEqual([502, { error: "Whether the end was asked for is uncertain. Nothing is retried.", run: { phase: "end_uncertain", observation: { id: fresh, status: "unconfirmed" } } }]);
		expect(await errorOf(await pim.end(launched.runToken, fresh))).toEqual([409, "This run can't end that observation now."]);
		expect((await pim.launch()).status).toBe(409);
		expect(pim.asked.map(({ action }) => action)).toEqual(["launch", "end"]);
		expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "end_uncertain" })]);
		expect(await pim.oldRecord()).toBe(pim.before);
	});

	it("as the isolated preview's one exception, starts one fresh observation beside exactly the named unconfirmed record, leaves that record exactly as it was, and never a third", async () => {
		const pim = await evaluator({ old: "unconfirmed", existingUnconfirmed: OLD });
		// The person's Watch keeps the rule as it was: refused beside the unconfirmed record, with nothing asked.
		expect((await pim.ask("/api/observations", { cookie: pim.passkey, method: "POST" })).status).toBe(409);
		expect(pim.asked).toEqual([]);

		const launched = (await (await pim.launch()).json()) as Launched & { run: { alongside: string | null } };
		const fresh = launched.run.observation.id;
		expect([launched.run.phase, launched.run.alongside, fresh === OLD]).toEqual(["open", OLD, false]);
		expect(await pim.oldRecord()).toBe(pim.before);
		expect((await pim.records()).map((record) => [record.observationId, record.status])).toEqual([
			[OLD, "unconfirmed"],
			[fresh, "open"],
		]);
		expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "open", observation_id: fresh, alongside_id: OLD })]);

		// The earlier record can't be ended, read in detail or reclassified through the run, and the person's Watch still starts nothing.
		expect(await errorOf(await pim.end(launched.runToken, OLD))).toEqual([409, "This run can't end that observation now."]);
		expect((await pim.ask("/api/observations", { cookie: pim.passkey, method: "POST" })).status).toBe(409);
		await pim.grant();
		const automation = await pim.signIn();
		for (const [path, method] of [[`/api/observations/${OLD}`, "GET"], [`/api/observations/${OLD}/end`, "POST"], ["/api/observations", "POST"]] as const) {
			expect([path, (await pim.ask(path, { cookie: automation, method })).status]).toEqual([path, 403]);
		}
		expect(pim.asked.map(({ action, body }) => [action, body.key])).toEqual([["launch", fresh]]);

		// The one End, of the fresh record only; the earlier one is still exactly as it was.
		expect((await pim.end(launched.runToken, fresh)).status).toBe(202);
		expect(await pim.oldRecord()).toBe(pim.before);
		expect(pim.asked.map(({ action, body }) => [action, body.key])).toEqual([
			["launch", fresh],
			["end", fresh],
		]);

		// No third: this grant is spent, and a new grant naming the same record finds two unresolved and starts nothing.
		expect((await pim.launch()).status).toBe(409);
		const renewed = credential();
		await pim.evaluatorGrant({}, renewed);
		const third = await pim.launch({ headers: pim.authorization(renewed) });
		expect([third.status, await third.json()]).toEqual([409, { error: "The space started no observation.", run: { phase: "launch_refused", reason: "unresolved" } }]);
		expect((await pim.launch({ headers: pim.authorization(renewed) })).status).toBe(409);
		expect(pim.asked).toHaveLength(2);
		expect(await pim.records()).toHaveLength(2);
		expect(await pim.oldRecord()).toBe(pim.before);
		// A deployment's entry point, with the same grant, has none of it.
		expect(await errorOf(await pim.production(LAUNCH, { body: pim.identity, headers: pim.authorization(renewed) }))).toEqual([401, "Sign in to Pim"]);
		expect(sent).toEqual([]);
	});

	it("refuses the exception beside an open record, beside two unresolved ones, beside another than the named one, or with nothing to stand beside, and spends the grant", async () => {
		const cases = [
			{ old: "open", existingUnconfirmed: OLD, reason: "named-not-unconfirmed" },
			{ old: "two-unconfirmed", existingUnconfirmed: OLD, reason: "unresolved" },
			{ old: "unconfirmed", existingUnconfirmed: OTHER_OLD, reason: "unresolved" },
			{ old: "not_opened", existingUnconfirmed: OLD, reason: "named-not-found" },
			{ old: "unconfirmed", existingUnconfirmed: undefined, reason: "unresolved" },
		] as const;
		for (const { old, existingUnconfirmed, reason } of cases) {
			const pim = await evaluator({ old, ...(existingUnconfirmed ? { existingUnconfirmed } : {}) });
			const refused = await pim.launch();
			expect([old, existingUnconfirmed, refused.status, await refused.json()]).toEqual([old, existingUnconfirmed, 409, { error: "The space started no observation.", run: { phase: "launch_refused", reason } }]);
			// Nothing was asked, replayed or recorded, and the earlier records are exactly as they were.
			expect(pim.asked).toEqual([]);
			expect(await pim.oldRecord()).toBe(pim.before);
			expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "launch_refused", observation_id: null, alongside_id: null })]);
			// Spent: the same grant does nothing more.
			expect(await errorOf(await pim.launch())).toEqual([409, "This launch evaluator grant has run already; it runs once."]);
			// No run token was answered, so no End can name the run.
			expect(await errorOf(await pim.end("r".repeat(43), OLD))).toEqual(NOT_VALID);
			expect(pim.asked).toEqual([]);
		}
	});

	it("admits only nothing unresolved, or exactly one named unconfirmed record: never beside one pending, open or revoking", () => {
		const now = Date.now();
		let state: ObservationState = initialObservationState("o_00000000000000000000000000");
		const step = (event: Parameters<typeof applyObservationEvent>[1]) => (state = applyObservationEvent(state, event).state);
		expect(evaluatorAdmission(state, null)).toEqual({ ok: true, alongside: null });
		expect(evaluatorAdmission(state, OLD)).toEqual({ ok: false, reason: "named-not-found" });
		step({ type: "open_requested", owner: state.owner, observationId: OLD, notAfter: now + MINUTE, now });
		expect(evaluatorAdmission(state, OLD)).toEqual({ ok: false, reason: "named-not-unconfirmed" });
		step({ type: "open_acknowledged", observationId: OLD, hostLaunchId: "OldLaunch0000000000001", hostGeneration: "gen-0" });
		expect(evaluatorAdmission(state, OLD)).toEqual({ ok: false, reason: "named-not-unconfirmed" });
		step({ type: "revoke_requested", observationId: OLD });
		expect(state.records[0]!.status).toBe("revoking");
		expect(evaluatorAdmission(state, OLD)).toEqual({ ok: false, reason: "named-not-unconfirmed" });
		step({ type: "unconfirmed", observationId: OLD, evidence: "lost" });
		expect(evaluatorAdmission(state, OLD)).toEqual({ ok: true, alongside: OLD });
		expect(evaluatorAdmission(state, null)).toEqual({ ok: false, reason: "unresolved" });
		expect(evaluatorAdmission(state, OTHER_OLD)).toEqual({ ok: false, reason: "unresolved" });
		step({ type: "open_requested", owner: state.owner, observationId: OTHER_OLD, notAfter: now + MINUTE, now });
		expect(evaluatorAdmission(state, OLD)).toEqual({ ok: false, reason: "unresolved" });
	});

	it("upgrades a runs table made by the evaluator's first schema, once, keeping its rows, then reads, claims and moves with the new column", async () => {
		// Exactly the table `0ff78ce` made, before `alongside_id`, holding one run as that version left it.
		const FIRST_SCHEMA =
			"CREATE TABLE IF NOT EXISTS preview_launch_evaluator_runs (grant_digest TEXT PRIMARY KEY, owner TEXT NOT NULL, evaluation TEXT NOT NULL, deployment TEXT NOT NULL, origin TEXT NOT NULL, run_digest TEXT NOT NULL, phase TEXT NOT NULL, observation_id TEXT, created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, updated_at INTEGER NOT NULL)";
		const [earlier, later] = ["a".repeat(64), "b".repeat(64)];
		const owner = "o_00000000000000000000000000";
		const identity = { owner, evaluation: EVALUATION, deployment: DEPLOYMENT, origin: ORIGIN };
		const fresh = "fresh-observation-0001";
		const directory = previewDirectories.getByName(`${crypto.randomUUID()}:directory`);
		const seen = await runInDurableObject(directory, (_instance, state) => {
			const sql = state.storage.sql;
			const columns = () => sql.exec("SELECT name FROM pragma_table_info('preview_launch_evaluator_runs')").toArray().map(({ name }) => String(name));
			sql.exec(FIRST_SCHEMA);
			sql.exec(
				"INSERT INTO preview_launch_evaluator_runs (grant_digest, owner, evaluation, deployment, origin, run_digest, phase, observation_id, created_at, deadline, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 1000, 601000, 1000)",
				earlier,
				owner,
				EVALUATION,
				DEPLOYMENT,
				ORIGIN,
				"c".repeat(64),
				OLD,
			);
			const before = columns();
			const ledger = new LaunchEvaluatorLedger(sql);
			const upgraded = columns();
			// Again, as every Directory call makes one: nothing more changes.
			new LaunchEvaluatorLedger(sql);
			const again = columns();
			const kept = ledger.read(earlier);
			// The earlier run moves on as it would have; a new run claims once and records what it started beside.
			const movedEarlier = ledger.move(earlier, "open", "ending", 2000);
			const claimed = ledger.claim({ grant: later, ...identity, run: "d".repeat(64), createdAt: 3000, deadline: 603000 });
			const claimedTwice = ledger.claim({ grant: later, ...identity, run: "e".repeat(64), createdAt: 3001, deadline: 603001 });
			const opened = ledger.move(later, "launching", "open", 4000, { observation: fresh, alongside: OLD });
			const openedTwice = ledger.move(later, "launching", "open", 4001, { observation: "fresh-observation-0002", alongside: null });
			return { before, upgraded, again, kept, movedEarlier, earlierAfter: ledger.read(earlier), claimed, claimedTwice, opened, openedTwice, laterAfter: ledger.read(later) };
		});
		expect(seen.before).not.toContain("alongside_id");
		expect(seen.upgraded).toEqual([...seen.before, "alongside_id"]);
		expect(seen.again).toEqual(seen.upgraded);
		expect(seen.kept).toEqual({ grant: earlier, ...identity, run: "c".repeat(64), phase: "open", observation: OLD, alongside: null, createdAt: 1000, deadline: 601000, updatedAt: 1000 });
		expect([seen.movedEarlier, seen.earlierAfter]).toEqual([true, { ...seen.kept, phase: "ending", updatedAt: 2000 }]);
		expect([seen.claimed, seen.claimedTwice, seen.opened, seen.openedTwice]).toEqual([true, false, true, false]);
		expect(seen.laterAfter).toEqual({ grant: later, ...identity, run: "d".repeat(64), phase: "open", observation: fresh, alongside: OLD, createdAt: 3000, deadline: 603000, updatedAt: 4000 });
	});

	const UNCERTAIN = "Whether an observation started is uncertain. Nothing is retried, and nothing may end it from here.";

	it("reaches the owner's space through the real route, getAgentByName and Pim.launchForEvaluator, classifies the launch certain_open, and keeps the original-record exception with no third", async () => {
		const pim = await evaluator({ old: "unconfirmed", existingUnconfirmed: OLD });
		const answer = await pim.launch();
		expect(answer.status).toBe(201);
		const launched = (await answer.json()) as Launched & { run: { classification: string; alongside: string | null } };
		const fresh = launched.run.observation.id;
		expect([launched.run.phase, launched.run.classification, launched.run.alongside]).toEqual(["open", "certain_open", OLD]);
		// The space's own Durable Object ran the launch: its stored ledger holds the original record exactly as it was, and the fresh one.
		const stored = JSON.parse((await runInDurableObject(pim.space, (instance: PreviewPim) => instance.store.meta(OBSERVATION_KEY)))!) as ObservationState;
		expect(stored.records.map((record) => [record.observationId, record.status])).toEqual([
			[OLD, "unconfirmed"],
			[fresh, "open"],
		]);
		expect(await pim.oldRecord()).toBe(pim.before);
		expect(pim.asked.map(({ action, body }) => [action, body.key])).toEqual([["launch", fresh]]);
		expect(pim.lines()).toEqual([expect.objectContaining({ action: "launch", outcome: "open", classification: "certain_open", alongside: OLD })]);
		// No third: the grant is spent, and a new grant finds two unresolved records and starts nothing.
		expect((await pim.launch()).status).toBe(409);
		const renewed = credential();
		await pim.evaluatorGrant({}, renewed);
		expect(await (await pim.launch({ headers: pim.authorization(renewed) })).json()).toEqual({ error: "The space started no observation.", run: { phase: "launch_refused", reason: "unresolved" } });
		expect(pim.asked).toHaveLength(1);
		expect(await pim.oldRecord()).toBe(pim.before);
	});

	it("classifies a space that throws before answering as owner_space_rpc_failure, says nothing of what it threw, and never ends anything", async () => {
		const pim = await evaluator({ old: "unconfirmed", existingUnconfirmed: OLD });
		// A start the fixture began and didn't finish: the space's object now throws on construction, so every RPC to it rejects.
		await runInDurableObject(pim.space, (instance: PreviewPim) => instance.store.setMeta(FIXTURE_KEY, "seeding"));
		await evictDurableObject(pim.space).catch(() => undefined);
		const answer = await pim.launch();
		expect([answer.status, await answer.json()]).toEqual([502, { error: UNCERTAIN, run: { phase: "launch_uncertain", classification: "owner_space_rpc_failure" } }]);
		expect(pim.asked).toEqual([]);
		expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "launch_uncertain", observation_id: null, alongside_id: null })]);
		expect(pim.lines()).toEqual([{ event: "preview.launch-evaluator", action: "launch", outcome: "launch_uncertain", classification: "owner_space_rpc_failure" }]);
		// Spent, and no End can name the run.
		expect(await errorOf(await pim.launch())).toEqual([409, "This launch evaluator grant has run already; it runs once."]);
		expect(await errorOf(await pim.end("r".repeat(43), OLD))).toEqual(NOT_VALID);
		expect(pim.asked).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("classifies a certain open answer the Directory can't record as post_rpc_recording_failure, hands out nothing of it, and never ends it", async () => {
		// The Directory's write of `open` fails, or writes nothing; the space's launch itself is certain.
		for (const [failure, action] of [
			["fails", "RAISE(ABORT, 'directory write failed for fresh-observation token')"],
			["writes nothing", "RAISE(IGNORE)"],
		] as const) {
			logged.length = 0;
			const pim = await evaluator({ old: "unconfirmed", existingUnconfirmed: OLD });
			await runInDurableObject(pim.directory, (_instance, state) => {
				new LaunchEvaluatorLedger(state.storage.sql);
				state.storage.sql.exec(`CREATE TRIGGER refuse_open BEFORE UPDATE OF phase ON preview_launch_evaluator_runs WHEN NEW.phase = 'open' BEGIN SELECT ${action}; END`);
			});
			const answer = await pim.launch();
			const body = await answer.json();
			expect([failure, answer.status, body]).toEqual([failure, 502, { error: UNCERTAIN, run: { phase: "launch_uncertain", classification: "post_rpc_recording_failure" } }]);
			// The space started it beside the original record, which is unchanged.
			const [, fresh] = await pim.records();
			expect([fresh?.status, pim.asked.map(({ action }) => action)]).toEqual(["open", ["launch"]]);
			expect(await pim.oldRecord()).toBe(pim.before);
			// The run keeps the fresh ID privately, as uncertain; no ID, viewer, token or cause left in the answer or the logs.
			expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "launch_uncertain", observation_id: fresh!.observationId, alongside_id: null })]);
			expect(pim.lines()).toEqual([{ event: "preview.launch-evaluator", action: "launch", outcome: "launch_uncertain", classification: "post_rpc_recording_failure" }]);
			const evaluatorText = JSON.stringify([body, pim.lines()]);
			for (const kept of [fresh!.observationId, TICKET, BRIDGE, "directory write failed", OLD]) expect(evaluatorText).not.toContain(kept);
			// Spent, and nothing ends it from here.
			expect((await pim.launch()).status).toBe(409);
			expect(await errorOf(await pim.end("r".repeat(43), fresh!.observationId))).toEqual(NOT_VALID);
			expect(pim.asked).toHaveLength(1);
		}
	});

	it("classifies an RPC answer of any other shape as space_answer_malformed before reading it, keeps none of it, and never ends anything", async () => {
		const RAW = "raw-answer-marker-0000000001";
		const fresh = "fresh-observation-000000001";
		const viewer = `${BRIDGE}/${LAUNCH_ID}/viewer/#ticket=${TICKET}&clipboard=0`;
		const open = { outcome: "open", observation: { id: fresh, notAfter: Date.now() + 10 * MINUTE }, viewer, alongside: OLD };
		const malformed: [string, unknown][] = [
			["no answer", null],
			["a string", RAW],
			["an unknown outcome", { outcome: RAW, observation: { id: fresh } }],
			["no observation", { ...open, observation: undefined }],
			["a null observation", { ...open, observation: null }],
			["a string observation", { ...open, observation: RAW }],
			["an array observation", { ...open, observation: [fresh] }],
			["an observation with no ID", { ...open, observation: { notAfter: open.observation.notAfter } }],
			["an observation ID not shaped as one", { ...open, observation: { id: `${RAW}/../x`, notAfter: open.observation.notAfter } }],
			["an end that isn't finite", { ...open, observation: { id: fresh, notAfter: Number.POSITIVE_INFINITY } }],
			["an end that isn't a number", { ...open, observation: { id: fresh, notAfter: RAW } }],
			["no viewer", { ...open, viewer: undefined }],
			["an empty viewer", { ...open, viewer: "" }],
			["a viewer that isn't a string", { ...open, viewer: { url: RAW } }],
			["beside a record the grant doesn't name", { ...open, alongside: OTHER_OLD }],
			["beside itself", { ...open, observation: { id: OLD, notAfter: open.observation.notAfter } }],
			["beside a record of the wrong type", { ...open, alongside: 7 }],
			["a refusal without a reason", { outcome: "refused", reason: { raw: RAW } }],
			["an uncertain answer naming an object", { outcome: "uncertain", observation: { id: RAW } }],
		];
		for (const [shape, value] of malformed) {
			logged.length = 0;
			const pim = await evaluator({ old: "unconfirmed", existingUnconfirmed: OLD });
			// The space's RPC answers `value` without asking the bridge.
			vi.spyOn(PreviewPim.prototype, "launchForEvaluator").mockResolvedValue(value as never);
			const answer = await pim.launch();
			const body = await answer.json();
			expect([shape, answer.status, body]).toEqual([shape, 502, { error: UNCERTAIN, run: { phase: "launch_uncertain", classification: "space_answer_malformed" } }]);
			expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "launch_uncertain", observation_id: null, alongside_id: null })]);
			expect(pim.lines()).toEqual([{ event: "preview.launch-evaluator", action: "launch", outcome: "launch_uncertain", classification: "space_answer_malformed" }]);
			const evaluatorText = JSON.stringify([body, logged]);
			for (const kept of [RAW, fresh, TICKET, BRIDGE, OLD, pim.secret]) expect([shape, evaluatorText.includes(kept)]).toEqual([shape, false]);
			// Spent, nothing ends from here, the bridge was never asked, and the original record is as it was.
			expect((await pim.launch()).status).toBe(409);
			expect(await errorOf(await pim.end("r".repeat(43), fresh))).toEqual(NOT_VALID);
			expect(await errorOf(await pim.end("r".repeat(43), OLD))).toEqual(NOT_VALID);
			expect(pim.asked).toEqual([]);
			expect(sent).toEqual([]);
			expect(await pim.oldRecord()).toBe(pim.before);
		}
	});

	it("carries the space's own uncertainty across the real RPC: a flush that failed before the host, or a launch it couldn't record after, is space_launch_uncertain with no ID, and leaves a second record", async () => {
		// The space's storage, failing at one point: its flush of the fresh intent, or its write of the host's acknowledged launch.
		for (const [fault, hostAsked] of [
			["flush", 0],
			["record", 1],
		] as const) {
			logged.length = 0;
			const pim = await evaluator({ old: "unconfirmed", existingUnconfirmed: OLD });
			await runInDurableObject(pim.space, (instance: PreviewPim, state) => {
				if (fault === "flush") vi.spyOn(state.storage, "sync").mockRejectedValue(new Error("flush failed"));
				const setMeta = instance.store.setMeta.bind(instance.store);
				vi.spyOn(instance.store, "setMeta").mockImplementation((key, value) => {
					if (fault === "record" && key === OBSERVATION_KEY && value.includes('"status":"open"')) throw new Error("write failed");
					setMeta(key, value);
				});
			});
			const answer = await pim.launch();
			expect([fault, answer.status, await answer.json()]).toEqual([fault, 502, { error: UNCERTAIN, run: { phase: "launch_uncertain", classification: "space_launch_uncertain" } }]);
			expect(pim.lines()).toEqual([{ event: "preview.launch-evaluator", action: "launch", outcome: "launch_uncertain", classification: "space_launch_uncertain" }]);
			// The space's answer named no record, so the run names none, though the space stored one: before the host was asked, or after it launched.
			expect(await pim.runs()).toEqual([expect.objectContaining({ phase: "launch_uncertain", observation_id: null, alongside_id: null })]);
			expect([fault, pim.asked.map(({ action }) => action)]).toEqual([fault, Array(hostAsked).fill("launch")]);
			await evictDurableObject(pim.space).catch(() => undefined);
			const [original, second, ...more] = await pim.records();
			expect([fault, original?.observationId, second?.status, second?.hostLaunchId, more]).toEqual([fault, OLD, "pending_open", null, []]);
			expect(await pim.oldRecord()).toBe(pim.before);
			// Restarted, the space holds the second record unconfirmed beside the original, and nothing starts a third or is asked.
			const listing = (await (await pim.ask("/api/observations", { cookie: pim.passkey })).json()) as { observations: { id: string; status: string; evidence: string | null }[] };
			expect(listing.observations).toEqual([
				expect.objectContaining({ id: second!.observationId, status: "unconfirmed", evidence: "restored while pending_open: the host may hold a launch for it" }),
				expect.objectContaining({ id: OLD, status: "unconfirmed" }),
			]);
			expect((await pim.ask("/api/observations", { cookie: pim.passkey, method: "POST" })).status).toBe(409);
			expect((await pim.launch()).status).toBe(409);
			expect(pim.asked).toHaveLength(hostAsked);
			expect(sent).toEqual([]);
		}
	});
});

/**
 * The automation session's aggregate check of the owner's stored
 * observations (preview/automation.ts's `SUMMARY_PATH`, the space's
 * `observationSummary`): through the real Worker, the Directory's session
 * check and the owner's Durable Object, with a ledger stored as a process
 * that died mid-launch and mid-end leaves it.
 */
describe("the automation session's observation summary", () => {
	const SUMMARY = "/auth/automation/observation-summary";
	const BRIDGE = "https://bridge.observation-summary.test";
	const BRIDGE_TOKEN = "observation-summary-bridge-token-0123456789";
	const ONLY = [401, "This summary is only for an automation session."];
	const ID = {
		pending: "summary-pending-00000001",
		revoking: "summary-revoking-0000001",
		revokingToo: "summary-revoking-0000002",
		open: "summary-open-00000000001",
		unconfirmed: "summary-unconfirmed-0001",
		closed: "summary-closed-000000001",
		refused: "summary-refused-00000001",
		refusedToo: "summary-refused-00000002",
		reconciled: "summary-reconciled-00001",
	};
	const EVIDENCE = ["evidence-marker-unconfirmed", "evidence-marker-closed", "evidence-marker-refused", "evidence-marker-reconciled"];
	const NOT_AFTER = 1_900_000_000_123;
	/** A record as the ledger stores it. */
	const stored = (owner: string, observationId: string, status: string, extra: Record<string, unknown> = {}) => ({ observationId, owner, notAfter: NOT_AFTER, hostLaunchId: null, hostGeneration: null, status, ...extra });
	const launched = (n: number) => ({ hostLaunchId: `SummaryLaunch${n}`.padEnd(22, "0"), hostGeneration: `summary-gen-${n}` });
	/** Every status, transient ones included, in counts that differ: a summary that recovered or swapped any of them differs. */
	const everyStatus = (owner: string) => [
		stored(owner, ID.pending, "pending_open"),
		stored(owner, ID.revoking, "revoking", launched(1)),
		stored(owner, ID.revokingToo, "revoking", launched(2)),
		stored(owner, ID.open, "open", launched(3)),
		stored(owner, ID.unconfirmed, "unconfirmed", { evidence: EVIDENCE[0] }),
		stored(owner, ID.closed, "closed_observed", { ...launched(4), evidence: EVIDENCE[1] }),
		stored(owner, ID.refused, "not_opened", { evidence: EVIDENCE[2] }),
		stored(owner, ID.refusedToo, "not_opened", { evidence: EVIDENCE[2] }),
		stored(owner, ID.reconciled, "reconciled", { evidence: EVIDENCE[3] }),
	];
	const AS_STORED = { pending_open: 1, open: 1, revoking: 2, unconfirmed: 1, closed_observed: 1, not_opened: 2, reconciled: 1 };

	/**
	 * An evaluation whose owner's space the fixture seeded, holding `records`
	 * as stored text, with a bridge that answers an end as requested and
	 * counts every call. The space is evicted, so the next use constructs it.
	 */
	async function seeded(records: (owner: string) => Record<string, unknown>[] = everyStatus) {
		const pim = await evaluation();
		settings.PREVIEW_CUA_FIXTURE = "seed";
		settings.PREVIEW_CUA_FIXTURE_OWNER = pim.owner;
		settings.CUA_BRIDGES = JSON.stringify({ [pim.owner]: { url: `${BRIDGE}/${pim.owner}`, token: BRIDGE_TOKEN } });
		const space = previews.getByName(pim.owner);
		await evictDurableObject(space).catch(() => undefined);
		const text = JSON.stringify({ version: initialObservationState(pim.owner).version, owner: pim.owner, records: records(pim.owner) });
		await runInDurableObject(space, (instance: PreviewPim) => instance.store.setMeta(OBSERVATION_KEY, text));
		await evictDurableObject(space).catch(() => undefined);
		const asked: { action: string; body: Record<string, unknown> }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const prefix = `${BRIDGE}/${pim.owner}/observations/`;
			if (!request.url.startsWith(prefix)) {
				sent.push(request.url);
				throw new Error("This test reaches only its bridge's management");
			}
			const action = request.url.slice(prefix.length);
			asked.push({ action, body: JSON.parse(await request.text()) as Record<string, unknown> });
			if (action === "end") return Response.json({ outcome: "requested", recorded: true });
			throw new Error(`The test's bridge was asked for ${action}`);
		});
		const held = () => runInDurableObject(space, (instance: PreviewPim) => instance.store.meta(OBSERVATION_KEY));
		const summary = (init: Ask = {}) => pim.ask(SUMMARY, init);
		/** The summary route's own log lines, parsed. */
		const lines = () => logged.map(([line]) => String(line)).filter((line) => line.includes('"observation-summary"')).map((line) => JSON.parse(line) as Record<string, unknown>);
		return { ...pim, space, text, asked, held, summary, lines };
	}

	it("counts every status exactly as stored, through the Worker, the Directory and the owner's space, and writes, flushes and asks nothing", async () => {
		const pim = await seeded();
		const cookie = await pim.signIn();
		// The space is constructed afresh before the check, and making it restored nothing: the desk isn't made until used.
		const counted = { writes: [] as string[], put: 0, delete: 0, sync: 0, transaction: 0, setMeta: 0, alarm: 0 };
		await runInDurableObject(pim.space, (instance: PreviewPim, state) => {
			expect(instance.store.meta(OBSERVATION_KEY)).toBe(pim.text);
			const exec = state.storage.sql.exec.bind(state.storage.sql);
			vi.spyOn(state.storage.sql, "exec").mockImplementation(((query: string, ...bindings: unknown[]) => {
				if (!/^\s*(SELECT|PRAGMA)\b/i.test(query)) counted.writes.push(query);
				return exec(query, ...bindings);
			}) as never);
			for (const [method, key] of [["put", "put"], ["delete", "delete"], ["sync", "sync"], ["transactionSync", "transaction"], ["setAlarm", "alarm"], ["deleteAlarm", "alarm"], ["deleteAll", "delete"]] as const) {
				const real = (state.storage[method] as (...args: unknown[]) => unknown).bind(state.storage);
				vi.spyOn(state.storage, method).mockImplementation(((...args: unknown[]) => {
					counted[key] += 1;
					return real(...args);
				}) as never);
			}
			const setMeta = instance.store.setMeta.bind(instance.store);
			vi.spyOn(instance.store, "setMeta").mockImplementation((key, value) => {
				counted.setMeta += 1;
				setMeta(key, value);
			});
		});
		const tables = () =>
			runInDurableObject(pim.space, (_instance, state) =>
				state.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name")
					.toArray()
					.map(({ name }) => [name, state.storage.sql.exec(`SELECT * FROM "${String(name)}"`).toArray()]),
			);
		const before = await tables();
		counted.writes.length = 0;
		logged.length = 0;

		const answer = await pim.summary({ cookie });
		expect(answer.status).toBe(200);
		expect(answer.headers.get("cache-control")).toBe("no-store");
		expect(answer.headers.getSetCookie()).toEqual([]);
		const text = await answer.text();
		expect(JSON.parse(text)).toEqual({ kind: "observation-summary", ledger: "valid", total: 9, counts: AS_STORED });
		// Nothing was written or flushed in the space, its ledger is byte for byte as stored, and no bridge, host or client was reached.
		expect(counted).toEqual({ writes: [], put: 0, delete: 0, sync: 0, transaction: 0, setMeta: 0, alarm: 0 });
		expect(await pim.held()).toBe(pim.text);
		expect(await tables()).toEqual(before);
		expect([pim.asked, sent]).toEqual([[], []]);
		// Asked again, the same: the check changes nothing that a later check would see.
		expect(await (await pim.summary({ cookie, headers: { origin: ORIGIN } })).json()).toEqual(JSON.parse(text));
		expect(await pim.held()).toBe(pim.text);

		// Its answer and its log say nothing of any record, the owner, the session or the bridge.
		expect(pim.lines()).toEqual([
			{ event: "preview.automation", action: "observation-summary", outcome: "answered", ledger: "valid" },
			{ event: "preview.automation", action: "observation-summary", outcome: "answered", ledger: "valid" },
		]);
		const said = JSON.stringify([text, logged]);
		for (const kept of [...Object.values(ID), ...EVIDENCE, "SummaryLaunch", "summary-gen", String(NOT_AFTER), pim.owner, pim.secret, cookie.split("=")[1]!, BRIDGE, BRIDGE_TOKEN, "autoowner"]) {
			expect([kept, said.includes(kept)]).toEqual([kept, false]);
		}
	});

	it("says a missing or malformed ledger is so, with nothing of it, and still writes nothing", async () => {
		for (const [ledger, write] of [
			["missing", null],
			["invalid", "{not json"],
			["invalid", JSON.stringify({ version: 1, owner: "o_00000000000000000000000000", records: [] })],
			["invalid", "evidence-marker-raw"],
		] as const) {
			const pim = await seeded();
			await runInDurableObject(pim.space, (instance: PreviewPim, state) => {
				if (write === null) state.storage.sql.exec("DELETE FROM pim_meta WHERE key = ?", OBSERVATION_KEY);
				else instance.store.setMeta(OBSERVATION_KEY, write);
			});
			await evictDurableObject(pim.space).catch(() => undefined);
			const cookie = await pim.signIn();
			const answer = await pim.summary({ cookie });
			const text = await answer.text();
			expect([write, answer.status, JSON.parse(text)]).toEqual([write, 200, { kind: "observation-summary", ledger, total: null, counts: null }]);
			expect(await pim.held()).toBe(write ?? undefined);
			expect(text).not.toContain("evidence-marker");
			expect(JSON.stringify(logged)).not.toContain("evidence-marker");
			expect([pim.asked, sent]).toEqual([[], []]);
		}
	});

	it("answers only a plain GET on a current automation session for the claimed, active owner, and is nowhere else", async () => {
		const pim = await seeded();
		const cookie = await pim.signIn();
		// The control.
		expect((await pim.summary({ cookie })).status).toBe(200);
		logged.length = 0;

		// No session, the owner's passkey session, an API token, or a token beside the session: none is an automation session.
		const token = (await (await pim.ask("/auth/tokens", { cookie: pim.passkey, body: { name: "cli" } })).json()) as { token: string };
		expect(await errorOf(await pim.summary())).toEqual(ONLY);
		expect(await errorOf(await pim.summary({ cookie: pim.passkey }))).toEqual(ONLY);
		expect(await errorOf(await pim.summary({ headers: { authorization: `Bearer ${token.token}` } }))).toEqual(ONLY);
		expect(await errorOf(await pim.summary({ cookie, headers: { authorization: `Bearer ${token.token}` } }))).toEqual(ONLY);
		expect(await errorOf(await pim.summary({ cookie, credential: pim.secret }))).toEqual(ONLY);
		expect(await errorOf(await pim.summary({ cookie: `${pim.passkey}; __Host-pim-automation=${"a".repeat(43)}` }))).toEqual(ONLY);
		expect(await errorOf(await pim.summary({ cookie, headers: { "sec-fetch-site": "cross-site" } }))).toEqual(ONLY);
		// Only GET, from Pim's own origin or with none; no query, and no socket.
		for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
			const answer = await pim.summary({ cookie, method, headers: { origin: ORIGIN } });
			expect([method, answer.status]).toEqual([method, 405]);
		}
		expect(await errorOf(await pim.summary({ cookie, method: "POST", asIs: true }))).toEqual([403, "Requests must come from this app"]);
		expect(await errorOf(await pim.summary({ cookie, headers: { origin: "https://evil.example" } }))).toEqual([403, "Requests must come from this app"]);
		const plain = [400, "This summary takes a plain GET, with no query or upgrade."];
		for (const path of [`${SUMMARY}?`, `${SUMMARY}?owner=${pim.owner}`, `${SUMMARY}?id=${ID.pending}`]) expect([path, ...(await errorOf(await pim.ask(path, { cookie })))]).toEqual([path, ...plain]);
		for (const upgrade of ["websocket", "WebSocket", "h2c"]) {
			const answer = await pim.summary({ cookie, headers: { upgrade, connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", origin: ORIGIN } });
			expect([upgrade, answer.webSocket ?? null, ...(await errorOf(answer))]).toEqual([upgrade, null, ...plain]);
		}
		// No per-record route: anything under it is no route of the summary's.
		for (const path of [`${SUMMARY}/${ID.pending}`, `${SUMMARY}/`]) expect([path, (await pim.ask(path, { cookie })).status]).toEqual([path, (await pim.production(path, { cookie })).status]);
		// At any other address the evaluation answers nothing.
		expect((await pim.summary({ cookie, at: "https://evil.example" })).status).toBe(421);

		// A session past its 30 minutes, one ended, one of a revoked grant, or a grant for another owner: refused.
		const now = Date.now();
		at(now + 31 * MINUTE);
		expect(await errorOf(await pim.summary({ cookie }))).toEqual(ONLY);
		vi.mocked(Date.now).mockRestore();
		const ended = await pim.signIn();
		await pim.ask("/auth/automation/session", { cookie: ended, method: "DELETE" });
		expect(await errorOf(await pim.summary({ cookie: ended }))).toEqual(ONLY);
		await pim.grant({ owner: "o_00000000000000000000000000" });
		expect(await errorOf(await pim.summary({ cookie }))).toEqual(ONLY);
		await pim.grant();
		const live = await pim.signIn();
		expect((await pim.summary({ cookie: live })).status).toBe(200);
		// A suspended owner's session opens nothing.
		await runInDurableObject(pim.directory, (instance: EvalDirectory) => instance.setStatus(pim.owner, "suspended", "test"));
		expect((await pim.summary({ cookie: live })).status).toBe(401);
		await runInDurableObject(pim.directory, (instance: EvalDirectory) => instance.setStatus(pim.owner, "active", "test"));
		expect((await pim.summary({ cookie: live })).status).toBe(200);
		await pim.ask("/auth/automation/revoke", { body: pim.identity, credential: pim.secret });
		expect(await errorOf(await pim.summary({ cookie: live }))).toEqual(ONLY);

		// Off, it isn't there: `/auth` answers as a deployment's does, as does a deployment's entry point with everything copied.
		const offAnswer = await errorOf(await pim.production(SUMMARY, { cookie }));
		await pim.grant({}, credential());
		const fresh = await pim.signIn().catch(() => null);
		expect(fresh).toBeNull();
		for (const [name, turnOff] of [
			["no flag", async () => void delete settings.PREVIEW_AUTOMATION],
			["another flag", async () => void (settings.PREVIEW_AUTOMATION = "true")],
			["no grant", async () => void delete settings.PREVIEW_AUTOMATION_GRANT],
			["another runtime", () => pim.grant({ deployment: "cua-eval@cloudflare" })],
			["a past deadline", () => pim.grant({ notAfter: new Date(Date.now() - 1000).toISOString() })],
		] as const) {
			await pim.grant();
			await turnOff();
			expect([name, ...(await errorOf(await pim.summary({ cookie: live })))]).toEqual([name, ...offAnswer]);
		}
		await pim.grant();
		expect(await errorOf(await pim.production(SUMMARY, { cookie: live }))).toEqual(offAnswer);
		// Nor does the local preview mount it, whatever its environment says.
		delete settings.PREVIEW_MODE;
		delete settings.PIM_RUNTIME;
		settings.PIM_PUBLIC_URL = "http://localhost:8787";
		try {
			const local = await previewWorker.fetch(new Request(`http://localhost:8787${SUMMARY}`, { headers: { cookie: live } }) as never, env as never, createExecutionContext());
			expect(local.status).not.toBe(200);
			expect(await local.text()).not.toContain("observation-summary");
		} finally {
			settings.PIM_PUBLIC_URL = ORIGIN;
			settings.PREVIEW_MODE = "cua-eval";
			settings.PIM_RUNTIME = "celld";
		}

		// The space's RPC answers nothing to anyone outside the evaluation's grant for its own owner, or in another space.
		const direct = () => runInDurableObject(pim.space, (instance: PreviewPim) => instance.observationSummary());
		await pim.grant();
		expect(await direct()).toEqual({ ledger: "valid", total: 9, counts: AS_STORED });
		delete settings.PREVIEW_AUTOMATION;
		expect(await direct()).toBeNull();
		await pim.grant({ owner: "o_00000000000000000000000000" });
		expect(await direct()).toBeNull();
		await pim.grant();
		settings.PREVIEW_MODE = "local";
		expect(await direct()).toBeNull();
		settings.PREVIEW_MODE = "cua-eval";
		const other = previews.getByName("o_11111111111111111111111111");
		expect(await runInDurableObject(other, (instance: PreviewPim) => instance.observationSummary())).toBeNull();

		// Through all of it the ledger stayed as stored, and nothing was asked of any bridge.
		expect(await pim.held()).toBe(pim.text);
		expect([pim.asked, sent]).toEqual([[], []]);
		for (const line of pim.lines()) expect(Object.keys(line).sort()).toEqual(expect.arrayContaining(["action", "event", "outcome"]));
		const said = JSON.stringify(logged);
		for (const kept of [...Object.values(ID), pim.secret, live.split("=")[1]!, token.token]) expect([kept, said.includes(kept)]).toEqual([kept, false]);
	});

	it("leaves the person's list, Watch and End recovering transient records when the desk is first used, as before", async () => {
		// The list: the first use of the desk restores both transient kinds as unconfirmed and writes them back.
		const listed = await seeded();
		const cookie = await listed.signIn();
		expect(await (await listed.summary({ cookie })).json()).toMatchObject({ counts: AS_STORED });
		const list = (await (await listed.ask("/api/observations", { cookie: listed.passkey })).json()) as { observations: { id: string; status: string; evidence: string | null }[] };
		const recovered = (status: string) => `restored while ${status}: the host may hold a launch for it`;
		expect(list.observations.filter(({ id }) => [ID.pending, ID.revoking, ID.revokingToo].includes(id))).toEqual([
			expect.objectContaining({ id: ID.revokingToo, status: "unconfirmed", evidence: recovered("revoking") }),
			expect.objectContaining({ id: ID.revoking, status: "unconfirmed", evidence: recovered("revoking") }),
			expect.objectContaining({ id: ID.pending, status: "unconfirmed", evidence: recovered("pending_open") }),
		]);
		const written = JSON.parse((await listed.held())!) as ObservationState;
		expect(written.records.map((record) => record.status)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed", "open", "unconfirmed", "closed_observed", "not_opened", "not_opened", "reconciled"]);
		// The summary reads what is stored now, which is what the desk wrote.
		expect(await (await listed.summary({ cookie })).json()).toMatchObject({ total: 9, counts: { ...AS_STORED, pending_open: 0, revoking: 0, unconfirmed: 4 } });
		expect(listed.asked).toEqual([]);

		// Watch: with a record left pending, its first use restores it unconfirmed, and nothing new starts past it.
		const watched = await seeded((owner) => [stored(owner, ID.pending, "pending_open")]);
		const watch = await watched.ask("/api/observations", { cookie: watched.passkey, method: "POST" });
		expect(watch.status).toBe(409);
		expect((JSON.parse((await watched.held())!) as ObservationState).records).toEqual([expect.objectContaining({ observationId: ID.pending, status: "unconfirmed", evidence: recovered("pending_open") })]);
		expect(watched.asked).toEqual([]);

		// End: a record left revoking comes back unconfirmed, and its known launch is asked to end again; one left pending
		// comes back unconfirmed with no launch to end, rather than as still starting.
		const ending = await seeded((owner) => [stored(owner, ID.pending, "pending_open"), stored(owner, ID.revoking, "revoking", launched(1))]);
		const end = await ending.ask(`/api/observations/${ID.revoking}/end`, { cookie: ending.passkey, method: "POST" });
		expect(end.status).toBe(202);
		expect(((await end.json()) as { observation: unknown }).observation).toEqual({ id: ID.revoking, status: "unconfirmed", notAfter: NOT_AFTER, evidence: recovered("revoking") });
		expect(ending.asked).toEqual([{ action: "end", body: { owner: ending.owner, key: ID.revoking, generation: launched(1).hostGeneration } }]);
		expect(await errorOf(await ending.ask(`/api/observations/${ID.pending}/end`, { cookie: ending.passkey, method: "POST" }))).toEqual([
			409,
			"The computer never named a launch for this observation, so there is nothing to ask it to end.",
		]);
		expect((JSON.parse((await ending.held())!) as ObservationState).records.map((record) => [record.observationId, record.status, record.evidence])).toEqual([
			[ID.pending, "unconfirmed", recovered("pending_open")],
			[ID.revoking, "unconfirmed", recovered("revoking")],
		]);
	});
});

/**
 * The owner's own Watch, `POST /api/observations` from their passkey session,
 * through the evaluation's real Worker: the gateway's session check and
 * observation mount, the owner's Durable Object and its desk, the space's own
 * storage and `storage.sync()`, and the real viewer client with its
 * production bounds, against a bridge host written in `fetch`. It is the
 * route the launch evaluator doesn't take: no Directory run and no RPC.
 * Every host here is a local stand-in, so nothing here says why a live
 * launch went as it did.
 */
describe("the owner's Watch through the evaluation's Worker", () => {
	const BRIDGE = "https://bridge.owner-watch.test";
	const BRIDGE_TOKEN = "owner-watch-bridge-token-0123456789abcd";
	const LAUNCH_ID = "OwnerWatchLaunch000001";
	const TICKET = "owner-watch-ticket-".padEnd(43, "w");
	const VIEWER = `${BRIDGE}/${LAUNCH_ID}/viewer/#ticket=${TICKET}&clipboard=0`;
	const LOST = "The computer's answer was lost; the observation may be open.";
	const NOT_SETTLED = "Another observation is open or not settled yet. Stop it, or check it again.";
	const BLOCKED = "Watching isn't available: a change to the ledger couldn't be stored.";
	const RESTORED = "restored while pending_open: the host may hold a launch for it";

	type Launch = { key: string; owner: string; notAfter: number };
	type View = { id: string; status: string; notAfter: number; evidence: string | null };
	const launched = (body: Launch, changes: Record<string, unknown> = {}) =>
		Response.json({ outcome: "launched", key: body.key, launchId: LAUNCH_ID, generation: "gen-1", notAfter: body.notAfter, viewerPath: `/${LAUNCH_ID}/viewer/#ticket=${TICKET}&clipboard=0`, replayed: false, ...changes });

	/**
	 * An evaluation whose owner's space the fixture seeded, with an empty
	 * ledger, and a bridge host whose launch answers as `host.launch` says.
	 * `steps` records, in order, each write of the ledger (by its newest
	 * record's status), each flush, and each request the host received, once
	 * `instrument` has put the space's storage under watch, with a fault if given.
	 */
	async function watcher() {
		const pim = await evaluation({ grant: false });
		settings.PREVIEW_CUA_FIXTURE = "seed";
		settings.PREVIEW_CUA_FIXTURE_OWNER = pim.owner;
		settings.CUA_BRIDGES = JSON.stringify({ [pim.owner]: { url: `${BRIDGE}/${pim.owner}`, token: BRIDGE_TOKEN } });
		const space = previews.getByName(pim.owner);
		await evictDurableObject(space).catch(() => undefined);
		const steps: string[] = [];
		const host: { launch: (body: Launch) => Response | Promise<Response> } = { launch: (body) => launched(body) };
		const asked: { action: string; body: Launch; authorization: string | null; space: string | null }[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const prefix = `${BRIDGE}/${pim.owner}/observations/`;
			if (!request.url.startsWith(prefix)) {
				sent.push(request.url);
				throw new Error("This test reaches only its bridge's management");
			}
			const action = request.url.slice(prefix.length);
			const body = JSON.parse(await request.text()) as Launch;
			asked.push({ action, body, authorization: request.headers.get("authorization"), space: request.headers.get("x-pim-space") });
			steps.push(`host ${action}`);
			if (action !== "launch") throw new Error(`The test's bridge was asked for ${action}`);
			return await host.launch(body);
		});
		/** The spies `instrument` put on one instance's storage, taken off when it restarts. */
		const instrumented: { mockRestore(): void }[] = [];
		const instrument = (fault: { write?: string; flush?: () => Promise<void> } = {}) =>
			runInDurableObject(space, (instance: PreviewPim, state) => {
				const sync = state.storage.sync.bind(state.storage);
				const flushes = vi.spyOn(state.storage, "sync").mockImplementation(async () => {
					try {
						await (fault.flush ?? sync)();
					} catch (error) {
						steps.push("flush failed");
						throw error;
					}
					steps.push("flushed");
				});
				const setMeta = instance.store.setMeta.bind(instance.store);
				const writes = vi.spyOn(instance.store, "setMeta").mockImplementation((key, value) => {
					if (key !== OBSERVATION_KEY) return setMeta(key, value);
					const status = (JSON.parse(value) as ObservationState).records.at(-1)?.status;
					if (status === fault.write) {
						steps.push(`write ${status} failed`);
						throw new Error("write failed");
					}
					setMeta(key, value);
					steps.push(`write ${status}`);
				});
				instrumented.push(flushes, writes);
			});
		const ledger = async () => (JSON.parse((await runInDurableObject(space, (instance: PreviewPim) => instance.store.meta(OBSERVATION_KEY)))!) as ObservationState).records;
		/** The space ended and started again, its ledger as stored; with `empty`, the ledger emptied first, as a fresh fixture leaves it. */
		const restart = async (empty = false) => {
			for (const spy of instrumented.splice(0)) spy.mockRestore();
			if (empty) await runInDurableObject(space, (instance: PreviewPim) => instance.store.setMeta(OBSERVATION_KEY, JSON.stringify(initialObservationState(pim.owner))));
			await evictDurableObject(space).catch(() => undefined);
			steps.length = 0;
			asked.length = 0;
		};
		const watch = () => pim.ask("/api/observations", { cookie: pim.passkey, method: "POST" });
		const listing = async () => (await (await pim.ask("/api/observations", { cookie: pim.passkey })).json()) as { blocked: string | null; observations: View[] };
		const read = async (answer: Response) => [answer.status, await answer.json()] as const;
		return { ...pim, space, steps, host, asked, instrument, ledger, restart, watch, listing, read };
	}

	it("stores the intent and makes it durable before asking the host once, then answers the host's viewer through the Worker", async () => {
		const w = await watcher();
		await w.instrument();
		const answer = await w.watch();
		expect(answer.status).toBe(200);
		expect([answer.headers.get("cache-control"), answer.headers.get("referrer-policy")]).toEqual(["no-store", "no-referrer"]);
		const body = (await answer.json()) as { observation: View; viewer: string };
		const { id, notAfter } = body.observation;
		expect(body).toEqual({ observation: { id, status: "open", notAfter, evidence: null }, viewer: VIEWER });
		expect(w.steps).toEqual(["write pending_open", "flushed", "host launch", "write open"]);
		expect(w.asked).toEqual([{ action: "launch", body: { key: id, owner: w.owner, notAfter }, authorization: `Bearer ${BRIDGE_TOKEN}`, space: w.owner }]);
		expect(await w.ledger()).toEqual([expect.objectContaining({ observationId: id, status: "open", hostLaunchId: LAUNCH_ID, hostGeneration: "gen-1" })]);
		// The launch's credential is in this answer only: not stored or logged, and the bridge's token is in neither either.
		for (const kept of [JSON.stringify(await w.ledger()), JSON.stringify(logged)]) for (const secret of [TICKET, BRIDGE_TOKEN]) expect(kept).not.toContain(secret);
		expect(sent).toEqual([]);
	});

	it("asks the host nothing when the intent can't be stored or made durable; a failed flush leaves a record a restart holds unconfirmed", async () => {
		// The intent's write fails: nothing is stored or asked, and this instance stays blocked until the space restarts.
		const w = await watcher();
		await w.instrument({ write: "pending_open" });
		expect(await errorOf(await w.watch())).toEqual([503, "The observation couldn't be recorded (storage), so nothing was asked of the computer."]);
		expect(await errorOf(await w.watch())).toEqual([503, BLOCKED]);
		expect(w.steps).toEqual(["write pending_open failed"]);
		expect([w.asked, await w.ledger()]).toEqual([[], []]);
		await w.restart();
		expect((await w.read(await w.watch()))[0]).toBe(200);
		expect(w.asked).toHaveLength(1);

		// The flush fails after the intent was written: nothing is asked. Whether a real failed flush kept the write, nothing here can
		// say; kept, a restart restores it as unconfirmed, like a lost answer, and nothing new starts past it.
		await w.restart(true);
		await w.instrument({ flush: () => Promise.reject(new Error("flush failed")) });
		expect(await errorOf(await w.watch())).toEqual([503, "The observation couldn't be made durable, so nothing was asked of the computer."]);
		expect(w.steps).toEqual(["write pending_open", "flush failed"]);
		expect(w.asked).toEqual([]);
		const [intent] = await w.ledger();
		expect(intent).toMatchObject({ status: "pending_open", hostLaunchId: null });
		await w.restart();
		expect((await w.listing()).observations).toEqual([{ id: intent!.observationId, status: "unconfirmed", notAfter: intent!.notAfter, evidence: RESTORED }]);
		expect(await errorOf(await w.watch())).toEqual([409, NOT_SETTLED]);
		expect(w.asked).toEqual([]);
		expect(sent).toEqual([]);
	});

	it("holds a lost, unavailable, redirected, unreadable or unconfirmed launch answer unconfirmed, answers 502 through the Worker, and never asks again", async () => {
		const w = await watcher();
		const cases: [string, (body: Launch) => Response, string, string][] = [
			["unreachable", () => {
				throw new TypeError("connection refused");
			}, LOST, "the host's answer to launch was lost (unreachable)"],
			["a proxy's 502", () => new Response("<html>Bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }), LOST, "the host's answer to launch was lost (status)"],
			["a proxy's 520", () => new Response(null, { status: 520 }), LOST, "the host's answer to launch was lost (status)"],
			["503", () => new Response(null, { status: 503, headers: { "retry-after": "5" } }), LOST, "the host's answer to launch was lost (unavailable)"],
			["a redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }), LOST, "the host's answer to launch was lost (redirect)"],
			["HTML", (body) => new Response(JSON.stringify({ outcome: "launched", key: body.key }), { headers: { "content-type": "text/html" } }), LOST, "the host's answer to launch was lost (malformed)"],
			["cut-off JSON", () => new Response('{"outcome":"launched"', { headers: { "content-type": "application/json" } }), LOST, "the host's answer to launch was lost (malformed)"],
			["an extra field", (body) => launched(body, { extra: true }), LOST, "the host's answer to launch was lost (malformed)"],
			["another host version's viewer path", (body) => launched(body, { viewerPath: `/${LAUNCH_ID}/viewer/#ticket=${TICKET}` }), LOST, "the host's answer to launch was lost (malformed)"],
			["another key", (body) => launched(body, { key: `${body.key}x` }), "The computer answered for another observation.", "the host answered for another key"],
			["unconfirmed", (body) => Response.json({ outcome: "unconfirmed", key: body.key, reason: "timeout" }), "The computer can't say whether watching started.", "the host answered unconfirmed (timeout)"],
		];
		for (const [shape, answer, error, evidence] of cases) {
			await w.restart(true);
			w.host.launch = answer;
			const [status, body] = await w.read(await w.watch());
			const { id, notAfter } = (body as { observation: View }).observation;
			expect([shape, status, body]).toEqual([shape, 502, { error, observation: { id, status: "unconfirmed", notAfter, evidence } }]);
			expect([shape, w.asked.length]).toEqual([shape, 1]);
			// The outcome stays unknown: no fresh Watch, no replay of the key, no status read or End without a launch to name.
			expect(await w.read(await w.watch())).toEqual([409, { error: NOT_SETTLED, observation: { id, status: "unconfirmed", notAfter, evidence } }]);
			expect(await w.read(await w.ask(`/api/observations/${id}`, { cookie: w.passkey }))).toEqual([200, { observation: { id, status: "unconfirmed", notAfter, evidence } }]);
			expect(await errorOf(await w.ask(`/api/observations/${id}/end`, { cookie: w.passkey, method: "POST" }))).toEqual([409, "The computer never named a launch for this observation, so there is nothing to ask it to end."]);
			await w.restart();
			expect(await errorOf(await w.watch())).toEqual([409, NOT_SETTLED]);
			expect([shape, w.asked]).toEqual([shape, []]);
		}
		expect(sent).toEqual([]);
	});

	it("keeps the host's launch it couldn't record as open out of every answer, blocks, and holds the record unconfirmed after a restart", async () => {
		const w = await watcher();
		await w.instrument({ write: "open" });
		const answer = await w.watch();
		const text = await answer.text();
		const { id, notAfter } = (JSON.parse(text) as { observation: View }).observation;
		expect([answer.status, JSON.parse(text)]).toEqual([503, { error: "The observation couldn't be recorded as open.", observation: { id, status: "pending_open", notAfter, evidence: null } }]);
		expect(text).not.toContain(TICKET);
		expect(w.steps).toEqual(["write pending_open", "flushed", "host launch", "write open failed"]);
		expect(await w.listing()).toMatchObject({ blocked: "a change to the ledger couldn't be stored", observations: [{ id, status: "pending_open" }] });
		expect(await errorOf(await w.watch())).toEqual([503, BLOCKED]);
		// The host holds a launch the ledger never named: after a restart the record is unconfirmed, with nothing to end, and nothing starts past it.
		await w.restart();
		expect((await w.listing()).observations).toEqual([{ id, status: "unconfirmed", notAfter, evidence: RESTORED }]);
		expect(await errorOf(await w.watch())).toEqual([409, NOT_SETTLED]);
		expect(w.asked).toEqual([]);
		expect(JSON.stringify([await w.ledger(), logged])).not.toContain(TICKET);
	});

	it("gives up on the host after the client's own bound, never asks again, and lets a late answer go; a deadline before the host asks nothing, and one during it hands out no viewer", async () => {
		const w = await watcher();
		// The client's production bound, MANAGE_MS, shortened for this test only where it is set.
		const timeout = globalThis.setTimeout;
		const bounds: number[] = [];
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms === MANAGE_MS) bounds.push(ms);
			return Reflect.apply(timeout, globalThis, [handler, ms === MANAGE_MS ? 50 : ms, ...rest]);
		}) as typeof setTimeout);
		let answerLate!: () => void;
		const late = new Promise<void>((resolve) => (answerLate = resolve));
		w.host.launch = async (body) => {
			await late;
			return launched(body);
		};
		const [status, body] = await w.read(await w.watch());
		const { id, notAfter } = (body as { observation: View }).observation;
		expect([status, body]).toEqual([502, { error: LOST, observation: { id, status: "unconfirmed", notAfter, evidence: "the host's answer to launch was lost (timeout)" } }]);
		expect(bounds).toEqual([MANAGE_MS]);
		answerLate();
		await new Promise((resolve) => timeout(resolve, 50));
		expect(await w.ledger()).toEqual([expect.objectContaining({ observationId: id, status: "unconfirmed", hostLaunchId: null })]);
		expect(await errorOf(await w.watch())).toEqual([409, NOT_SETTLED]);
		expect(w.asked).toHaveLength(1);

		// The observation's deadline comes while its intent is made durable: the host is never asked, so the record says nothing opened, and the next Watch starts.
		await w.restart(true);
		w.host.launch = (launch) => launched(launch);
		// The desk reads the clock it was made with, so the test's clock is in place before the space makes it.
		const start = Date.now();
		at(start);
		await w.instrument({ flush: async () => void at(start + 10 * MINUTE + 1) });
		const [expired, refused] = await w.read(await w.watch());
		expect([expired, refused]).toEqual([
			409,
			{
				error: "The observation's time ran out before the computer was asked, so nothing was asked of it.",
				observation: expect.objectContaining({ status: "not_opened", evidence: "its deadline came while it was being recorded; the host was never asked" }),
			},
		]);
		expect(w.asked).toEqual([]);
		expect((await w.read(await w.watch()))[0]).toBe(200);
		expect(w.asked).toHaveLength(1);

		// The deadline comes while the host answers: its launch is recorded, so it can be ended, but no one gets its viewer.
		await w.restart(true);
		w.host.launch = (launch) => {
			at(launch.notAfter);
			return launched(launch);
		};
		const answered = await w.watch();
		const text = await answered.text();
		expect([answered.status, JSON.parse(text).error]).toEqual([409, "The observation's time ran out, or it changed, while the computer answered. Check it again."]);
		expect(text).not.toContain(TICKET);
		expect(await w.ledger()).toEqual([expect.objectContaining({ status: "open", hostLaunchId: LAUNCH_ID, hostGeneration: "gen-1" })]);
		expect(w.asked).toHaveLength(1);
		expect(sent).toEqual([]);
	});
});
