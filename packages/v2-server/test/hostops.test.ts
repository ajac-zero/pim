// Host operations against a real PostgreSQL with every migration applied: who may ask (only the admin's majordomo, after a person approved exactly that operation, once), what the
// daemon is handed and what it is not, the audit log (every refusal kept, secrets taken out), the daemon's credential (issued, rotated, revoked, enrolled) and the deadlines.
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@pim/v2-app/app";
import { connect as connectApp } from "@pim/v2-app/db";
import { createGate } from "@pim/v2-app/gate";
import { MemoryObjectStore } from "@pim/v2-app/objects";
import { hostRoutes, hostServices } from "../src/hostops/routes.ts";
import { checkHostOp, HOST_SERVICES, HostOps } from "../src/hostops/service.ts";
import { createStack, type Stack } from "./support/stack.ts";

describe("host operations", () => {
	let stack: Stack;
	let app: App;
	let server: Server;
	let base: string;
	const people: Record<string, { token: string; ownerId: string }> = {};
	const call = async (bearer: string, method: string, path: string, body?: unknown) => {
		const res = await fetch(base + path, { method, headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		const text = await res.text();
		return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
	};
	const as = (who: string, method: string, path: string, body?: unknown) => call(people[who]!.token, method, path, body);
	let n = 0;
	/** An approval a person gave in the app, as the application records one. */
	const approved = async (who: string, op: string, args: object, by = "user:s_1") => {
		const id = `ap_test${++n}`;
		await stack.admin.query("INSERT INTO pim_app.approvals (id, owner_id, tool, args, state, decided_by, decided_at) VALUES ($1,$2,$3,$4,'approved',$5,now())", [id, people[who]!.ownerId, `hostops_${op}`, JSON.stringify({ op, args, summary: "x" }), by]);
		return id;
	};
	const majordomo = () => ({ kind: "agent" as const, ownerId: people.ada!.ownerId, agentId: "pim", chatId: "chat-1" });
	const hostops = () => hostServices(app).hostops;
	const audit = async () => (await as("ada", "GET", "/api/hostops/audit?limit=200")).json.audit as { action: string; outcome: string; actorKind: string; args: any; detail: string | null }[];

	beforeAll(async () => {
		stack = await createStack();
		app = new App(connectApp(stack.url("gate"), 6), new MemoryObjectStore());
		const ada = await app.identity.register({ username: "ada", bootstrap: await app.identity.issueClaim("bootstrap", null, 3_600_000) });
		await app.identity.setRegistrationOpen({ kind: "user", ownerId: ada.ownerId, role: "admin", sessionId: "s" }, true);
		for (const [name, a] of [["ada", ada], ["bob", await app.identity.register({ username: "bob" })]] as const) people[name] = { ownerId: a.ownerId, token: await app.identity.createSession(a.ownerId) };
		server = createGate(app, { first: hostRoutes() });
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	}, 120_000);
	afterAll(async () => {
		await new Promise<void>((r) => server?.close(() => r()));
		await app?.db.end();
		await stack?.drop();
	});

	it("allows exactly the daemon's own services, which its own copy must say too", () => {
		const daemon = readFileSync(fileURLToPath(new URL("../../../sandbox-manager/hostopsd/validate.js", import.meta.url)), "utf8");
		const listed = /export const COMPOSE_SERVICES = \[([^\]]*)\]/.exec(daemon)?.[1]?.match(/'([^']+)'/g)?.map((s) => s.slice(1, -1));
		expect(listed).toEqual([...HOST_SERVICES]);
		expect(() => checkHostOp("restart", { service: "gate; rm -rf /", approval: "ap_1" })).toThrow(/service must be one of/);
		expect(() => checkHostOp("deploy", { ref: "--upload-pack=x", approval: "ap_1" })).toThrow(/git ref/);
		expect(() => checkHostOp("stats", { extra: 1, approval: "ap_1" })).toThrow(/takes no extra/);
		expect(() => checkHostOp("stats", {})).toThrow(/needs the id of the approval/);
	});

	it("refuses everyone but the majordomo, keeps every refusal, and takes nothing over the API, the admin included", async () => {
		// Nobody can ask over the API: not a person, not the admin, not anonymous.
		expect((await as("ada", "POST", "/api/hostops/ops", { op: "stats", args: {} })).status).toBe(403);
		expect((await as("bob", "POST", "/api/hostops/ops", { op: "exec", args: { command: "id" } })).status).toBe(403);
		expect((await call("", "POST", "/api/hostops/ops", { op: "stats" })).status).toBe(401);
		// An agent that is not the admin's majordomo, a member's majordomo, a delegated task.
		const other = { ...majordomo(), agentId: "ag_other" };
		await expect(hostops().enqueue(other, "stats", {})).rejects.toMatchObject({ status: 403 });
		await expect(hostops().enqueue({ ...majordomo(), ownerId: people.bob!.ownerId }, "stats", {})).rejects.toMatchObject({ status: 403 });
		await expect(hostops().readFor({ kind: "token", ownerId: people.ada!.ownerId }, "x", 0)).rejects.toMatchObject({ status: 403 });
		const rows = await audit();
		expect(rows.filter((r) => r.action === "enqueue" && r.outcome === "rejected").map((r) => r.actorKind).sort()).toEqual(["agent", "agent", "anonymous", "session", "session"]);
		expect(rows.some((r) => r.action === "read" && r.actorKind === "token")).toBe(true);
		// Only the admin, signed in to the app, reads: a member and a token do not.
		expect((await as("bob", "GET", "/api/hostops/status")).status).toBe(403);
		expect((await as("bob", "GET", "/api/hostops/audit")).status).toBe(403);
		expect((await as("ada", "GET", "/api/hostops/status")).json).toMatchObject({ credential: { present: false, revoked: false }, queue: { queued: 0, running: 0 } });
	});

	it("queues an operation only under an approval a person gave for exactly it, and only once", async () => {
		// No approval, someone else's, an agent's or token's decision, and one for other arguments are not approvals.
		await expect(hostops().enqueue(majordomo(), "exec", { command: "df -h /", approval: "ap_missing" })).rejects.toMatchObject({ code: "approval_required" });
		const other = await approved("bob", "exec", { command: "df -h /" });
		await expect(hostops().enqueue(majordomo(), "exec", { command: "df -h /", approval: other })).rejects.toMatchObject({ code: "approval_required" });
		const byAgent = await approved("ada", "exec", { command: "df -h /", timeoutSeconds: 60, maxOutputBytes: 65536 }, "agent:pim");
		await expect(hostops().enqueue(majordomo(), "exec", { command: "df -h /", approval: byAgent })).rejects.toMatchObject({ code: "approval_required" });
		const forOther = await approved("ada", "exec", { command: "ls", timeoutSeconds: 60, maxOutputBytes: 65536 });
		await expect(hostops().enqueue(majordomo(), "exec", { command: "rm -rf /", approval: forOther })).rejects.toMatchObject({ code: "approval_required" });
		const wrongOp = await approved("ada", "stats", {});
		await expect(hostops().enqueue(majordomo(), "restart", { service: "gate", approval: wrongOp })).rejects.toMatchObject({ code: "approval_required" });
		expect((await stack.admin.query("SELECT count(*)::int AS n FROM pim_app.hostops_ops")).rows[0]!.n).toBe(0);

		const ok = await approved("ada", "exec", { command: "df -h /", timeoutSeconds: 60, maxOutputBytes: 65536 });
		const queued = await hostops().enqueue(majordomo(), "exec", { command: "df -h /", approval: ok }, "call-1");
		expect(queued).toMatchObject({ op: "exec", state: "queued", args: { command: "df -h /", approval: ok, approver: expect.stringContaining(`approval ${ok}`) } });
		// The same call asks again after a replay: the same operation. Another call under the same approval is refused.
		expect((await hostops().enqueue(majordomo(), "exec", { command: "df -h /", approval: ok }, "call-1")).id).toBe(queued.id);
		await expect(hostops().enqueue(majordomo(), "exec", { command: "df -h /", approval: ok }, "call-2")).rejects.toMatchObject({ status: 409 });
		expect((await stack.admin.query("SELECT count(*)::int AS n FROM pim_app.hostops_ops")).rows[0]!.n).toBe(1);
	});

	it("hands the daemon an operation with its credential alone, without the approval, and records how it went", async () => {
		expect((await call("", "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(401);
		expect((await call("pimhostops_none", "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(401);
		const issued = await as("ada", "POST", "/api/hostops/credential");
		expect(issued.status).toBe(201);
		const cred = issued.json.token as string;
		expect(cred).toMatch(/^pimhostops_/);
		expect(JSON.stringify((await stack.admin.query("SELECT * FROM pim_app.hostops_credential")).rows)).not.toContain(cred);
		// A session token is not the daemon's credential.
		expect((await as("ada", "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(401);

		const polled = await call(cred, "POST", "/api/hostops/agent/poll", { waitMs: 0, agentVersion: "1.0.0", commit: "abc123" });
		expect(polled.status).toBe(200);
		expect(polled.json.op).toMatchObject({ name: "exec", args: { command: "df -h /" }, deadlineMs: 90_000 });
		expect(Object.keys(polled.json.op.args)).not.toContain("approval");
		expect(Object.keys(polled.json.op.args)).not.toContain("approver");
		expect((await call(cred, "POST", "/api/hostops/agent/poll", { waitMs: 0, agentVersion: "1.0.0", commit: "abc123" })).status).toBe(204);
		expect((await as("ada", "GET", "/api/hostops/status")).json).toMatchObject({ credential: { present: true }, agent: { version: "1.0.0", commit: "abc123" }, queue: { queued: 0, running: 1 } });

		const result = { id: polled.json.op.id, ok: true, state: "succeeded", summary: "Exited with 0 in 0.1 s.", data: { command: "df -h /", exitCode: 0, timedOut: false, durationMs: 100, output: `Filesystem ok\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD\nPIM_TOKEN=supersecretvalue12345`, truncated: false } };
		expect((await call(cred, "POST", "/api/hostops/agent/result", { ...result, ok: false })).status).toBe(400);
		expect((await call(cred, "POST", "/api/hostops/agent/result", result)).json).toMatchObject({ state: "succeeded" });
		// Once: a second report of it is a conflict.
		expect((await call(cred, "POST", "/api/hostops/agent/result", result)).status).toBe(409);
		const finished = (await as("ada", "GET", `/api/hostops/ops/${polled.json.op.id}`)).json;
		expect(finished).toMatchObject({ state: "succeeded", caller: { agentId: "pim", chatId: "chat-1" } });

		const rows = await audit();
		const resultRow = rows.find((r) => r.action === "result" && r.outcome === "succeeded")!;
		expect(resultRow.args).toMatchObject({ command: "df -h /", exitCode: 0, approver: expect.stringContaining("approval ap_test") });
		// What looks like a secret never reaches the log.
		expect(JSON.stringify(rows)).not.toContain("supersecretvalue12345");
		expect(JSON.stringify(rows)).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789ABCD");
		expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["credential.issue", "enqueue", "claim", "result"]));
	});

	it("runs one deploy or rollback at a time, and expires what the host never took", async () => {
		const a = await approved("ada", "deploy", { ref: "origin/main" });
		const first = await hostops().enqueue(majordomo(), "deploy", { ref: "origin/main", approval: a });
		const b = await approved("ada", "rollback", { commit: "abcdef1" });
		await expect(hostops().enqueue(majordomo(), "rollback", { commit: "abcdef1", approval: b })).rejects.toMatchObject({ status: 409 });
		expect((await audit()).some((r) => r.outcome === "conflict")).toBe(true);
		// Ten minutes in the queue and it expires; the next deploy may be asked for.
		await stack.admin.query("UPDATE pim_app.hostops_ops SET created_at = now() - interval '11 minutes' WHERE id = $1", [first.id]);
		expect(await hostops().get(first.id)).toMatchObject({ state: "expired" });
		expect(await hostops().enqueue(majordomo(), "rollback", { commit: "abcdef1", approval: b })).toMatchObject({ state: "queued" });
		// A running operation the daemon never reports fails at its deadline.
		const cred = (await as("ada", "POST", "/api/hostops/credential")).json.token as string;
		const taken = (await call(cred, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).json.op;
		await stack.admin.query("UPDATE pim_app.hostops_ops SET started_at = now() - interval '3 minutes' WHERE id = $1", [taken.id]);
		expect(await hostops().get(taken.id)).toMatchObject({ state: "failed", summary: "timed out" });
		expect((await audit()).filter((r) => ["expire", "timeout"].includes(r.action)).length).toBe(2);
	});

	it("updates only when the majordomo has an approval for it or the admin presses the button, one update at a time, and hands the daemon the tag alone", async () => {
		expect(() => checkHostOp("update", { tag: "--force", approval: "ap_1" })).toThrow(/tag must be/);
		expect(checkHostOp("update", { approval: "ap_1" })).toEqual({ op: "update", args: { approval: "ap_1" } });
		// The majordomo's call is like any other: no approval, no operation.
		await expect(hostops().enqueue(majordomo(), "update", { approval: "ap_missing" })).rejects.toMatchObject({ code: "approval_required" });
		const wrongOp = await approved("ada", "deploy", { ref: "origin/main" });
		await expect(hostops().enqueue(majordomo(), "update", { approval: wrongOp })).rejects.toMatchObject({ code: "approval_required" });
		// The button is the admin's alone, and not a member's or anonymous.
		expect((await as("bob", "POST", "/api/hostops/update", {})).status).toBe(403);
		expect((await call("", "POST", "/api/hostops/update", {})).status).toBe(401);
		expect((await as("ada", "POST", "/api/hostops/update", { tag: "a b" })).status).toBe(400);
		// With no daemon there is nothing to carry it out.
		await stack.admin.query("UPDATE pim_app.hostops_credential SET revoked_at = now() WHERE revoked_at IS NULL");
		expect((await as("ada", "POST", "/api/hostops/update", {})).status).toBe(409);
		const cred = (await as("ada", "POST", "/api/hostops/credential")).json.token as string;
		await call(cred, "POST", "/api/hostops/agent/poll", { waitMs: 0, agentVersion: "1.0.0", commit: "abc123" });
		expect((await as("ada", "GET", "/api/admin/release")).json).toMatchObject({ daemon: { online: true }, update: null });
		const pressed = await as("ada", "POST", "/api/hostops/update", { tag: "edge" });
		expect(pressed.status).toBe(201);
		expect(pressed.json).toMatchObject({ op: "update", state: "queued", args: { tag: "edge", approver: expect.stringContaining("confirmed in Settings") } });
		// Another update, a deploy or a rollback waits for it.
		expect((await as("ada", "POST", "/api/hostops/update", {})).status).toBe(409);
		const a = await approved("ada", "deploy", { ref: "origin/main" });
		await expect(hostops().enqueue(majordomo(), "deploy", { ref: "origin/main", approval: a })).rejects.toMatchObject({ status: 409 });
		const polled = (await call(cred, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).json.op;
		expect(polled).toMatchObject({ id: pressed.json.id, name: "update", args: { tag: "edge" }, deadlineMs: 900_000 });
		expect(Object.keys(polled.args)).toEqual(["tag"]);
		expect((await as("ada", "GET", "/api/admin/release")).json.update).toMatchObject({ id: pressed.json.id, state: "running" });
		await call(cred, "POST", "/api/hostops/agent/result", { id: polled.id, ok: true, state: "succeeded", summary: "Updated.", data: { from: "sha256:a", to: "sha256:b", result: "updated" } });
		expect((await as("ada", "GET", "/api/admin/release")).json.update).toMatchObject({ state: "succeeded", summary: "Updated." });
		expect((await as("bob", "GET", "/api/admin/release")).status).toBe(403);
		expect((await audit()).some((r) => r.actorKind === "admin" && r.action === "enqueue" && r.outcome === "queued")).toBe(true);
	});

	it("rotates the credential, enrolls the host with the shared secret, and lets a revoke stick", async () => {
		const one = (await as("ada", "POST", "/api/hostops/credential")).json;
		const two = (await as("ada", "POST", "/api/hostops/credential")).json;
		expect(two.rotated).toBe(true);
		expect((await call(one.token, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(401);
		expect((await call(two.token, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(204);

		// Enrolling: a Pim with no secret has nothing to enroll with; a wrong one is 401 and kept.
		expect((await call("anything", "POST", "/api/hostops/agent/enroll")).status).toBe(404);
		const secret = "enroll-secret-for-the-test-0123456789";
		const withSecret = new HostOps(app.db, { enrollSecret: secret });
		await expect(withSecret.enroll("wrong", "10.0.0.1")).rejects.toMatchObject({ status: 401 });
		const enrolled = (await withSecret.enroll(secret, "10.0.0.1"))!;
		expect(enrolled.token).toMatch(/^pimhostops_/);
		expect((await call(two.token, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(401);
		expect((await call(enrolled.token, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(204);
		// A revoke by the admin sticks: the host may not enroll again until the admin issues one.
		expect((await as("ada", "DELETE", "/api/hostops/credential")).json).toEqual({ revoked: true });
		expect((await call(enrolled.token, "POST", "/api/hostops/agent/poll", { waitMs: 0 })).status).toBe(401);
		expect(await withSecret.enroll(secret, "10.0.0.1")).toBeNull();
		expect((await as("ada", "GET", "/api/hostops/status")).json.credential).toMatchObject({ present: false, revoked: true });
		await as("ada", "POST", "/api/hostops/credential");
		expect(await withSecret.enroll(secret, "10.0.0.1")).toMatchObject({ token: expect.stringMatching(/^pimhostops_/) });
		const actions = (await audit()).map((r) => `${r.action}:${r.outcome}`);
		expect(actions).toEqual(expect.arrayContaining(["credential.enroll:ok", "credential.enroll:revoked", "credential.revoke:ok", "credential.enroll:rejected"]));
		expect(JSON.stringify(await audit())).not.toContain(enrolled.token);
	});
});
