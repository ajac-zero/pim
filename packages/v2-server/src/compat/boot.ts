/**
 * What the web app asks for as it starts and as a chat runs, in the v1 API's shapes: the person's majordomo, settings, the color themes, the
 * installed extensions, notifications and approvals; and the agents list in the shape its pages draw.
 *
 * The majordomo is the agent chats started without choosing one answer as. v2 has no flag for it on the agent: `owner_settings.majordomo`
 * names it (the promotion sets it from v1's default agent), and the first time it is asked for without one an agent is made for it.
 * `runner_context` (migration 0605) gives a chat with no agent of its own the majordomo's instructions.
 */
import type { Principal } from "@pim/v2-contracts/identity";
import type { App } from "@pim/v2-app/app";
import type { Agent as V2Agent } from "@pim/v2-app/agents";
import { BadRequestError, ForbiddenError, NotFoundError, PimError } from "@pim/v2-app/errors";
import { usageReport, computeReport } from "./usage.ts";
import { fromAnotherSite, ok, route, sessionCookieName, setCookie, type Route } from "@pim/v2-app/http";
import { newId } from "@pim/v2-app/ids";
import { LOCALES } from "@pim/shared/locales";
import { clientAddress } from "../limits.ts";
import { installedExtensions } from "../agent-widgets.ts";
import { PimThemes } from "@pim/shared/themes";
import { pimThemes } from "@pim/shared/theme-data/index";
import { INTRODUCTION } from "@pim/shared/transcript";

const DEFAULT_THEME = "tokyo-night";
const themes = new PimThemes([{ id: "pim.themes", themes: pimThemes }], DEFAULT_THEME);
const themeIds = themes.list().themes.map((t: { id: string }) => t.id);

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

/** A v2 agent in the shape the web app's agent pages draw (`Agent` in web/src/lib/pim-api.ts). */
export function webAgent(a: V2Agent & { updatedAt?: Date }, majordomoId: string | null) {
	return {
		id: a.id,
		name: a.name,
		role: a.role,
		description: a.description,
		instructions: a.instructions,
		apps: a.apps,
		skills: a.skills,
		contacts: [...new Set([...a.contacts, ...a.delegates])],
		model: a.model,
		fallbacks: a.fallbacks,
		source: a.adoptedFrom ? { template: a.adoptedFrom, author: "" } : null,
		published: null,
		icon: a.icon ? (ms(a.updatedAt ?? a.createdAt) ?? 1) : null,
		symbol: a.emoji,
		color: a.color,
		memoryScope: a.memoryScope,
		memoryScopes: a.memoryScopes,
		majordomo: a.id === majordomoId,
		createdAt: ms(a.createdAt) ?? 0,
		updatedAt: ms(a.updatedAt ?? a.createdAt) ?? 0,
	};
}

const setting = async (app: App, ownerId: string, key: string): Promise<unknown> =>
	app.db.owner(ownerId, async (tx) => (await tx.query("SELECT value FROM pim_app.owner_settings WHERE key = $1", [key])).rows[0]?.value);
const putSetting = (app: App, ownerId: string, key: string, value: unknown) =>
	app.db.owner(ownerId, (tx) => tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (owner_id, key) DO UPDATE SET value = $3", [ownerId, key, JSON.stringify(value)]));
const dropSetting = (app: App, ownerId: string, key: string) => app.db.owner(ownerId, (tx) => tx.query("DELETE FROM pim_app.owner_settings WHERE key = $1", [key]));

/** The person's majordomo, made the first time it is asked for when none is named. */
export async function majordomoOf(app: App, p: Principal): Promise<V2Agent> {
	const id = (await setting(app, p.ownerId, "majordomo")) as string | undefined;
	if (id) {
		const agent = await app.agents.get(p, id).catch(() => null);
		if (agent) return agent;
	}
	// A space migrated from v1 has its majordomo already: the agent v1 marked as the default (kept by the promotion in its config), already introduced.
	const legacy = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT id FROM pim_app.agents WHERE deleted_at IS NULL AND config->'legacy'->>'isDefault' = 'true' ORDER BY created_at LIMIT 1")).rows[0]?.id as string | undefined);
	if (legacy) {
		await putSetting(app, p.ownerId, "majordomo", legacy);
		await putSetting(app, p.ownerId, "majordomo_introduced", true);
		return app.agents.get(p, legacy);
	}
	// One made, as v1 made its starter: it keeps this name until the person names it.
	// The app asks for it from several places at once: the first to name it wins, and the others' agents are removed.
	const agent = await app.agents.create(p, { name: "Pim", instructions: "" });
	const won = await app.db.owner(p.ownerId, async (tx) => (await tx.query("INSERT INTO pim_app.owner_settings (owner_id, key, value) VALUES ($1,'majordomo',$2) ON CONFLICT (owner_id, key) DO NOTHING", [p.ownerId, JSON.stringify(agent.id)])).rowCount === 1);
	if (won) return agent;
	await app.agents.remove(p, agent.id);
	return majordomoOf(app, p);
}

// ---- the majordomo's preferences: lines of its instructions, as v1 writes them (src/majordomo.ts) ----
const TONES: Record<string, string> = {
	warm: "Talk with them warmly, like a trusted friend who happens to be very capable.",
	formal: "Talk with them formally and politely, like a seasoned butler.",
	playful: "Talk with them playfully, with a light touch of humor.",
	brief: "Talk with them briefly and to the point, without small talk.",
};
const INVOLVEMENT: Record<string, string> = {
	close:
		"Keep them closely involved: check with them before starting work for them, and ask them about their agents' approval requests unless one is trivial and plainly what they asked for.",
	balanced: "Handle the routine for them and check with them on the rest, including their agents' approval requests.",
	hands_off:
		"Take as much off their hands as you can: go ahead without checking in whenever you can tell what they want, and decide their agents' approval requests yourself unless they truly need to, such as when money is spent or someone else hears from them.",
};
const CUSTOM_TONE = "Talk with them the way they asked, in their words: ";
const preferenceOf = (text: string): Record<string, string> | null => {
	const tone = Object.keys(TONES).find((k) => TONES[k] === text);
	if (tone) return { tone };
	if (text.startsWith(CUSTOM_TONE)) return { customTone: text.slice(CUSTOM_TONE.length) };
	const involvement = Object.keys(INVOLVEMENT).find((k) => INVOLVEMENT[k] === text);
	return involvement ? { involvement } : null;
};
const preferences = (instructions: string) =>
	Object.assign({ tone: null, customTone: null, involvement: null }, ...instructions.split("\n").map(preferenceOf).filter((x) => x !== null));
function withPreferences(instructions: string, body: Record<string, unknown>): string {
	const line = (v: unknown, field: string, max: number) => {
		if (v === undefined || v === null) return null;
		if (typeof v !== "string" || /[\r\n]/.test(v) || v.trim().length > max) throw new BadRequestError(`${field} must be one line of at most ${max} characters`);
		return v.trim() || null;
	};
	const choice = (v: unknown, field: string, choices: Record<string, string>) => {
		if (v === undefined || v === null) return null;
		if (typeof v !== "string" || !Object.hasOwn(choices, v)) throw new BadRequestError(`${field} must be one of ${Object.keys(choices).join(", ")}, or null`);
		return choices[v]!;
	};
	const custom = line(body.customTone, "customTone", 120);
	const lines = [choice(body.tone, "tone", TONES), custom && `${CUSTOM_TONE}${custom}`, choice(body.involvement, "involvement", INVOLVEMENT)].filter((x) => x !== null).join("\n");
	const own = instructions.split("\n").filter((t) => preferenceOf(t) === null).join("\n").trim();
	return [lines, own].filter((x) => x !== "").join("\n");
}

async function majordomoState(app: App, p: Principal) {
	const agent = await majordomoOf(app, p);
	return {
		agent: webAgent(agent, agent.id),
		introduced: (await setting(app, p.ownerId, "majordomo_introduced")) === true,
		preferences: preferences(agent.instructions),
		yourName: ((await setting(app, p.ownerId, "your_name")) as string | undefined) ?? null,
	};
}

// ---- settings ----
const SETTINGS: Record<string, (v: unknown) => boolean> = {
	timeZone: (v) => typeof v === "string" && (() => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } })(),
	approvalPolicy: (v) => ["majordomo", "auto", "explicit"].includes(v as string),
	deviceAlerts: (v) => ["important", "all"].includes(v as string),
	colorMode: (v) => ["light", "dark", "system"].includes(v as string),
	colorTheme: (v) => themeIds.includes(v as string),
	locale: (v) => (LOCALES as readonly string[]).includes(v as string),
	approvalTimeoutSeconds: (v) => v === null || (typeof v === "number" && v >= 0),
};
async function readSettings(app: App, ownerId: string) {
	const rows = await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT key, value FROM pim_app.owner_settings WHERE key LIKE 'settings.%'")).rows);
	const own = Object.fromEntries(rows.map((r) => [r.key.slice("settings.".length), r.value]).filter(([k]) => k in SETTINGS));
	const settings = { timeZone: process.env.PIM_TIME_ZONE || "UTC", approvalPolicy: process.env.PIM_APPROVAL_POLICY || "majordomo", deviceAlerts: "important", approvalTimeoutSeconds: null as number | null, ...own };
	// Only the auto policy times out: what it waits before approving is what the person set, else 30 seconds.
	return { ...settings, approvalTimeoutSeconds: settings.approvalPolicy === "auto" ? (own.approvalTimeoutSeconds as number | null | undefined) || 30 : null };
}

// ---- approvals ----
const STATUS: Record<string, "pending" | "approved" | "denied"> = { waiting: "pending", approved: "approved", timed_out_approved: "approved", denied: "denied", timed_out_denied: "denied" };
export const webApproval = (r: any) => {
	// The runtime's bookkeeping (task, call, policy resource) is not what the person reads.
	const { taskId: _task, callId, resource: _resource, review, explicit: _explicit, requestedBy, guestOwner: _g, guestChat: _c, note, result, ...args } = (r.args ?? {}) as Record<string, unknown>;
	const reviewed = review as { status?: string; note?: string } | undefined;
	const brief = typeof args.summary === "string" ? args.summary : Object.entries(args).slice(0, 3).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`.slice(0, 120)).join(", ");
	return {
		id: r.id,
		session: r.public_chat_id ?? null,
		action: r.tool,
		tool: r.tool,
		args,
		summary: brief ? `${r.tool} — ${brief}` : r.tool,
		status: STATUS[r.state] ?? "pending",
		// What the person said with their decision, and what the action returned once it ran.
		note: typeof note === "string" ? note : r.decided_by === "majordomo" && reviewed?.note ? reviewed.note : null,
		result: typeof result === "string" ? result : null,
		createdAt: ms(r.created_at),
		decidedAt: ms(r.decided_at),
		callId: typeof callId === "string" ? callId : null,
		expiresAt: ms(r.expires_at),
		onTimeout: r.timeout_policy,
		decidedBy: r.state.startsWith("timed_out") ? "timeout" : r.decided_by === null ? null : r.decided_by === "majordomo" ? "majordomo" : r.via_standing_grant ? "always" : "user",
		requestedBy: requestedBy ?? null,
		// While the majordomo has it the person is not asked; once it hands it back, they see what it said.
		review: r.state === "waiting" && (reviewed?.status === "reviewing" || reviewed?.status === "escalated") ? { status: reviewed.status, note: reviewed.note ?? null } : null,
	};
};
export const approvalsOf = (app: App, ownerId: string, where = "", params: unknown[] = []) =>
	app.db.owner(ownerId, async (tx) => (await tx.query(`SELECT * FROM pim_app.approvals ${where} ORDER BY created_at DESC LIMIT 200`, params)).rows.map(webApproval));

export const bootRoutes: Route[] = [
	// Registration as the app expects it (v1's `Registered`): the account and its session, and with them the recovery codes it shows once and the
	// setup code its first passkey is made with. Without them the app would go straight in, and the account would have no way back in.
	route("POST", "/auth/register", async ({ app, json, req, secure }) => {
		if (fromAnotherSite(req)) throw new ForbiddenError("register", "csrf");
		const b = await json();
		// Through a bot's link anyone may join as its guest (the bot must still be live); the address is the proxy's header when the deployment trusts one.
		const bot = typeof b.bot === "string" && b.bot ? await app.guests.liveBot(b.bot) : null;
		// Without a browser (`session: true`) there is no passkey to make, so the account starts active; otherwise it is pending until its first
		// passkey, and lapses after a day without one.
		const account = await app.identity.register({ username: String(b.username ?? ""), invite: b.invite, bootstrap: b.bootstrap ?? b.claim, address: clientAddress(req, process.env), pending: b.session !== true, ...(bot ? { guestOf: { botId: bot.id, host: bot.host } } : {}) });
		let recoveryCodes: string[];
		let setup: { code: string; expiresAt: Date };
		try {
			if (bot) await app.guests.enroll(account.ownerId, bot.id);
			// Everyone else gets a copy of the agent the admin chose, if they chose one, besides the majordomo they name next.
			else await app.agents.adoptDefault({ kind: "user", ownerId: account.ownerId, role: account.role, sessionId: "registration" });
			recoveryCodes = await app.signin.newRecoveryCodes(account.ownerId);
			setup = await app.signin.issueSetupCode(account.ownerId);
			if (b.session === true) await app.identity.activate(account.ownerId);
		} catch (error) {
			// Half a registration helps nobody: give the username and invite back now, not in a day.
			await app.identity.releaseRegistration(account.ownerId).catch(() => undefined);
			console.error(JSON.stringify({ event: "pim.registration_failed", owner: account.ownerId, username: account.username, error: String(error) }));
			throw new PimError(500, "registration_failed", "Your account couldn't be set up. Try again in a moment.");
		}
		const session = () => app.identity.createSession(account.ownerId, { userAgent: req.headers["user-agent"] });
		const name = typeof b.name === "string" && b.name.trim() && !/[\r\n]/.test(b.name) ? b.name.trim().slice(0, 80) : null;
		if (name) await putSetting(app, account.ownerId, "your_name", name);
		if (typeof b.timeZone === "string" && SETTINGS.timeZone!(b.timeZone)) await putSetting(app, account.ownerId, "settings.timeZone", b.timeZone);
		// The app signs in with the passkey it makes next (or a recovery code); a session now would take it past the screen that shows the codes.
		// A client without a browser (scripts, the Compose smoke test) asks for the session with `session: true`.
		const body = { account, username: account.username, role: account.role, setup: setup.code, setupExpiresAt: setup.expiresAt.toISOString(), recoveryCodes };
		return b.session === true ? ok(body, 201, { "set-cookie": setCookie(sessionCookieName(secure), await session(), 30 * 24 * 3600, secure) }) : ok(body, 201);
	}),
	// The development sign-in, as v1's preview had it (`/__dev/sign-in/<username>?returnTo=/path&bot=<id>`): makes the account when it is new (the first is the admin; `bot` makes a new account a
	// guest of that shared bot) and sets the session cookie. Only where `PIM_DEV_SIGN_IN=1` (`scripts/v2-dev/preview.mjs`); anywhere else the path does not exist.
	route("GET", "/__dev/sign-in/:username", async ({ app, params, url, secure }) => {
		if (process.env.PIM_DEV_SIGN_IN !== "1") throw new NotFoundError();
		const username = decodeURIComponent(params[0]!).toLowerCase();
		let ownerId = (await app.db.anonymous(async (tx) => (await tx.query("SELECT owner_id FROM pim_app.accounts WHERE username = $1 AND status = 'active'", [username])).rows[0]))?.owner_id as string | undefined;
		if (!ownerId) {
			const botId = url.searchParams.get("bot");
			const bot = botId ? await app.guests.liveBot(botId) : null;
			const account = await app.identity.register({ username, trusted: true, ...(bot ? { guestOf: { botId: bot.id, host: bot.host } } : {}) });
			ownerId = account.ownerId;
			if (bot) await app.guests.enroll(ownerId, bot.id);
			else await app.agents.adoptDefault({ kind: "user", ownerId: account.ownerId, role: account.role, sessionId: "dev" });
		}
		const returnTo = url.searchParams.get("returnTo") ?? "/";
		return { status: 302, headers: { location: returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", "set-cookie": setCookie(sessionCookieName(secure), await app.identity.createSession(ownerId), 30 * 24 * 3600, secure) } };
	}),
	// The account in v1's shape: usage today and for the last 30 days, from the cost ledger; v2 sets no per-person limits and meters no sandbox minutes here.
	route("GET", "/api/account", async ({ app, principal }) => {
		const p = await principal();
		await app.identity.authz.enforce(p, "api:read");
		const account = (await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT owner_id, username, role, status, created_at FROM pim_app.accounts WHERE owner_id = $1", [p.ownerId])).rows[0])) as any;
		const usage = await usageReport(app, p.ownerId);
		const codesLeft = await app.db.owner(p.ownerId, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.recovery_codes WHERE owner_id = $1 AND used_at IS NULL", [p.ownerId])).rows[0].n as number).catch(() => 10);
		const others = await app.db.anonymous(async (tx) => (await tx.query("SELECT count(*)::int AS n FROM pim_app.accounts WHERE status = 'active' AND NOT bot AND owner_id <> $1", [p.ownerId])).rows[0].n as number).catch(() => 1);
		return ok({
			username: account.username,
			ownerId: account.owner_id,
			role: account.role,
			status: account.status,
			createdAt: ms(account.created_at),
			usage,
			compute: await computeReport(app, p.ownerId),
			recoveryCodesLeft: codesLeft,
			alone: others === 0,
		});
	}),
	route("GET", "/api/themes", async () => ok(themes.list(), 200, { "cache-control": "no-cache" })),
	route("GET", "/api/themes.css", async () => ({ status: 200, raw: themes.stylesheet(), headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" } })),
	// Pim's own extensions with their widgets, and the deployment's logo (`PIM_LOGO`, an https or data: image address, where v1 had `logo` in pim.config.ts).
	route("GET", "/api/extensions", async ({ principal }) => {
		await principal();
		const logo = process.env.PIM_LOGO?.trim();
		return ok({ extensions: installedExtensions(), logo: logo && /^(https:\/\/|data:image\/)/.test(logo) ? logo : null });
	}),
	route("GET", "/api/majordomo", async ({ app, principal }) => ok(await majordomoState(app, await principal()))),
	route("PUT", "/api/majordomo/preferences", async ({ app, principal, json }) => {
		const p = await principal();
		const agent = await majordomoOf(app, p);
		await app.agents.update(p, agent.id, { instructions: withPreferences(agent.instructions, await json()) });
		return ok(await majordomoState(app, p));
	}),
	route("POST", "/api/majordomo", async ({ app, principal, json }) => {
		// The first time the person opens Pim: their majordomo's first chat, which it starts by introducing itself.
		const p = await principal();
		const body = await json();
		const agent = await majordomoOf(app, p);
		const known = (await setting(app, p.ownerId, "majordomo_chat")) as string | undefined;
		if ((await setting(app, p.ownerId, "majordomo_introduced")) === true && known) return ok({ ...(await majordomoState(app, p)), session: known });
		await putSetting(app, p.ownerId, "majordomo_introduced", true);
		const yourName = typeof body.yourName === "string" && body.yourName.trim() && !/[\r\n]/.test(body.yourName) ? body.yourName.trim().slice(0, 80) : (((await setting(app, p.ownerId, "your_name")) as string | undefined) ?? null);
		if (yourName) {
			await putSetting(app, p.ownerId, "your_name", yourName);
			await app.memories.remember(p, "everyone", "Their name", `Their name is ${yourName}.`).catch(() => undefined);
		}
		const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 100) : yourName ? `Welcome, ${yourName}` : "Welcome";
		const session = await app.conversations.create(p, { agentId: agent.id, title });
		await putSetting(app, p.ownerId, "majordomo_chat", session);
		// The app hides a message that starts with INTRODUCTION, as v1 sent it.
		const text = `${INTRODUCTION} The person just joined.${yourName ? ` Their name is ${yourName}.` : ""} You are their majordomo, and this is your first conversation with them: greet them${yourName ? " by name" : ""} in a few short sentences, say you're their majordomo and what you're for, and ask ${yourName ? "what they'd like to call you" : "what you should call them"}.`;
		await app.conversations.admit(p, { commandId: newId("cmd"), kind: "user_message", chatId: session, payload: { text } }).catch((error) => console.warn("the majordomo's introduction failed", error));
		return ok({ ...(await majordomoState(app, p)), session });
	}),

	// The agents in the shape the app's pages draw; the majordomo first.
	route("GET", "/api/agents", async ({ app, principal }) => {
		const p = await principal();
		const majordomo = await majordomoOf(app, p);
		const agents = await app.agents.list(p);
		return ok({ agents: [...agents].sort((a, b) => Number(b.id === majordomo.id) - Number(a.id === majordomo.id)).map((a) => webAgent(a, majordomo.id)) });
	}),

	// An agent made or edited in the app's form: it names an agent's emoji `symbol`, and wants the answer in the shape its pages draw.
	route("POST", "/api/agents", async ({ app, principal, json }) => {
		const p = await principal();
		const created = await app.agents.create(p, (await json()) as never);
		return ok(webAgent(created, (await majordomoOf(app, p)).id), 201);
	}),
	route("PUT", "/api/agents/:id", async ({ app, principal, params, json }) => {
		const p = await principal();
		const updated = await app.agents.update(p, params[0]!, (await json()) as never);
		return ok(webAgent(updated, (await majordomoOf(app, p)).id));
	}),

	route("GET", "/api/settings", async ({ app, principal }) => ok(await readSettings(app, (await principal()).ownerId))),
	route("PUT", "/api/settings", async ({ app, principal, json }) => {
		const p = await principal();
		const update = await json();
		for (const [key, value] of Object.entries(update)) {
			if (!(key in SETTINGS)) throw new BadRequestError(`Unknown setting ${key}`);
			if (value !== null && !SETTINGS[key]!(value)) throw new BadRequestError(`${key} is not a valid value`);
		}
		for (const [key, value] of Object.entries(update)) {
			if (value === null) await dropSetting(app, p.ownerId, `settings.${key}`);
			else await putSetting(app, p.ownerId, `settings.${key}`, value);
		}
		return ok(await readSettings(app, p.ownerId));
	}),

	route("GET", "/api/approvals", async ({ app, principal, url }) => {
		const p = await principal();
		const status = url.searchParams.get("status");
		const states = status ? Object.keys(STATUS).filter((s) => STATUS[s] === status) : null;
		return ok({ approvals: await approvalsOf(app, p.ownerId, states ? "WHERE state = ANY($1)" : "", states ? [states] : []) });
	}),
	route("GET", "/api/approvals/:id", async ({ app, principal, params }) => {
		const [found] = await approvalsOf(app, (await principal()).ownerId, "WHERE id = $1", [params[0]]);
		if (!found) throw new NotFoundError("No such approval");
		return ok(found);
	}),
	...(["approve", "deny"] as const).map((decision) =>
		route("POST", `/api/approvals/:id/${decision}`, async ({ app, principal, params, json }) => {
			// `{ always: true }` (remember the tool) is the tool-permissions work's; a plain decision is the approval's own, with the note the person gave it.
			const p = await principal();
			const note = ((await json().catch(() => ({}))) as { note?: unknown }).note;
			await app.approvals.decide(p, params[0]!, decision === "approve", typeof note === "string" ? note : undefined);
			const [found] = await approvalsOf(app, p.ownerId, "WHERE id = $1", [params[0]]);
			return ok(found);
		}),
	),
];
