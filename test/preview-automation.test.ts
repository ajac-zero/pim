import { createExecutionContext, env, evictDurableObject, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalDirectory } from "../preview/cua-eval";
import previewWorker from "../preview/worker";
import { applyObservationEvent, initialObservationState, type ObservationState } from "../src/cua-observation";
import { OBSERVATION_KEY } from "../src/cua-observation-runtime";
import productionWorker from "../src/index";
import { Authenticator } from "./webauthn";
import type { PreviewPim } from "./worker";

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
const KEYS = ["PREVIEW_MODE", "PIM_RUNTIME", "PIM_INGRESS_SECRET", "PREVIEW_EVAL_CLAIM_SHA256", "PREVIEW_AUTOMATION", "PREVIEW_AUTOMATION_GRANT", "PREVIEW_CUA_FIXTURE", "PREVIEW_CUA_FIXTURE_OWNER", "CUA_BRIDGES"] as const;

const settings = env as unknown as Record<string, unknown>;
const previews = (env as unknown as { PREVIEW_PIM: DurableObjectNamespace<PreviewPim> }).PREVIEW_PIM;
const previewDirectories = (env as unknown as { PREVIEW_DIRECTORY: DurableObjectNamespace<EvalDirectory> }).PREVIEW_DIRECTORY;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
/** A credential as the operator makes one: 32 random bytes, base64url. */
const credential = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

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
	for (const key of ["PREVIEW_AUTOMATION", "PREVIEW_AUTOMATION_GRANT", "PREVIEW_CUA_FIXTURE", "PREVIEW_CUA_FIXTURE_OWNER", "CUA_BRIDGES"]) delete settings[key];
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
		if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", ORIGIN);
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
		});
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
		expect(await errorOf(await pim.ask("/api/ws", { cookie, headers: { upgrade: "websocket", origin: ORIGIN } }))).toEqual(readOnly);
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
		expect(await (await pim.production("/auth/session", { cookie })).json()).toMatchObject({ signedIn: false, method: null });
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
		expect((await pim.ask("/api/ws", { cookie: second, headers: { upgrade: "websocket" } })).status).toBe(401);
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
		expect(await (await pim.ask("/auth/session", { cookie: pim.passkey })).clone().json()).not.toHaveProperty("automation");
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
