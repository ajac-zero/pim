import type { Message } from "@earendil-works/pi-ai";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AUDIT_ROWS,
	enqueueHostOp,
	getHostOp,
	HOSTOPS_NAME,
	type HostOps,
	type HostOpsCaller,
	redactSecrets,
	waitForHostOp,
} from "../src/hostops";
import type { Pim } from "../src/pim";
import { api, OWNER, pendingApproval, post, ROOT, say, signedIn, systemPrompt, TOKEN, toolUse, url } from "./helpers";
import { faux } from "./worker";

const MINUTE = 60_000;
const stub = () => env.HostOps.getByName(HOSTOPS_NAME);
const inHostOps = <T>(work: (sql: SqlStorage) => T) => runInDurableObject(stub(), (_instance: HostOps, state) => work(state.storage.sql));

/** A request to the Worker, as the admin's browser (`cookie`), a token, or nobody. */
async function call(path: string, init: { method?: string; body?: unknown; cookie?: string; token?: string } = {}) {
	const headers: Record<string, string> = { "content-type": "application/json", origin: "https://pim.test" };
	if (init.cookie) headers.cookie = init.cookie;
	if (init.token) headers.Authorization = `Bearer ${init.token}`;
	const response = await exports.default.fetch(
		new Request(url(`/api${path}`), { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) }),
	);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const poll = (token: string, waitMs = 0, extra: Record<string, unknown> = {}) =>
	call("/hostops/agent/poll", { method: "POST", token, body: { agentVersion: "1.2.3", commit: "abc1234", waitMs, ...extra } });
const report = (token: string, body: Record<string, unknown>) => call("/hostops/agent/result", { method: "POST", token, body });
const succeeded = (id: string, extra: Record<string, unknown> = {}) => ({ id, ok: true, state: "succeeded", summary: "done", data: {}, ...extra });

let cookie = "";
let majordomo: HostOpsCaller;
let memberId = "";
let memberToken = "";

async function newAccount(username: string, bot?: string) {
	const directory = env.Directory.getByName("directory");
	const registered = await directory.register({ username, ip: "192.0.2.9", policy: { mode: "open", maxAccounts: null, perAddressPerDay: 100 }, ...(bot ? { bot } : {}) });
	if (!registered.ok) throw new Error(registered.error);
	await directory.activate(registered.account.ownerId);
	return registered.account;
}

/** The admin's audit log, newest first, read as the admin does. */
async function auditLog(limit = 100) {
	const { status, body } = await call(`/hostops/audit?limit=${limit}`, { cookie });
	expect(status).toBe(200);
	return body.audit as { actorKind: string; actorId: string | null; action: string; opId: string | null; args: any; outcome: string; detail: string | null }[];
}

/** Moves an operation's times into the past, as if `ms` had passed. */
const age = (id: string, ms: number) =>
	inHostOps((sql) => sql.exec("UPDATE ops SET created_at = created_at - ?, started_at = started_at - ? WHERE id = ?", ms, ms, id));

beforeAll(async () => {
	cookie = await signedIn();
	const agents = (await api("/agents")).body.agents as { id: string; majordomo: boolean }[];
	majordomo = { kind: "agent", accountId: OWNER, agentId: agents.find((agent) => agent.majordomo)!.id, chatId: "chat-1" };
	const member = await newAccount("member");
	memberId = member.ownerId;
	await (await getAgentByName(env.Pim, memberId)).provision({ ownerId: memberId, username: "member" });
	memberToken = (await env.Auth.getByName(memberId).createToken(memberId, "tests", Date.now())).token;
});

beforeEach(async () => {
	await inHostOps((sql) => {
		sql.exec("DELETE FROM ops");
		sql.exec("DELETE FROM audit");
		sql.exec("DELETE FROM credential");
	});
});

describe("host operations' arguments", () => {
	const cases: [string, unknown, number, unknown?][] = [
		["stats", undefined, 201, {}],
		["stats", {}, 201, {}],
		["stats", { verbose: true }, 400],
		["deploy", {}, 201, { ref: "origin/main" }],
		["deploy", { ref: "v1.2/release_candidate-3" }, 201, { ref: "v1.2/release_candidate-3" }],
		["deploy", { ref: "main; rm -rf /" }, 400],
		["deploy", { ref: "--upload-pack=x" }, 400],
		["deploy", { ref: "-x" }, 400],
		["deploy", { ref: "a".repeat(101) }, 400],
		["deploy", { ref: "" }, 400],
		["deploy", { ref: 7 }, 400],
		["deploy", { ref: "main", force: true }, 400],
		["rollback", { commit: "abc1234" }, 201, { commit: "abc1234" }],
		["rollback", { commit: "a".repeat(40) }, 201, { commit: "a".repeat(40) }],
		["rollback", { commit: "abc123" }, 400],
		["rollback", { commit: "a".repeat(41) }, 400],
		["rollback", { commit: "abc123z" }, 400],
		["rollback", {}, 400],
		["rollback", { commit: "abc1234", hard: true }, 400],
		["restart", { service: "sandbox-manager" }, 201, { service: "sandbox-manager" }],
		["restart", { service: "hostopsd" }, 201, { service: "hostopsd" }],
		["restart", { service: "pim" }, 400],
		["restart", {}, 400],
		["restart", { service: "egress-proxy", now: 1 }, 400],
		["logs", { service: "docker-socket-proxy" }, 201, { service: "docker-socket-proxy", lines: 100 }],
		["logs", { service: "egress-proxy", lines: 500 }, 201, { service: "egress-proxy", lines: 500 }],
		["logs", { service: "egress-proxy", lines: 1 }, 201, { service: "egress-proxy", lines: 1 }],
		["logs", { service: "egress-proxy", lines: 0 }, 400],
		["logs", { service: "egress-proxy", lines: 501 }, 400],
		["logs", { service: "egress-proxy", lines: 1.5 }, 400],
		["logs", { service: "egress-proxy", lines: "10" }, 400],
		["logs", { service: "/etc/passwd" }, 400],
		["logs", { service: "egress-proxy", follow: true }, 400],
		["set_slot_limit", { maxConcurrent: 1 }, 201, { maxConcurrent: 1 }],
		["set_slot_limit", { maxConcurrent: 16 }, 201, { maxConcurrent: 16 }],
		["set_slot_limit", { maxConcurrent: 0 }, 400],
		["set_slot_limit", { maxConcurrent: 17 }, 400],
		["set_slot_limit", {}, 400],
		["set_slot_limit", { maxConcurrent: 4, extra: 1 }, 400],
		["shell", { command: "id" }, 400],
		["__proto__", {}, 400],
		["stats", [], 400],
		["stats", "x", 400],
	];

	it("takes exactly each allowed operation's arguments, with their defaults, and refuses anything else with 400", async () => {
		for (const [op, args, status, expected] of cases) {
			// One deploy or rollback at a time: each case starts with an empty queue.
			await inHostOps((sql) => sql.exec("DELETE FROM ops"));
			const outcome = await enqueueHostOp(env, majordomo, op, args).then(
				(queued) => ({ status: 201, args: queued.args, state: queued.state }),
				(error) => ({ status: error.status as number }),
			);
			expect(outcome, `${op} ${JSON.stringify(args)}`).toEqual(status === 201 ? { status, args: expected, state: "queued" } : { status });
		}
		// Every refusal is in the audit log as invalid.
		const invalid = (await auditLog(500)).filter((row) => row.outcome === "invalid");
		expect(invalid).toHaveLength(cases.filter(([, , status]) => status === 400).length);
	});
});

describe("who may ask for host operations", () => {
	it("is only the admin's majordomo, and every refusal is audited", async () => {
		const queued = await enqueueHostOp(env, majordomo, "stats", {});
		expect(queued).toMatchObject({ op: "stats", state: "queued", caller: { accountId: OWNER, agentId: (majordomo as { agentId: string }).agentId, chatId: "chat-1" } });

		const other = (await post("/agents", { name: "Ops", instructions: "Helps." })).body.id as string;
		const memberMajordomo = (await call("/agents", { token: memberToken })).body.agents.find((agent: { majordomo: boolean }) => agent.majordomo).id as string;
		const guest = await newAccount("visitor", "some-bot");
		expect(guest.role).toBe("guest");

		const refusedAgents: [string, HostOpsCaller][] = [
			["the admin's other agent", { kind: "agent", accountId: OWNER, agentId: other, chatId: null }],
			["an agent id the admin doesn't have", { kind: "agent", accountId: OWNER, agentId: "made-up", chatId: null }],
			["a member's majordomo", { kind: "agent", accountId: memberId, agentId: memberMajordomo, chatId: null }],
			["a member claiming the admin's majordomo's id", { kind: "agent", accountId: memberId, agentId: (majordomo as { agentId: string }).agentId, chatId: null }],
			["a guest's agent", { kind: "agent", accountId: guest.ownerId, agentId: "bot-copy", chatId: null }],
			["the admin signed in", { kind: "session", accountId: OWNER }],
			["the admin's token", { kind: "token", accountId: OWNER }],
		];
		for (const [who, caller] of refusedAgents) {
			await expect(enqueueHostOp(env, caller, "stats", {}), who).rejects.toMatchObject({ status: 403 });
		}
		await expect(enqueueHostOp(env, { kind: "anonymous" }, "stats", {})).rejects.toMatchObject({ status: 401 });

		// Through the API: the admin's web session, the admin's API token (which MCP clients use), a member, and nobody.
		expect((await call("/hostops/ops", { method: "POST", cookie, body: { op: "stats" } })).status).toBe(403);
		expect((await call("/hostops/ops", { method: "POST", token: TOKEN, body: { op: "stats" } })).status).toBe(403);
		expect((await call("/hostops/ops", { method: "POST", token: memberToken, body: { op: "deploy" } })).status).toBe(403);
		expect((await call("/hostops/ops", { method: "POST", body: { op: "stats" } })).status).toBe(401);

		const rejected = (await auditLog()).filter((row) => row.action === "enqueue" && row.outcome === "rejected").reverse();
		expect(rejected.map((row) => [row.actorKind, row.actorId])).toEqual([
			["agent", `${OWNER}/${other}`],
			["agent", `${OWNER}/made-up`],
			["agent", `${memberId}/${memberMajordomo}`],
			["agent", `${memberId}/${(majordomo as { agentId: string }).agentId}`],
			["agent", `${guest.ownerId}/bot-copy`],
			["session", OWNER],
			["token", OWNER],
			["anonymous", null],
			["session", OWNER],
			["token", OWNER],
			["token", memberId],
			["anonymous", expect.any(String)],
		]);
		// Nothing but the majordomo's operation was queued.
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 1, running: 0 });
	});

	it("lets only the admin, signed in to the app, read the log and status and hold the daemon's credential", async () => {
		for (const path of ["/hostops/status", "/hostops/audit", "/hostops/ops/whatever"]) {
			expect((await call(path, { token: TOKEN })).status, path).toBe(403);
			expect((await call(path, { token: memberToken })).status, path).toBe(403);
			expect((await call(path)).status, path).toBe(401);
		}
		expect((await call("/hostops/credential", { method: "POST", token: TOKEN })).status).toBe(403);
		expect((await call("/hostops/credential", { method: "POST", token: memberToken })).status).toBe(403);
		expect((await call("/hostops/status", { cookie })).status).toBe(200);
		expect((await call("/hostops/ops/whatever", { cookie })).status).toBe(404);
		expect((await call("/hostops/audit?limit=0", { cookie })).status).toBe(400);
		expect(await inHostOps((sql) => sql.exec("SELECT COUNT(*) AS n FROM credential").one().n)).toBe(0);
	});
});

describe("the host daemon's credential", () => {
	it("is issued once, rotated and revoked by the admin, and opens only the daemon's routes", async () => {
		expect((await call("/hostops/status", { cookie })).body.credential).toMatchObject({ present: false, revoked: false });
		const issued = await call("/hostops/credential", { method: "POST", cookie });
		expect(issued).toMatchObject({ status: 201, body: { rotated: false, token: expect.stringMatching(/^pimhostops_[\w-]{43}$/) } });
		const first = issued.body.token as string;
		// Only its digest is kept.
		const stored = await inHostOps((sql) => sql.exec("SELECT hash FROM credential").toArray().map((row) => String(row.hash)));
		expect(stored).toHaveLength(1);
		expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
		expect(stored[0]).not.toContain(first);

		expect((await poll(first)).status).toBe(204);
		const status = (await call("/hostops/status", { cookie })).body;
		expect(status).toMatchObject({ credential: { present: true, revoked: false }, agent: { version: "1.2.3", commit: "abc1234", lastSeenAt: expect.any(Number) } });

		// Wrong tokens, the admin's API token, the browser's session cookie, a token in the query: none opens the daemon's routes.
		expect((await poll(`${first}x`)).status).toBe(401);
		expect((await poll("pimhostops_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(401);
		expect((await poll(TOKEN)).status).toBe(401);
		expect((await call("/hostops/agent/poll", { method: "POST", cookie, body: { waitMs: 0 } })).status).toBe(401);
		expect((await call(`/hostops/agent/poll?token=${first}`, { method: "POST", body: { waitMs: 0 } })).status).toBe(401);
		expect((await report(`${first}x`, succeeded("x"))).status).toBe(401);
		// Nor does it open anything of the admin's.
		expect((await call("/hostops/status", { token: first })).status).toBe(401);
		expect((await call("/agents", { token: first })).status).toBe(401);

		const rotated = await call("/hostops/credential", { method: "POST", cookie });
		expect(rotated.body.rotated).toBe(true);
		const second = rotated.body.token as string;
		expect(second).not.toBe(first);
		expect((await poll(first)).status).toBe(401);
		expect((await poll(second)).status).toBe(204);

		expect((await call("/hostops/credential", { method: "DELETE", cookie })).body).toEqual({ revoked: true });
		expect((await poll(second)).status).toBe(401);
		expect((await report(second, succeeded("x"))).status).toBe(401);
		expect((await call("/hostops/status", { cookie })).body.credential).toMatchObject({ present: false, revoked: true, revokedAt: expect.any(Number) });

		expect((await auditLog()).filter((row) => row.action.startsWith("credential.")).map((row) => [row.action, row.actorKind, row.actorId])).toEqual([
			["credential.revoke", "admin", OWNER],
			["credential.rotate", "admin", OWNER],
			["credential.issue", "admin", OWNER],
		]);
	});

	describe("enrolled by the host", () => {
		const SECRET = "manager-secret";
		const enroll = (token?: string) => call("/hostops/agent/enroll", { method: "POST", token });
		const withSecret = async <T>(value: string, work: () => Promise<T>) => {
			const mutable = env as unknown as Record<string, string | undefined>;
			const before = mutable.PIM_CODING_MANAGER_TOKEN;
			mutable.PIM_CODING_MANAGER_TOKEN = value;
			try {
				return await work();
			} finally {
				if (before === undefined) delete mutable.PIM_CODING_MANAGER_TOKEN;
				else mutable.PIM_CODING_MANAGER_TOKEN = before;
			}
		};
		beforeEach(() => inHostOps((sql) => sql.exec("DELETE FROM credential")));

		it("gets a working credential, and the one before stops", async () => {
			await withSecret(SECRET, async () => {
				const first = await enroll(SECRET);
				expect(first).toMatchObject({ status: 201, body: { token: expect.stringMatching(/^pimhostops_[\w-]{43}$/) } });
				expect((await poll(first.body.token)).status).toBe(204);
				expect((await call("/hostops/status", { cookie })).body.credential).toMatchObject({ present: true, revoked: false });

				const second = await enroll(SECRET);
				expect(second.status).toBe(201);
				expect((await poll(first.body.token)).status).toBe(401);
				expect((await poll(second.body.token)).status).toBe(204);
				// The admin can still revoke it.
				expect((await call("/hostops/credential", { method: "DELETE", cookie })).body).toEqual({ revoked: true });
				expect((await poll(second.body.token)).status).toBe(401);
			});
		});

		it("refuses a wrong or missing token, and does nothing without the secret", async () => {
			await withSecret(SECRET, async () => {
				expect((await enroll(`${SECRET}x`)).status).toBe(401);
				expect((await enroll()).status).toBe(401);
				expect((await enroll(TOKEN)).status).toBe(401);
			});
			expect(await inHostOps((sql) => sql.exec("SELECT hash FROM credential").toArray())).toHaveLength(0);
			await withSecret("", async () => expect((await enroll("")).status).toBe(404));
			await withSecret("", async () => expect((await enroll("anything")).status).toBe(404));
		});

		it("stays refused after the admin revokes, until the admin issues again", async () => {
			await withSecret(SECRET, async () => {
				expect((await enroll(SECRET)).status).toBe(201);
				await call("/hostops/credential", { method: "DELETE", cookie });
				expect(await enroll(SECRET)).toEqual({ status: 403, body: { error: "revoked" } });
				expect((await call("/hostops/status", { cookie })).body.credential).toMatchObject({ present: false, revoked: true });
				const issued = await call("/hostops/credential", { method: "POST", cookie });
				expect((await poll(issued.body.token)).status).toBe(204);
				const enrolled = await enroll(SECRET);
				expect(enrolled.status).toBe(201);
				expect((await poll(issued.body.token)).status).toBe(401);
				expect((await poll(enrolled.body.token)).status).toBe(204);
			});
		});

		it("keeps only the digest, and no secret in the audit log", async () => {
			await withSecret(SECRET, async () => {
				const { token } = (await enroll(SECRET)).body;
				await call("/hostops/credential", { method: "DELETE", cookie });
				await enroll(SECRET);
				const rows = await inHostOps((sql) => sql.exec("SELECT hash FROM credential").toArray().map((row) => String(row.hash)));
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatch(/^[0-9a-f]{64}$/);
				const log = await auditLog();
				expect(log.filter((row) => row.action === "credential.enroll").map((row) => [row.actorKind, row.outcome])).toEqual([
					["host", "revoked"],
					["host", "ok"],
				]);
				const everything = JSON.stringify(log) + JSON.stringify(await inHostOps((sql) => sql.exec("SELECT * FROM audit").toArray()));
				for (const secret of [token, SECRET]) expect(everything).not.toContain(secret);
			});
		});
	});

	it("stops a poll that is waiting when it is revoked", async () => {
		const token = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
		const waiting = poll(token, 3000);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await call("/hostops/credential", { method: "DELETE", cookie });
		await enqueueHostOp(env, majordomo, "stats", {});
		expect((await waiting).status).toBe(401);
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 1, running: 0 });
	});
});

describe("a poll that fails inside Pim", () => {
	it("answers that there is nothing instead of 500, and still refuses a bad credential", async () => {
		const token = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
		const get = vi.spyOn(env.HostOps, "getByName").mockReturnValue({ poll: () => Promise.reject(new Error("Durable Object reset")) } as never);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect((await poll(token)).status).toBe(204);
			expect(error).toHaveBeenCalled();
		} finally {
			get.mockRestore();
			error.mockRestore();
		}
		expect((await poll(token)).status).toBe(204);
		expect((await poll(`${token}x`)).status).toBe(401);
	});
});

describe("the daemon's queue", () => {
	let token = "";
	beforeEach(async () => {
		token = (await call("/hostops/credential", { method: "POST", cookie })).body.token;
	});

	it("hands the oldest operation to the daemon, takes its result once, and audits each change", async () => {
		const first = await enqueueHostOp(env, majordomo, "logs", { service: "egress-proxy" });
		const second = await enqueueHostOp(env, majordomo, "stats", {});
		const polled = await poll(token);
		expect(polled).toEqual({ status: 200, body: { op: { id: first.id, name: "logs", args: { service: "egress-proxy", lines: 100 }, deadlineMs: 2 * MINUTE } } });
		expect((await call(`/hostops/ops/${first.id}`, { cookie })).body).toMatchObject({ state: "running", startedAt: expect.any(Number) });
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 1, running: 1 });

		// A result for an operation that isn't running, or doesn't exist, isn't taken; nor is one that doesn't add up.
		expect((await report(token, succeeded(second.id))).status).toBe(409);
		expect((await report(token, succeeded("no-such-op"))).status).toBe(404);
		expect((await report(token, succeeded(first.id, { ok: false }))).status).toBe(400);
		expect((await report(token, succeeded(first.id, { state: "done" }))).status).toBe(400);
		expect((await report(token, succeeded(first.id, { summary: "x".repeat(2001) }))).status).toBe(400);
		expect((await report(token, succeeded(first.id, { data: [] }))).status).toBe(400);
		expect((await report(token, succeeded(first.id, { data: { log: "x".repeat(64 * 1024) } }))).status).toBe(400);

		const done = await report(token, succeeded(first.id, { summary: "12 lines", data: { lines: ["a", "b"] } }));
		expect(done).toMatchObject({ status: 200, body: { state: "succeeded", summary: "12 lines", data: { lines: ["a", "b"] }, finishedAt: expect.any(Number) } });
		expect((await report(token, succeeded(first.id))).status).toBe(409);
		expect(await getHostOp(env, first.id)).toMatchObject({ state: "succeeded", summary: "12 lines" });

		const next = await poll(token);
		expect(next.body.op.id).toBe(second.id);
		expect((await report(token, { id: second.id, ok: false, state: "failed", summary: "disk full", data: {} })).body.state).toBe("failed");
		expect((await poll(token)).status).toBe(204);

		const log = (await auditLog()).reverse().filter((row) => row.opId === first.id);
		expect(log.map((row) => [row.action, row.outcome, row.actorKind])).toEqual([
			["enqueue", "queued", "agent"],
			["claim", "running", "hostd"],
			["result", "succeeded", "hostd"],
			["result", "conflict", "hostd"],
		]);
	});

	it("rejects a poll that waits too long or says nothing it should", async () => {
		expect((await poll(token, 25_001)).status).toBe(400);
		expect((await poll(token, -1)).status).toBe(400);
		expect((await poll(token, 0, { agentVersion: 5 })).status).toBe(400);
		expect((await call("/hostops/agent/poll", { method: "GET", token })).status).toBe(405);
	});

	it("wakes a waiting poll as soon as an operation is queued, and a waiting caller once it finishes", async () => {
		const started = Date.now();
		const waiting = poll(token, 10_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		const queued = await enqueueHostOp(env, majordomo, "restart", { service: "egress-proxy" });
		const polled = await waiting;
		expect(polled.body.op.id).toBe(queued.id);
		expect(Date.now() - started).toBeLessThan(5000);

		const finished = waitForHostOp(env, queued.id, 10_000);
		await new Promise((resolve) => setTimeout(resolve, 300));
		await report(token, { id: queued.id, ok: false, state: "rolled_back", summary: "restart failed, previous container kept", data: {} });
		expect(await finished).toMatchObject({ id: queued.id, state: "rolled_back" });
		// A caller that stops waiting sees the operation as it is.
		const later = await enqueueHostOp(env, majordomo, "stats", {});
		expect(await waitForHostOp(env, later.id, 100)).toMatchObject({ state: "queued" });
		expect(await waitForHostOp(env, "no-such-op", 100)).toBeNull();
	});

	it("expires operations nobody took in 10 minutes, and fails those not reported by their deadline", async () => {
		const stale = await enqueueHostOp(env, majordomo, "stats", {});
		await age(stale.id, 9 * MINUTE);
		expect((await getHostOp(env, stale.id))!.state).toBe("queued");
		await age(stale.id, 2 * MINUTE);
		expect((await getHostOp(env, stale.id))!.state).toBe("expired");
		expect((await poll(token)).status).toBe(204);

		const restart = await enqueueHostOp(env, majordomo, "restart", { service: "sandbox-manager" });
		const deploy = await enqueueHostOp(env, majordomo, "deploy", {});
		expect((await poll(token)).body.op.id).toBe(restart.id);
		expect((await poll(token)).body.op).toMatchObject({ id: deploy.id, deadlineMs: 15 * MINUTE });
		await age(restart.id, 3 * MINUTE);
		await age(deploy.id, 3 * MINUTE);
		expect(await getHostOp(env, restart.id)).toMatchObject({ state: "failed", summary: "timed out", finishedAt: expect.any(Number) });
		expect((await getHostOp(env, deploy.id))!.state).toBe("running");
		await age(deploy.id, 13 * MINUTE);
		expect(await getHostOp(env, deploy.id)).toMatchObject({ state: "failed", summary: "timed out" });
		// A result after the deadline is too late.
		expect((await report(token, succeeded(deploy.id))).status).toBe(409);

		const changes = (await auditLog()).filter((row) => row.actorKind === "system").map((row) => [row.action, row.outcome, row.opId]);
		expect(changes).toEqual([
			["timeout", "failed", deploy.id],
			["timeout", "failed", restart.id],
			["expire", "expired", stale.id],
		]);
		// The alarm is set for the next operation that could lapse, and cleared when none can.
		expect(await runInDurableObject(stub(), (_instance: HostOps, state) => state.storage.getAlarm())).toBeNull();
		const pending = await enqueueHostOp(env, majordomo, "stats", {});
		expect(await runInDurableObject(stub(), (_instance: HostOps, state) => state.storage.getAlarm())).toBe(pending.createdAt + 10 * MINUTE);
	});

	it("runs one deploy or rollback at a time", async () => {
		const deploy = await enqueueHostOp(env, majordomo, "deploy", { ref: "origin/main" });
		await expect(enqueueHostOp(env, majordomo, "rollback", { commit: "abc1234" })).rejects.toMatchObject({ status: 409 });
		await expect(enqueueHostOp(env, majordomo, "deploy", {})).rejects.toMatchObject({ status: 409 });
		// Other operations go on.
		await enqueueHostOp(env, majordomo, "stats", {});
		await poll(token);
		await expect(enqueueHostOp(env, majordomo, "deploy", {})).rejects.toMatchObject({ status: 409 });
		await report(token, succeeded(deploy.id));
		const rollback = await enqueueHostOp(env, majordomo, "rollback", { commit: "abc1234" });
		expect(rollback.state).toBe("queued");
		// One that expired holds nothing up.
		await age(rollback.id, 11 * MINUTE);
		expect((await enqueueHostOp(env, majordomo, "deploy", {})).state).toBe("queued");
		expect((await auditLog()).filter((row) => row.outcome === "conflict" && row.action === "enqueue")).toHaveLength(3);
	});
});

describe("the audit log", () => {
	it("keeps no secrets in arguments or summaries", async () => {
		expect(redactSecrets("Authorization: Bearer abc.def-ghi")).toBe("Authorization: Bearer [redacted]");
		expect(redactSecrets("key=ghp_ABCdef1234567890abcdef1234 rest")).toBe("key=[redacted] rest");
		expect(redactSecrets(`commit ${"0123456789abcdef".repeat(2)}`)).toBe("commit [redacted]");
		expect(redactSecrets("docker-socket-proxy refs/heads/feature-branch-name origin/main abc1234")).toBe(
			"docker-socket-proxy refs/heads/feature-branch-name origin/main abc1234",
		);

		// A made-up token, built here so it looks like no real service's key.
		const secret = `tok_${"9fQ2xLmA7".repeat(3)}`;
		await call("/hostops/ops", { method: "POST", cookie, body: { op: "deploy", args: { ref: `Bearer ${secret}`, token: secret } } });
		await expect(enqueueHostOp(env, majordomo, "deploy", { ref: "main", password: secret })).rejects.toMatchObject({ status: 400 });
		const token = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
		const queued = await enqueueHostOp(env, majordomo, "stats", {});
		await poll(token);
		await report(token, succeeded(queued.id, { summary: `logged in with ${secret}` }));

		const log = await auditLog();
		const text = JSON.stringify(log);
		expect(text).not.toContain(secret);
		expect(text).not.toContain(token);
		expect(log.find((row) => row.actorKind === "session")!.args).toEqual({ op: "deploy", args: { ref: "Bearer [redacted]", token: "[redacted]" } });
		expect(log.find((row) => row.action === "result")!.detail).toBe("logged in with [redacted]");
		// The operation itself keeps what the daemon said, for the majordomo.
		expect((await getHostOp(env, queued.id))!.summary).toBe(`logged in with ${secret}`);
	});

	it("is newest first, and keeps at most 10,000 rows", async () => {
		await inHostOps((sql) => {
			for (let i = 0; i < AUDIT_ROWS; i++) sql.exec("INSERT INTO audit (ts, actor_kind, action, outcome) VALUES (?, 'test', 'filler', ?)", i, String(i));
		});
		await call("/hostops/credential", { method: "POST", cookie });
		const counts = await inHostOps((sql) => sql.exec("SELECT COUNT(*) AS n FROM audit WHERE action = 'filler'").one());
		expect(await inHostOps((sql) => sql.exec("SELECT COUNT(*) AS n FROM audit").one().n)).toBe(AUDIT_ROWS);
		// The oldest filler row went to make room.
		expect(counts.n).toBe(AUDIT_ROWS - 1);
		expect(await inHostOps((sql) => sql.exec("SELECT 1 FROM audit WHERE outcome = '0'").toArray().length)).toBe(0);

		const newest = await auditLog(2);
		expect(newest.map((row) => row.action)).toEqual(["credential.issue", "filler"]);
		expect(newest[1]!.outcome).toBe(String(AUDIT_ROWS - 1));
		expect(await auditLog()).toHaveLength(100);
		expect((await call("/hostops/audit", { cookie })).body.audit).toHaveLength(100);
	});
});

const requestedBy = (row: { requested_by: { kind: string } }) => row.requested_by.kind;

describe("the majordomo's host operation tools", () => {
	const HOSTOPS_TOOLS = ["hostops_stats", "hostops_deploy", "hostops_rollback", "hostops_restart", "hostops_logs", "hostops_set_slot_limit", "hostops_status", "hostops_audit", "hostops_op", "hostops_exec"];
	let offered: string[] = [];
	let prompt = "";
	let told = "";
	/** The model's last step: it reads the tools it was offered, its prompt and the last tool result, then answers. */
	const record = (context: { messages: Message[] }) => {
		const tools = new Set<string>();
		for (const message of context.messages) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
			for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		}
		offered = [...tools];
		prompt = systemPrompt(context.messages);
		const result = context.messages.findLast((message) => message.role === "toolResult");
		told = result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
		return toolUse("send_to_user", { message: "ok" });
	};
	/** Says something in a chat with `token`'s space, and waits for the answer. */
	const sayAs = async (token: string, chat: string, content: string) => {
		const { status } = await call(`/sessions/${chat}/messages`, { method: "POST", token, body: { content, wait: true } });
		expect(status).toBe(200);
	};
	const agentId = () => (majordomo as { agentId: string }).agentId;
	let other = "";
	let otherChat = "";

	beforeAll(async () => {
		other = (await post("/agents", { name: "Helper", instructions: "Helps." })).body.id;
		otherChat = (await post("/sessions", { agent: other })).body.id;
	});

	it("are offered, with their prompt section, only to the admin's majordomo", async () => {
		faux.setResponses([record]);
		await sayAs(TOKEN, ROOT, "Hi");
		expect(offered).toEqual(expect.arrayContaining(HOSTOPS_TOOLS));
		expect(prompt).toContain("You run this Pim's host");

		faux.setResponses([record]);
		await sayAs(TOKEN, otherChat, "Hi");
		expect(offered.filter((name) => name.startsWith("hostops_"))).toEqual([]);
		expect(offered).toContain("send_to_user");
		expect(prompt).not.toContain("You run this Pim's host");

		// A member's majordomo is no admin's.
		const memberRoot = (await call("/", { token: memberToken })).body.rootSession as string;
		faux.setResponses([record]);
		await sayAs(memberToken, memberRoot, "Hi");
		expect(offered.filter((name) => name.startsWith("hostops_"))).toEqual([]);
		expect(offered).toContain("send_to_user");
		expect(prompt).not.toContain("You run this Pim's host");
	});

	it("refuse and audit any other agent that reaches them", async () => {
		const results = await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => {
			const session = pim.store.sessionOf(otherChat)!;
			const tools = pim.abilities.get("hostops")!.tools!;
			const run = (name: string, args: Record<string, unknown>) =>
				tools.find((tool) => tool.name === name)!.execute(args as never, { conversationId: session } as never, {} as never) as Promise<{ content: { text: string }[]; isError?: boolean }>;
			return [await run("hostops_restart", { service: "egress-proxy" }), await run("hostops_status", {}), await run("hostops_op", { id: "some-op" })];
		});
		for (const result of results) {
			expect(result.isError).toBe(true);
			expect(JSON.parse(result.content[0]!.text)).toEqual({ error: "Only the admin's majordomo can run operations on this Pim's host.", status: 403 });
		}
		const rejected = (await auditLog()).filter((row) => row.outcome === "rejected").reverse();
		expect(rejected.map((row) => [row.action, row.actorKind, row.actorId, row.args])).toEqual([
			["enqueue", "agent", `${OWNER}/${other}`, { op: "restart", args: { service: "egress-proxy" } }],
			["status", "agent", `${OWNER}/${other}`, null],
			["read", "agent", `${OWNER}/${other}`, { id: "some-op" }],
		]);
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 0, running: 0 });
	});

	it("run an operation end to end for the majordomo, through the daemon", async () => {
		const token = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
		faux.setResponses([toolUse("hostops_logs", { service: "egress-proxy", lines: 20 }), record]);
		const turn = sayAs(TOKEN, ROOT, "Show me the proxy's logs");
		const polled = await poll(token, 10_000);
		expect(polled.body.op).toMatchObject({ name: "logs", args: { service: "egress-proxy", lines: 20 } });
		const id = polled.body.op.id as string;
		expect((await report(token, succeeded(id, { summary: "20 lines", data: { lines: ["started", "listening on :3128"] } }))).status).toBe(200);
		await turn;
		expect(JSON.parse(told)).toMatchObject({ id, op: "logs", state: "succeeded", summary: "20 lines", data: { lines: ["started", "listening on :3128"] } });
		expect(await getHostOp(env, id)).toMatchObject({ caller: { accountId: OWNER, agentId: agentId(), chatId: ROOT } });
		expect((await auditLog()).reverse().map((row) => [row.action, row.outcome, row.actorKind, row.actorId])).toEqual([
			["credential.issue", "ok", "admin", OWNER],
			["enqueue", "queued", "agent", `${OWNER}/${agentId()}`],
			["claim", "running", "hostd", null],
			["result", "succeeded", "hostd", null],
		]);

		// The daemon's status, as the majordomo reads it.
		faux.setResponses([toolUse("hostops_status", {}), record]);
		await sayAs(TOKEN, ROOT, "Is the daemon there?");
		expect(JSON.parse(told)).toMatchObject({ credential: "issued", version: "1.2.3", commit: "abc1234", queue: { queued: 0, running: 0 }, last_seen_at: expect.any(String) });
	});

	it("read the audit log with hostops_audit: who asked, filtered, and no secrets", async () => {
		const token = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
		faux.setResponses([toolUse("hostops_restart", { service: "egress-proxy" }), record]);
		const turn = sayAs(TOKEN, ROOT, "Restart the proxy");
		const id = (await poll(token, 10_000)).body.op.id as string;
		const secret = `tok_${"9fQ2xLmA7".repeat(3)}`;
		await report(token, succeeded(id, { summary: `restarted with ${secret}` }));
		await turn;
		await call("/hostops/ops", { method: "POST", cookie, body: { op: "deploy", args: { ref: "main" } } });

		faux.setResponses([toolUse("hostops_audit", {}), record]);
		await sayAs(TOKEN, ROOT, "What happened on the host?");
		const rows = JSON.parse(told).audit as any[];
		expect(told).not.toContain(secret);
		expect(told).not.toContain(token);
		const queued = rows.find((row) => row.action === "enqueue" && row.operation === "restart");
		expect(queued).toMatchObject({ args: "service=egress-proxy", requested_by: { kind: "agent", agent: agentId(), chat: ROOT }, approval: "not_required", outcome: "queued", op_id: id });
		expect(queued.at).toMatch(/^\d{4}-\d\d-\d\dT/);
		// The daemon's own rows carry the chat that asked for their operation, and the reads of the audit log are audited too.
		expect(rows.find((row) => row.action === "result")).toMatchObject({ operation: "restart", outcome: "succeeded", requested_by: { kind: "hostd", chat: ROOT } });
		expect(rows.find((row) => row.action === "audit")).toBeUndefined();

		faux.setResponses([toolUse("hostops_audit", { op: "deploy", limit: 5 }), record]);
		await sayAs(TOKEN, ROOT, "Only deploys");
		expect(JSON.parse(told).audit.map((row: any) => [row.operation, requestedBy(row)])).toEqual([["deploy", "session"]]);

		faux.setResponses([toolUse("hostops_audit", { since: "2999-01-01T00:00:00Z" }), record]);
		await sayAs(TOKEN, ROOT, "Anything later?");
		expect(JSON.parse(told).audit).toEqual([]);

		faux.setResponses([toolUse("hostops_audit", { limit: 1 }), record]);
		await sayAs(TOKEN, ROOT, "Just the latest");
		expect(JSON.parse(told).audit).toHaveLength(1);
	});

	it("answer a deploy that is still running with its id, which hostops_op then follows to the end", async () => {
		const token = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
		faux.setResponses([toolUse("hostops_deploy", {}), record]);
		const turn = sayAs(TOKEN, ROOT, "Deploy main");
		const polled = await poll(token, 10_000);
		expect(polled.body.op).toMatchObject({ name: "deploy", args: { ref: "origin/main" } });
		const id = polled.body.op.id as string;
		// The daemon doesn't report within the tool's wait.
		await turn;
		expect(JSON.parse(told)).toMatchObject({ id, op: "deploy", state: "running", finished_at: null, note: expect.stringContaining(id) });

		await report(token, { id, ok: false, state: "rolled_back", summary: "health check failed; back on abc1234", data: { from: "abc1234" } });
		faux.setResponses([toolUse("hostops_op", { id }), record]);
		await sayAs(TOKEN, ROOT, "How did it go?");
		expect(JSON.parse(told)).toMatchObject({ id, op: "deploy", state: "rolled_back", summary: "health check failed; back on abc1234", data: { from: "abc1234" } });
		expect(JSON.parse(told).note).toBeUndefined();
	});
});

describe("hostops_exec", () => {
	const COMMAND = "df -h /; echo 'done'";
	let daemon = "";
	/** What the model was told by the last tool result. */
	let told = "";
	const note = (context: { messages: Message[] }) => {
		const result = context.messages.findLast((message) => message.role === "toolResult");
		told = result?.role === "toolResult" && result.content[0]?.type === "text" ? result.content[0].text : "";
		return toolUse("send_to_user", { message: "ok" });
	};

	beforeAll(async () => {
		daemon = "";
	});
	beforeEach(async () => {
		daemon = (await call("/hostops/credential", { method: "POST", cookie })).body.token as string;
	});

	/** The majordomo asks to run `args`; resolves with its approval, once filed, and the turn that waits for the decision. */
	async function ask(args: Record<string, unknown>) {
		faux.setResponses([toolUse("hostops_exec", args as never), note]);
		const turn = say("Run it", ROOT);
		return { approval: await pendingApproval(), turn };
	}
	/** Approves, lets the daemon take the command and report `result`, and returns the operation and the turn's end. */
	async function approveAndRun(approval: { id: string }, turn: Promise<unknown>, result: Record<string, unknown>) {
		const approving = post(`/approvals/${approval.id}/approve`);
		const polled = await poll(daemon, 10_000);
		const id = polled.body.op.id as string;
		await report(daemon, { id, ...result });
		expect((await approving).status).toBe(200);
		await turn;
		return { op: polled.body.op, id };
	}
	const exit3 = { ok: false, state: "failed", summary: "Exited with 3 in 0.2 s.", data: { command: COMMAND, exitCode: 3, signal: null, timedOut: false, durationMs: 210, output: "Filesystem\nno such file\n", truncated: false, outputBytes: 25 } };

	it("asks the person on every call, with the exact command, and queues nothing until they approve", async () => {
		const { approval, turn } = await ask({ command: COMMAND });
		expect(approval).toMatchObject({
			action: "hostops_exec",
			tool: null,
			expiresAt: null,
			onTimeout: "deny",
			summary: `Run on the host as the unprivileged hostopsd user: ${COMMAND}`,
			args: { command: COMMAND, timeoutSeconds: 60, maxOutputBytes: 65536 },
		});
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 0, running: 0 });
		// No always-approve, no permission that skips asking, and no timeout that approves.
		expect((await post(`/approvals/${approval.id}/approve`, { always: true })).status).toBe(400);
		expect((await api("/permissions", { method: "PUT", body: JSON.stringify({ tool: "hostops_exec", permission: "on" }) })).status).toBe(400);
		expect((await api("/permissions")).body.tools.find((info: { tool: string }) => info.tool === "hostops_exec")).toMatchObject({ permission: "ask", choices: ["off", "ask"] });

		expect((await post(`/approvals/${approval.id}/deny`)).status).toBe(200);
		await turn;
		expect(told).toContain("denied");
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 0, running: 0 });
		expect((await auditLog()).filter((row) => row.action === "enqueue")).toEqual([]);

		// The next call asks again.
		const again = await ask({ command: "uptime" });
		expect(again.approval.id).not.toBe(approval.id);
		await post(`/approvals/${again.approval.id}/deny`);
		await again.turn;
	});

	it("runs the approved command through the daemon, which is told nothing of the approval, and audits it with the approver, exit code, duration and output", async () => {
		const { approval, turn } = await ask({ command: COMMAND, timeoutSeconds: 20, maxOutputBytes: 4096 });
		const { op, id } = await approveAndRun(approval, turn, {
			...exit3,
			data: { ...exit3.data, output: `Authorization: Bearer abcdef123456.ghijkl-7890\n${"z".repeat(5000)}\nlast line`, truncated: true },
		});
		expect(op).toMatchObject({ name: "exec", args: { command: COMMAND, timeoutSeconds: 20, maxOutputBytes: 4096 }, deadlineMs: 50_000 });
		expect(Object.keys(op.args).sort()).toEqual(["command", "maxOutputBytes", "timeoutSeconds"]);
		// The model reads the result: failed, with its exit code and output.
		expect(told).toContain("The user approved");
		expect(JSON.parse(told.split("Result:\n")[1]!)).toMatchObject({ id, op: "exec", state: "failed", summary: "Exited with 3 in 0.2 s.", data: { exitCode: 3, truncated: true } });
		const result = (await auditLog()).find((row) => row.action === "result")!;
		expect(result).toMatchObject({ actorKind: "hostd", opId: id, outcome: "failed" });
		expect(result.args).toMatchObject({ command: COMMAND, approver: expect.stringContaining(`${OWNER} (approval ${approval.id}, `), exitCode: 3, timedOut: false, durationMs: 210, truncated: true });
		// The output in the audit log is redacted and capped at 3000 characters, keeping the end.
		expect(result.args.output).not.toContain("abcdef123456");
		expect(result.args.output).toHaveLength(3001);
		expect(result.args.output.endsWith("last line")).toBe(true);
		const queued = (await auditLog()).find((row) => row.action === "enqueue" && row.opId === id)!;
		expect(queued).toMatchObject({ actorKind: "agent", outcome: "queued", args: { op: "exec", args: { command: COMMAND, approval: approval.id } } });
	});

	it("fails a command the daemon does not report within its timeout and a little more", async () => {
		const { approval, turn } = await ask({ command: "sleep 100", timeoutSeconds: 5 });
		const approving = post(`/approvals/${approval.id}/approve`);
		const polled = await poll(daemon, 10_000);
		expect(polled.body.op.deadlineMs).toBe(35_000);
		const id = polled.body.op.id as string;
		await age(id, 36_000);
		expect(await getHostOp(env, id)).toMatchObject({ state: "failed", summary: "timed out" });
		await approving;
		await turn;
	});

	it("runs a command once per approval, and only exactly the one approved", async () => {
		const { approval, turn } = await ask({ command: COMMAND });
		const { id } = await approveAndRun(approval, turn, { ok: true, state: "succeeded", summary: "Exited with 0 in 0.1 s.", data: { exitCode: 0, output: "" } });
		const args = { command: COMMAND, timeoutSeconds: 60, maxOutputBytes: 65536, approval: approval.id };
		const refused = (extra: Record<string, unknown>) => enqueueHostOp(env, majordomo, "exec", { ...args, ...extra }).then(() => 201, (error) => [error.status, error.message]);
		expect(await refused({})).toEqual([409, expect.stringContaining("already ran")]);
		expect(await refused({ command: "rm -rf /" })).toEqual([403, expect.stringContaining("exactly it")]);
		expect(await refused({ timeoutSeconds: 300 })).toEqual([403, expect.stringContaining("exactly it")]);
		expect(await refused({ approval: "no-such-approval" })).toEqual([403, expect.stringContaining("exactly it")]);
		// An approval for anything else is no approval for a command.
		const other = (await api<{ approvals: { id: string; action: string }[] }>("/approvals")).body.approvals.find((candidate) => candidate.action !== "hostops_exec");
		if (other) expect(await refused({ approval: other.id })).toEqual([403, expect.stringContaining("exactly it")]);
		expect((await getHostOp(env, id))!.args).toMatchObject({ approval: approval.id });
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 0, running: 0 });
	});

	it("checks the command's arguments before anyone is asked, or anything is queued", async () => {
		const approval = "a1";
		const cases: Record<string, unknown>[] = [
			{},
			{ command: "" },
			{ command: "   " },
			{ command: "id\0; true" },
			{ command: "x".repeat(2001) },
			{ command: "id", timeoutSeconds: 301 },
			{ command: "id", timeoutSeconds: 0 },
			{ command: "id", timeoutSeconds: "5" },
			{ command: "id", maxOutputBytes: 65537 },
			{ command: "id", maxOutputBytes: 0 },
			{ command: "id", sudo: true },
			{ command: "id", user: "root" },
			{ command: "id", stdin: "x" },
		];
		for (const args of cases) {
			expect(await enqueueHostOp(env, majordomo, "exec", { approval, ...args }).then(() => 201, (error) => error.status), JSON.stringify(args)).toBe(400);
		}
		expect(await enqueueHostOp(env, majordomo, "exec", { command: "id" }).then(() => 201, (error) => error.status)).toBe(400);
		expect((await auditLog(100)).filter((row) => row.outcome === "invalid")).toHaveLength(cases.length + 1);
		// The model's own call is refused the same way, with nothing filed: by the tool's schema, or by the checks.
		faux.setResponses([toolUse("hostops_exec", { command: "id", timeoutSeconds: 301 }), note]);
		await say("Run it", ROOT);
		expect(told).toContain("timeoutSeconds");
		faux.setResponses([toolUse("hostops_exec", { command: "   " }), note]);
		await say("Run it", ROOT);
		expect(JSON.parse(told)).toMatchObject({ status: 400 });
		expect((await api("/approvals?status=pending")).body.approvals).toEqual([]);
	});

	it("is refused, audited and never put to the person for any agent but the admin's majordomo", async () => {
		const helper = (await post("/agents", { name: "Exec helper", instructions: "Helps." })).body.id as string;
		const chat = (await post("/sessions", { agent: helper })).body.id as string;
		const outcome = await runInDurableObject(env.Pim.getByName(OWNER), async (pim: Pim) => {
			const session = pim.store.sessionOf(chat)!;
			const action = pim.abilities.get("hostops")!.actions!.find((candidate) => candidate.name === "hostops_exec")!;
			expect(action.explicitApproval).toBe(true);
			return action.prepare!({ command: "id" } as never, { session });
		});
		expect(outcome).toEqual({ refused: JSON.stringify({ error: "Only the admin's majordomo can run operations on this Pim's host.", status: 403 }) });
		const refused = await enqueueHostOp(env, { kind: "agent", accountId: OWNER, agentId: helper, chatId: chat }, "exec", { command: "id", approval: "a1" }).then(() => 201, (error) => error.status);
		expect(refused).toBe(403);
		for (const other of [{ kind: "session", accountId: OWNER }, { kind: "token", accountId: OWNER }, { kind: "anonymous" }] as const) {
			expect(await enqueueHostOp(env, other, "exec", { command: "id", approval: "a1" }).then(() => 201, (error) => error.status)).toBe(other.kind === "anonymous" ? 401 : 403);
		}
		// Not over the API either: the admin's own token and session are refused.
		expect((await call("/hostops/ops", { method: "POST", cookie, body: { op: "exec", args: { command: "id", approval: "a1" } } })).status).toBe(403);
		expect((await call("/hostops/ops", { method: "POST", token: TOKEN, body: { op: "exec", args: { command: "id", approval: "a1" } } })).status).toBe(403);
		expect((await call("/hostops/status", { cookie })).body.queue).toEqual({ queued: 0, running: 0 });
	});
});
