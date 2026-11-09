import type { Message } from "@earendil-works/pi-ai";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { guestRequest } from "../src/accounts";
import type { Pim } from "../src/pim";
import { API_TABLES } from "../src/triggers/api";
import { ENGINE_KEY, TRIGGER_TICK_CALLBACK } from "../src/triggers/engine";
import { TRIGGER_TOOLS, TRIGGERS_EXTENSION } from "../src/triggers/tools";
import { apiUrl, messagesOf, OWNER, post, ROOT, say, settled, TOKEN, toolUse } from "./helpers";
import { faux, triggerClock } from "./worker";

// Triggers' public API: the HTTP routes and the agents' tools over one space's real SQLite, with the faux model in place
// of a real one. The tests' space was provisioned after it started, so its triggers are on only once the tests turn them on.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const space = () => env.Pim.getByName(OWNER);
const inSpace = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(space(), work);
const sqlOf = (pim: Pim) => (pim as unknown as { ctx: DurableObjectState }).ctx.storage.sql;
const ownEnv = (pim: Pim) => (pim as unknown as { env: Record<string, unknown> }).env;

const clock = () => Date.now() + triggerClock.offset;
const moveTo = (at: number) => {
	triggerClock.offset = at - Date.now();
};

/** A request to the API with headers of its own, its body as text. */
async function call(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; token?: null } = {}) {
	const headers: Record<string, string> = { "content-type": "application/json", ...init.headers };
	const response = await exports.default.fetch(
		new Request(apiUrl(path), {
			method: init.method ?? "GET",
			headers: init.token === null ? headers : { Authorization: `Bearer ${TOKEN}`, ...headers },
			...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
		}),
	);
	const text = await response.text();
	return { status: response.status, etag: response.headers.get("etag"), text, body: text ? JSON.parse(text) : null };
}

function lastToolResult(messages: readonly Message[]): { text: string; isError: boolean } {
	const result = messages.findLast((message) => message.role === "toolResult");
	if (!result || result.role !== "toolResult") throw new Error("no tool result");
	return { text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""), isError: result.isError === true };
}

/** Has the agent of `chat` call one tool, and gives back what it answered, parsed. */
async function tool(name: string, args: Record<string, unknown>, chat = ROOT): Promise<{ isError: boolean; body: any; text: string }> {
	let result = { text: "", isError: false };
	faux.setResponses([
		toolUse(name, args as never),
		(context) => {
			result = lastToolResult(context.messages);
			return toolUse("send_to_user", { message: "Done." });
		},
	]);
	await say(`Please use ${name}`, chat);
	let body: unknown = null;
	try {
		body = JSON.parse(result.text);
	} catch {
		body = null;
	}
	return { ...result, body };
}

/** The tools the model is offered in a chat now. */
async function offeredTools(chat = ROOT): Promise<string[]> {
	let names: string[] = [];
	faux.setResponses([
		(context) => {
			const tools = new Set<string>();
			for (const message of context.messages) {
				if (message.role !== "system") continue;
				for (const added of message.toolsAdded ?? []) tools.add(added.name);
				for (const removed of message.toolsRemoved ?? []) tools.delete(removed.name);
			}
			names = [...tools];
			return toolUse("send_to_user", { message: "Here." });
		},
	]);
	await say("What can you use?", chat);
	return names;
}

/** Every row of every table in the space's database, as text: what a dry run must leave exactly as it was. */
const everything = () =>
	inSpace((pim) => {
		const sql = sqlOf(pim);
		const tables = sql
			.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
			.toArray()
			.map((row) => String(row.name));
		return JSON.stringify(tables.map((table) => [table, sql.exec(`SELECT * FROM "${table}"`).toArray().map((row) => JSON.stringify(row)).sort()]));
	});

const triggerTables = () =>
	inSpace((pim) =>
		sqlOf(pim)
			.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pim_trigger%' ORDER BY name")
			.toArray()
			.map((row) => String(row.name)),
	);

const majordomo = () => inSpace((pim) => pim.agents.majordomo().id);
const cron = (expression = "0 9 * * *", timeZone = "Europe/Lisbon") => ({ kind: "time", schedule: "cron", expression, timeZone });

const NOT_FOUND = { status: 404, text: JSON.stringify({ error: "Not found" }) };

describe("triggers' API where triggers are off", () => {
	it("is any unknown path's 404 on every route and method, offers no tool, and makes nothing", async () => {
		const unknown = await call("/no-such-path");
		expect({ status: unknown.status, text: unknown.text }).toEqual(NOT_FOUND);
		for (const [method, path] of [
			["GET", "/triggers"],
			["POST", "/triggers"],
			["GET", "/triggers/abc"],
			["PATCH", "/triggers/abc"],
			["DELETE", "/triggers/abc"],
			["POST", "/triggers/abc/pause"],
			["POST", "/triggers/abc/resume"],
			["POST", "/triggers/abc/test"],
			["GET", "/triggers/abc/runs"],
			["GET", "/triggers/migration"],
			["GET", "/trigger-runs/abc"],
			["PUT", "/triggers"],
		] as const) {
			const answered = await call(path, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: { label: "x" } }), headers: { "if-match": '"1"' } });
			expect([method, path, answered.status, answered.text, answered.etag]).toEqual([method, path, 404, NOT_FOUND.text, null]);
		}
		const tools = await offeredTools();
		expect(tools).toContain("schedule_task");
		for (const name of TRIGGER_TOOLS) expect(tools).not.toContain(name);
		expect(await inSpace((pim) => pim.registry.snapshot().extension(TRIGGERS_EXTENSION))).toBeUndefined();
		expect(await triggerTables()).toEqual([]);
		// Without a caller, the Worker refuses before the space is asked.
		expect((await call("/triggers", { token: null })).status).toBe(401);
	});
});

describe("triggers' API where triggers are on", () => {
	let boss = "";
	beforeAll(async () => {
		await inSpace((pim) => pim.enableTriggerEngine());
		boss = await majordomo();
	});
	afterAll(async () => {
		triggerClock.offset = 0;
	});

	it("offers its tools in chats, beside schedules' which stay as they were", async () => {
		const tools = await offeredTools();
		for (const name of [...TRIGGER_TOOLS, "schedule_task", "list_scheduled_tasks", "cancel_scheduled_task"]) expect(tools).toContain(name);
		expect(await triggerTables()).not.toContain(API_TABLES[0]);
	});

	it("makes, reads, edits under If-Match, pauses, resumes, tests and deletes a trigger over HTTP", async () => {
		const made = await call("/triggers", { method: "POST", body: { label: "Morning brief", instruction: "Write my brief.", source: cron(), enabled: true } });
		expect(made.status).toBe(201);
		expect(made.etag).toBe('"1"');
		const id = made.body.id as string;
		expect(made.body).toMatchObject({
			revision: 1,
			lifecycle: "enabled",
			health: "unknown",
			healthDetail: null,
			agentId: boss,
			label: "Morning brief",
			source: { kind: "time", schedule: "cron", expression: "0 9 * * *", timeZone: "Europe/Lisbon", catchUpMs: HOUR },
			condition: null,
			destination: { type: "new_chat" },
			origin: { type: "api" },
			policies: { lateness: { catchUpMs: HOUR, coalesce: "latest_due" }, maxPendingEvents: null, pendingSnapshots: 1, rawSamples: false, runsAtOnce: 1, deliveryTtlMs: 24 * HOUR },
			capability: { status: "available", delivers: true, reason: null },
			grant: { required: false, state: "not_required" },
			migration: null,
		});
		expect(made.body.schedule.nextFiringAt).toBeGreaterThan(clock());
		expect(made.body.schedule.nextCheckAt).toEqual(expect.any(Number));

		const read = await call(`/triggers/${id}`);
		expect(read).toMatchObject({ status: 200, etag: '"1"', body: { id, revision: 1 } });

		// The detail a source recorded with its health is read as stored; the store refuses more than 500 characters.
		await inSpace((pim) => {
			const store = pim.triggerEngine()!.store;
			store.setHealth({ id, generation: store.get(id)!.generation, health: "unknown", detail: "x".repeat(500) });
		});
		const detailed = (await call(`/triggers/${id}`)).body;
		expect(detailed).toMatchObject({ health: "unknown", healthDetail: "x".repeat(500) });
		expect((await call("/triggers")).body.triggers.map((trigger: { id: string }) => trigger.id)).toContain(id);

		// Edits name the revision they mean: none is 428, an old one 409 with the current one.
		expect(await call(`/triggers/${id}`, { method: "PATCH", body: { label: "Brief" } })).toMatchObject({ status: 428, body: { code: "revision_required" } });
		const edited = await call(`/triggers/${id}`, { method: "PATCH", body: { label: "Brief" }, headers: { "if-match": '"1"' } });
		expect(edited).toMatchObject({ status: 200, etag: '"2"', body: { revision: 2, label: "Brief", lifecycle: "enabled" } });
		expect(await call(`/triggers/${id}`, { method: "PATCH", body: { label: "Stale" }, headers: { "if-match": '"1"' } })).toMatchObject({
			status: 409,
			body: { code: "revision_conflict", currentRevision: 2 },
		});
		expect(await call(`/triggers/${id}`, { method: "PATCH", body: { label: "Weak" }, headers: { "if-match": 'W/"2"' } })).toMatchObject({ status: 400, body: { code: "invalid_request", field: "If-Match" } });
		expect((await call(`/triggers/${id}`)).body.label).toBe("Brief");

		// Lifecycle apart from the revision; resuming names the revision it turns on.
		expect(await call(`/triggers/${id}/pause`, { method: "POST" })).toMatchObject({ status: 200, body: { lifecycle: "paused", revision: 2, schedule: { nextCheckAt: null } } });
		expect(await call(`/triggers/${id}/pause`, { method: "POST" })).toMatchObject({ status: 409, body: { code: "invalid_transition", lifecycle: "paused" } });
		expect(await call(`/triggers/${id}/resume`, { method: "POST" })).toMatchObject({ status: 428, body: { code: "revision_required" } });
		expect(await call(`/triggers/${id}/resume`, { method: "POST", headers: { "if-match": "1" } })).toMatchObject({ status: 409, body: { code: "revision_conflict", currentRevision: 2 } });
		expect(await call(`/triggers/${id}/resume`, { method: "POST", headers: { "if-match": '"2"' } })).toMatchObject({ status: 200, body: { lifecycle: "enabled" } });

		const tested = await call(`/triggers/${id}/test`, { method: "POST", body: { count: 2 } });
		expect(tested).toMatchObject({ status: 200, body: { dryRun: true, valid: true, id, revision: 2, lifecycle: "enabled", blockers: [], exhausted: false } });
		expect(tested.body.firings).toHaveLength(2);
		expect(tested.body.firings[0]).toMatchObject({ timeZone: "Europe/Lisbon", local: expect.stringMatching(/T09:00:00$/) });
		expect(await call(`/triggers/${id}/test`, { method: "POST", body: { trigger: {} } })).toMatchObject({ status: 400, body: { code: "invalid_request" } });

		// Deleted, it is history: read as deleted, refused for any change, and listed only when asked for.
		expect(await call(`/triggers/${id}`, { method: "DELETE", headers: { "if-match": '"1"' } })).toMatchObject({ status: 409, body: { code: "revision_conflict" } });
		expect(await call(`/triggers/${id}`, { method: "DELETE" })).toMatchObject({ status: 200, body: { deleted: true, trigger: { id, lifecycle: "deleted" } } });
		expect(await call(`/triggers/${id}`)).toMatchObject({ status: 200, body: { lifecycle: "deleted", schedule: { nextFiringAt: null, nextCheckAt: null } } });
		for (const [method, path] of [
			["PATCH", `/triggers/${id}`],
			["DELETE", `/triggers/${id}`],
			["POST", `/triggers/${id}/pause`],
			["POST", `/triggers/${id}/resume`],
		] as const) {
			expect((await call(path, { method, body: { label: "x" }, headers: { "if-match": '"2"' } })).body.code).toBe("trigger_deleted");
		}
		expect((await call("/triggers")).body.triggers.map((trigger: { id: string }) => trigger.id)).not.toContain(id);
		expect((await call("/triggers?lifecycle=deleted")).body.triggers.map((trigger: { id: string }) => trigger.id)).toContain(id);
	});

	it("refuses what it can't take with a code and the field, never the value", async () => {
		const SECRET = "sk_live_51Hx9SeCrEtVaLuE";
		const create = (body: unknown, headers: Record<string, string> = {}) => call("/triggers", { method: "POST", body, headers });
		const base = { label: "Check", instruction: "Check it." };
		const cases: [unknown, number, string, string | undefined][] = [
			[{ ...base, source: cron(`${SECRET} * * * *`) }, 400, "invalid_request", "source.expression"],
			[{ ...base, source: cron("0 9 * * *", SECRET) }, 400, "invalid_request", "source.timeZone"],
			[{ ...base, source: cron(), [SECRET]: 1 }, 400, "invalid_request", "request"],
			[{ ...base, source: { ...cron(), [SECRET]: true } }, 400, "invalid_request", "source"],
			[{ ...base, label: "x".repeat(121), source: cron() }, 400, "invalid_request", "label"],
			[{ ...base, source: cron(), condition: { when: { op: "exists", path: ["a"] } } }, 400, "invalid_request", "condition"],
			[{ ...base, source: cron(), delivery: { rawSamples: true } }, 400, "invalid_request", "delivery.rawSamples"],
			[{ ...base, source: { kind: "time", schedule: "once", at: clock() - HOUR } }, 400, "invalid_request", "source"],
			[{ ...base, source: { kind: "time", schedule: "once", at: "tomorrow" } }, 400, "invalid_request", "source.at"],
			[{ ...base, source: cron(), enabled: "yes" }, 400, "invalid_request", "enabled"],
			[{ ...base, source: { kind: "rss", url: SECRET } }, 400, "invalid_request", "source"],
			[{ ...base, source: { kind: "file", path: "/tmp", events: ["created"] } }, 422, "source_unavailable", "source.kind"],
			[{ ...base, source: { kind: "poll", command: `curl -H 'Authorization: ${SECRET}' x` }, condition: { when: { op: "exists", path: ["a"] } }, enabled: true }, 409, "source_not_wired", undefined],
			[{ ...base, source: { kind: "connector_event", connectorId: "bank", event: "payment", arguments: { token: SECRET } } }, 422, "source_unavailable", "source.event"],
			[{ ...base, source: { kind: "connector_event", connectorId: "bank", event: "payment", arguments: { [SECRET]: { deep: [SECRET] } } } }, 422, "source_unavailable", "source.event"],
			[{ ...base, source: cron(), agentId: "no-such-agent" }, 422, "unknown_agent", "agentId"],
			[{ ...base, source: cron(), destination: { type: "existing_chat", chatId: "no-such-chat" } }, 422, "chat_unavailable", "destination.chatId"],
			[{ ...base, source: cron(), destination: { type: "new_chat", chatId: ROOT } }, 400, "invalid_request", "destination.chatId"],
			[[base], 400, "invalid_request", "request"],
			[`{"label": "${SECRET}"`, 400, "invalid_request", "request"],
		];
		for (const [body, status, code, field] of cases) {
			const answered = await create(body);
			expect([JSON.stringify(body).slice(0, 80), answered.status, answered.body.code, answered.body.field]).toEqual([JSON.stringify(body).slice(0, 80), status, code, field]);
			expect(answered.text).not.toContain(SECRET);
			expect(answered.text).not.toContain("sk_live");
		}
		expect(await create({ ...base, source: cron() }, { "idempotency-key": "has spaces" })).toMatchObject({ status: 400, body: { field: "Idempotency-Key" } });
		expect(await call("/triggers?limit=0")).toMatchObject({ status: 400, body: { code: "invalid_request", field: "limit" } });
		expect(await call("/triggers?limit=51")).toMatchObject({ status: 400, body: { code: "invalid_request", field: "limit" } });
		expect(await call("/triggers?limit=ten")).toMatchObject({ status: 400, body: { field: "limit" } });
		expect(await call("/triggers?lifecycle=gone")).toMatchObject({ status: 400, body: { field: "lifecycle" } });
		expect(await call("/triggers?cursor=bm90LWEtY3Vyc29y")).toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
		expect(await call("/triggers/nothing-here")).toMatchObject({ status: 404, body: { code: "not_found" } });
		expect(await call("/trigger-runs/nothing-here")).toMatchObject({ status: 404, body: { code: "not_found" } });
		// Nothing was made by any of them.
		expect((await call("/triggers")).body.triggers).toEqual([]);
	});

	it("makes a trigger once per Idempotency-Key, and refuses the key for another request", async () => {
		const body = { label: "Daily", instruction: "Do the daily thing.", source: cron("30 7 * * *") };
		const first = await call("/triggers", { method: "POST", body, headers: { "idempotency-key": "make-daily-1" } });
		const again = await call("/triggers", { method: "POST", body, headers: { "idempotency-key": "make-daily-1" } });
		expect(first.status).toBe(201);
		expect(again.status).toBe(200);
		expect(again.body).toEqual(first.body);
		expect(await call("/triggers", { method: "POST", body: { ...body, label: "Other" }, headers: { "idempotency-key": "make-daily-1" } })).toMatchObject({
			status: 409,
			body: { code: "idempotency_conflict" },
		});
		// Without a key, each request is its own.
		const plain = await call("/triggers", { method: "POST", body });
		expect(plain.body.id).not.toBe(first.body.id);
		expect((await call("/triggers")).body.triggers.filter((trigger: { label: string }) => trigger.label === "Daily")).toHaveLength(2);
		// The key is kept as a digest, in the export and in what the space holds.
		const exported = JSON.parse(await inSpace((pim) => pim.exportData())).triggers;
		expect(exported.pim_trigger_api_creations).toEqual([expect.objectContaining({ trigger_id: first.body.id, key: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
		expect(JSON.stringify(exported)).not.toContain("make-daily-1");
		expect(await inSpace((pim) => pim.remainingData())).toContain("triggers' creation keys");
		for (const id of [first.body.id, plain.body.id]) await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("pages triggers within its bounds, oldest first, with cursors that fit only their listing", async () => {
		const ids: string[] = [];
		for (let index = 0; index < 5; index++) {
			ids.push((await call("/triggers", { method: "POST", body: { label: `Page ${index}`, instruction: "Go.", source: cron(`${index} 6 * * *`) } })).body.id);
		}
		const seen: string[] = [];
		let cursor: string | null = null;
		const sizes: number[] = [];
		do {
			const page: { body: { triggers: { id: string }[]; nextCursor: string | null } } = await call(`/triggers?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
			sizes.push(page.body.triggers.length);
			seen.push(...page.body.triggers.map((trigger) => trigger.id));
			cursor = page.body.nextCursor;
		} while (cursor);
		expect(sizes).toEqual([2, 2, 1]);
		expect(seen).toEqual(ids);
		expect((await call("/triggers")).body).toMatchObject({ nextCursor: null });
		expect((await call("/triggers?sourceKind=connector_event")).body.triggers).toEqual([]);
		expect((await call(`/triggers?agentId=${boss}&limit=50`)).body.triggers).toHaveLength(5);
		const first = (await call("/triggers?limit=1")).body.nextCursor as string;
		expect(await call(`/triggers/${ids[0]}/runs?cursor=${first}`)).toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
		for (const id of ids) await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("lists a trigger's runs newest first, page by page, each as honestly as it is known", async () => {
		const anchor = Math.ceil(clock() / MINUTE) * MINUTE;
		const made = await call("/triggers", { method: "POST", body: { label: "Tick", instruction: "Tick.", source: { kind: "time", schedule: "interval", everyMs: MINUTE, anchorAt: anchor }, enabled: true } });
		const id = made.body.id as string;
		// Seven firings admitted as the engine would, one a minute: each supersedes the one before, which never ran.
		moveTo(anchor + 7 * MINUTE + SECOND);
		await inSpace((pim) => {
			const store = pim.triggerEngine()!.store;
			for (let minute = 1; minute <= 7; minute++) {
				expect(store.admitTimeFiring({ id, generation: store.get(id)!.generation, scheduledFor: anchor + minute * MINUTE })).toMatchObject({ status: "accepted" });
			}
		});
		const runs: any[] = [];
		const sizes: number[] = [];
		let cursor: string | null = null;
		do {
			const page: { status: number; body: { runs: any[]; nextCursor: string | null } } = await call(`/triggers/${id}/runs?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
			expect(page.status).toBe(200);
			sizes.push(page.body.runs.length);
			runs.push(...page.body.runs);
			cursor = page.body.nextCursor;
		} while (cursor);
		expect(sizes).toEqual([3, 3, 1]);
		expect(runs.map((run) => run.evidence.scheduledFor)).toEqual([7, 6, 5, 4, 3, 2, 1].map((minute) => anchor + minute * MINUTE));
		expect(runs[0]).toMatchObject({ triggerId: id, revision: 1, state: "pending", outcomeKnown: false, occurrenceStatus: "pending", phase: null, chatId: null, evidence: { reason: "time" } });
		expect(runs.slice(1).map((run) => [run.state, run.outcomeKnown])).toEqual(Array.from({ length: 6 }, () => ["superseded", true]));
		expect(await call(`/trigger-runs/${runs[0].id}`)).toMatchObject({ status: 200, body: { id: runs[0].id, state: "pending" } });
		expect(await call(`/triggers/${id}/runs?limit=51`)).toMatchObject({ status: 400, body: { field: "limit" } });
		await call(`/triggers/${id}`, { method: "DELETE" });
		// Deleted before it was handed on, it says so: never submitted.
		expect(await call(`/trigger-runs/${runs[0].id}`)).toMatchObject({ body: { state: "not_submitted", occurrenceStatus: "cancelled", outcomeKnown: true } });
		triggerClock.offset = 0;
	});

	it("says a run was accepted until its run is known to have ended", async () => {
		const at = clock() + MINUTE;
		const made = await call("/triggers", { method: "POST", body: { label: "Reminder", instruction: "Remind me.", source: { kind: "time", schedule: "once", at: new Date(at).toISOString() }, enabled: true } });
		expect(made.body.source.at).toBe(at);
		const id = made.body.id as string;
		moveTo(made.body.source.at + SECOND);
		faux.setResponses([toolUse("send_to_user", { message: "Reminder." })]);
		await inSpace((pim) => pim.runTriggerTick());
		const [handed] = (await call(`/triggers/${id}/runs`)).body.runs;
		expect(["accepted", "queued", "running"]).toContain(handed.state);
		expect(handed).toMatchObject({ outcomeKnown: false, chatId: expect.any(String), submittedAt: expect.any(Number) });
		await settled(handed.chatId);
		await vi.waitFor(
			async () => {
				moveTo(clock() + 2 * MINUTE);
				await inSpace((pim) => pim.runTriggerTick());
				expect((await call(`/trigger-runs/${handed.id}`)).body).toMatchObject({ state: "completed", outcomeKnown: true, endedAt: expect.any(Number) });
			},
			{ timeout: 10_000, interval: 200 },
		);
		expect((await call(`/triggers/${id}`)).body.lifecycle).toBe("ended");
		expect(await messagesOf(handed.chatId, "user")).toEqual([expect.stringContaining("Remind me.")]);
		triggerClock.offset = 0;
	});

	it("sets the space's wake after every change through the routes and the tools, and the wake runs a new trigger at its time", async () => {
		triggerClock.offset = 0;
		const wakes = () => inSpace(async (pim) => (await pim.listSchedules()).filter((schedule) => schedule.callback === TRIGGER_TICK_CALLBACK));
		// A space the wake was lost from, as a change that never set it left it.
		const loseWakes = () =>
			inSpace(async (pim) => {
				for (const schedule of await pim.listSchedules()) if (schedule.callback === TRIGGER_TICK_CALLBACK) await pim.cancelSchedule(schedule.id);
			});
		/** The one wake, which must come by `due`. */
		const wakeBy = async (due: number) => {
			const [wake, ...more] = await wakes();
			expect(more).toEqual([]);
			expect(wake).toBeDefined();
			expect(wake!.time * SECOND).toBeLessThanOrEqual(due);
			return wake!;
		};
		const once = (at: number) => ({ kind: "time", schedule: "once", at });
		const first = Math.ceil((clock() + 3 * MINUTE) / SECOND) * SECOND;
		const second = first + MINUTE;
		await loseWakes();

		// Made through the route and through the tool, each sets the wake for its time.
		const made = await call("/triggers", { method: "POST", body: { label: "Call mum", instruction: "Remind me to call mum.", source: once(first), enabled: true } });
		expect(made).toMatchObject({ status: 201, body: { lifecycle: "enabled", schedule: { nextFiringAt: first } } });
		const viaRoute = made.body.id as string;
		await wakeBy(first);
		await loseWakes();
		const tooled = await tool("create_trigger", { label: "Stand up", instruction: "Remind me to stand up.", source: once(second), newChat: true, enabled: true });
		expect(tooled.body.trigger).toMatchObject({ lifecycle: "enabled", schedule: { nextFiringAt: second } });
		const viaTool = tooled.body.trigger.id as string;
		await wakeBy(second);

		// Paused, nothing is due, and the wake goes.
		expect((await call(`/triggers/${viaRoute}/pause`, { method: "POST" })).status).toBe(200);
		expect((await tool("pause_trigger", { id: viaTool })).body).toMatchObject({ lifecycle: "paused" });
		expect(await wakes()).toEqual([]);

		// Resumed and edited, each sets it again.
		expect((await call(`/triggers/${viaRoute}/resume`, { method: "POST", headers: { "if-match": '"1"' } })).status).toBe(200);
		await wakeBy(first);
		await loseWakes();
		expect((await tool("resume_trigger", { id: viaTool, expectedRevision: 1 })).body).toMatchObject({ lifecycle: "enabled" });
		await wakeBy(second);
		const sooner = first - MINUTE;
		await loseWakes();
		expect(await call(`/triggers/${viaRoute}`, { method: "PATCH", body: { source: once(sooner) }, headers: { "if-match": '"1"' } })).toMatchObject({ status: 200, body: { schedule: { nextFiringAt: sooner } } });
		await wakeBy(sooner);
		await loseWakes();
		expect((await tool("update_trigger", { id: viaTool, expectedRevision: 1, source: once(sooner) })).body).toMatchObject({ revision: 2, schedule: { nextFiringAt: sooner } });
		await wakeBy(sooner);

		// Deleted, nothing is due, and the wake goes.
		expect((await call(`/triggers/${viaRoute}`, { method: "DELETE" })).status).toBe(200);
		await wakeBy(sooner);
		expect((await tool("delete_trigger", { id: viaTool })).body).toMatchObject({ deleted: true });
		expect(await wakes()).toEqual([]);

		// A trigger an agent made runs at its time from the wake its making set, and nothing else.
		const at = Math.ceil((clock() + 3 * MINUTE) / SECOND) * SECOND;
		const reminder = (await tool("create_trigger", { label: "Tea", instruction: "Remind me the tea is ready.", source: once(at), newChat: true, enabled: true })).body.trigger.id as string;
		moveTo(at + SECOND);
		faux.setResponses([toolUse("send_to_user", { message: "Your tea is ready." })]);
		let handed: any;
		for (let woken = 0; woken < 3 && !handed; woken++) {
			const wake = await wakeBy(at);
			await inSpace((pim) => (pim as unknown as Record<string, () => Promise<void>>)[wake.callback]!());
			[handed] = (await call(`/triggers/${reminder}/runs`)).body.runs;
		}
		expect(handed).toMatchObject({ evidence: { reason: "time", scheduledFor: at }, chatId: expect.any(String) });
		await settled(handed.chatId);
		expect(await messagesOf(handed.chatId, "user")).toEqual([expect.stringContaining("Remind me the tea is ready.")]);
		await vi.waitFor(
			async () => {
				moveTo(clock() + 2 * MINUTE);
				await inSpace((pim) => pim.runTriggerTick());
				expect((await call(`/trigger-runs/${handed.id}`)).body).toMatchObject({ state: "completed" });
			},
			{ timeout: 10_000, interval: 200 },
		);
		triggerClock.offset = 0;

		// A wake that can't be set doesn't fail the change.
		await inSpace((pim) => {
			vi.spyOn(pim, "wakeTriggers").mockRejectedValueOnce(new Error("storage is down"));
		});
		const unwoken = await call("/triggers", { method: "POST", body: { label: "Later", instruction: "Later.", source: once(clock() + HOUR), enabled: true } });
		expect(unwoken).toMatchObject({ status: 201, body: { lifecycle: "enabled" } });
		expect(await inSpace((pim) => vi.mocked(pim.wakeTriggers).mock.settledResults.map((result) => result.type))).toEqual(["rejected"]);
		await inSpace((pim) => vi.mocked(pim.wakeTriggers).mockRestore());
		await call(`/triggers/${unwoken.body.id}`, { method: "DELETE" });
	});

	it("tests without writing anything, starting any turn or running anything, and never repeats a sample's values", async () => {
		const made = await call("/triggers", { method: "POST", body: { label: "Later", instruction: "Later.", source: { kind: "time", schedule: "once", at: clock() + HOUR } } });
		const id = made.body.id as string;
		const before = await everything();
		const tested = await call(`/triggers/${id}/test`, { method: "POST", body: { count: 3 } });
		expect(tested.body).toMatchObject({ dryRun: true, lifecycle: "draft", firings: [{ at: made.body.source.at }], exhausted: true, blockers: [] });
		expect(await call(`/triggers/${id}/test`, { method: "POST", body: { samples: [{ value: 1 }] } })).toMatchObject({ status: 400, body: { field: "samples" } });
		expect(await everything()).toBe(before);

		// A poll can be drafted with no computer paired: its condition is evaluated in order, from a fresh start, on the samples alone, and it says what it lacks to run.
		const SECRET = "[REDACTED:stripe-secret-token]";
		const draft = { label: "Price", instruction: "Tell me.", source: { kind: "poll", command: "echo {}", intervalMs: 5 * MINUTE }, condition: { when: { op: "compare", path: ["price"], cmp: "lt", value: 500 } } };
		const samples = [{ value: { price: 512.37, note: SECRET } }, { value: { price: 455.91, note: SECRET } }, { value: {} }, { value: { price: 410.33 } }];
		const pending = faux.getPendingResponseCount();
		const quiet = await everything();
		const answered = await tool("test_trigger", { trigger: draft, samples });
		expect(answered.isError).toBe(false);
		expect(answered.body).toMatchObject({
			dryRun: true,
			sourceKind: "poll",
			capability: { status: "draft_only", reason: "computer_not_paired" },
			grant: { required: true, state: "missing" },
			blockers: ["source_not_wired", "grant_required"],
		});
		expect(answered.body.evaluations.map((step: { truth: string; fires: boolean }) => [step.truth, step.fires])).toEqual([
			["false", false],
			["true", true],
			["unknown", false],
			["true", false],
		]);
		expect(answered.body.evaluations[2].fields).toEqual([{ path: ["price"], present: false }]);
		expect(answered.text).not.toContain(SECRET);
		expect(answered.text).not.toMatch(/512\.37|455\.91|410\.33/);
		expect(faux.getPendingResponseCount()).toBe(pending);
		// The chat recorded the call; no trigger table changed.
		const triggersNow = JSON.parse(await everything()).filter(([table]: [string]) => table.startsWith("pim_trigger"));
		expect(triggersNow).toEqual(JSON.parse(quiet).filter(([table]: [string]) => table.startsWith("pim_trigger")));
		await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("declares a condition as an object, and takes one written out as JSON text but refuses other text", async () => {
		const schemas = await inSpace((pim) => Object.fromEntries(pim.registry.snapshot().extension(TRIGGERS_EXTENSION)!.tools!.map((candidate) => [candidate.name, JSON.parse(JSON.stringify(candidate.parameters))])));
		const kinds = (schema: { anyOf: { type: string }[] }) => schema.anyOf.map((branch) => branch.type).sort();
		expect(kinds(schemas.create_trigger.properties.condition)).toEqual(["object", "string"]);
		expect(kinds(schemas.test_trigger.properties.trigger.properties.condition)).toEqual(["object", "string"]);
		expect(kinds(schemas.update_trigger.properties.condition)).toEqual(["null", "object", "string"]);
		expect(schemas.test_trigger.properties.samples.items.properties.value.anyOf).toBeDefined();

		const when = { op: "compare", path: ["flag"], cmp: "eq", value: 1 };
		const base = { label: "Flag", instruction: "Tell me.", source: { kind: "poll", command: "echo {}", intervalMs: 5 * MINUTE } };
		const text = await tool("create_trigger", { ...base, condition: JSON.stringify({ when }) });
		expect(text.isError).toBe(false);
		expect(text.body.trigger.condition).toMatchObject({ when });
		for (const bad of ["not json", "[1]", "3", '"x"']) expect((await tool("create_trigger", { ...base, condition: bad })).body).toEqual({ code: "invalid_request", error: "condition: must be an object", field: "condition" });
		await call(`/triggers/${text.body.trigger.id}`, { method: "DELETE" });
	});

	it("lists sources as they are: time and connector events run, the computer's drafts only until one is paired, files not yet", async () => {
		const answered = await tool("list_trigger_sources", {});
		expect(answered.body.sources).toEqual([
			{ kind: "time", status: "available", delivers: true, reason: null, schedules: ["once", "cron", "interval"] },
			{ kind: "connector_event", status: "available", delivers: true, reason: null, connectors: [] },
			{ kind: "poll", status: "draft_only", delivers: false, reason: "computer_not_paired", requiresGrant: true, computerPaired: false },
			{ kind: "stream", status: "draft_only", delivers: false, reason: "computer_not_paired", requiresGrant: true, computerPaired: false },
			{ kind: "process", status: "draft_only", delivers: false, reason: "computer_not_paired", requiresGrant: true, computerPaired: false },
			{ kind: "file", status: "unavailable", delivers: false, reason: "not_wired" },
		]);
	});

	it("keeps a computer source a draft with no computer paired, with no deployment setting for it: nothing grants it or turns it on", async () => {
		// Nothing in the deployment's settings turns computer triggers on or off.
		expect(Object.keys(env).filter((name) => /COMPUTER/.test(name) && /TRIGGER/.test(name))).toEqual([]);
		expect(await inSpace((pim) => Object.keys(ownEnv(pim)).filter((name) => /COMPUTER/.test(name) && /TRIGGER/.test(name)))).toEqual([]);
		expect(await offeredTools()).toContain("trigger_computer_grant");

		const made = await call("/triggers", { method: "POST", body: { label: "Syslog", instruction: "Tell me what it said.", source: { kind: "stream", command: "tail -F /var/log/syslog" } } });
		expect(made).toMatchObject({
			status: 201,
			body: { lifecycle: "draft", capability: { status: "draft_only", delivers: false, reason: "computer_not_paired" }, grant: { required: true, state: "missing" } },
		});
		const id = made.body.id as string;
		// Turning it on, or making one on, is refused until a computer is paired.
		expect(await call(`/triggers/${id}/resume`, { method: "POST", headers: { "if-match": '"1"' } })).toMatchObject({ status: 409, body: { code: "source_not_wired", error: expect.stringContaining("pair one first") } });
		expect(await call("/triggers", { method: "POST", body: { label: "On", instruction: "Now.", source: { kind: "stream", command: "tail -F log" }, enabled: true } })).toMatchObject({
			status: 409,
			body: { code: "source_not_wired" },
		});
		// An agent can't ask for a grant: there is no computer to grant it on.
		const asked = await tool("trigger_computer_grant", { triggerId: id });
		expect(asked).toMatchObject({ isError: true, text: expect.stringContaining("No computer is paired") });
		expect(await inSpace((pim) => pim.store.approvals("pending").filter((approval) => approval.action === "trigger_computer_source"))).toEqual([]);
		expect((await call(`/triggers/${id}`)).body).toMatchObject({ lifecycle: "draft", grant: { state: "missing" } });
		await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("lets agents use their own triggers through tools, the majordomo everyone's, and no agent anyone else's", async () => {
		// The majordomo, in the root chat, makes one for itself: it continues this chat.
		const mine = await tool("create_trigger", { label: "Stretch", instruction: "Remind me to stretch.", source: cron("0 15 * * *", "UTC"), enabled: true });
		expect(mine.isError).toBe(false);
		expect(mine.body).toMatchObject({ replayed: false, trigger: { agentId: boss, lifecycle: "enabled", destination: { type: "existing_chat", chatId: ROOT }, origin: { type: "chat", chatId: ROOT } } });
		const id = mine.body.trigger.id as string;

		const scout = (await post("/agents", { name: "Scout", instructions: "Find things." })).body;
		const scoutChat = (await post("/sessions", { agent: scout.id })).body.id as string;
		for (const [name, args] of [
			["get_trigger", { id }],
			["pause_trigger", { id }],
			["resume_trigger", { id, expectedRevision: 1 }],
			["delete_trigger", { id }],
			["update_trigger", { id, expectedRevision: 1, label: "Mine now" }],
			["list_trigger_runs", { id }],
			["test_trigger", { id }],
		] as const) {
			const refused = await tool(name, args, scoutChat);
			expect([name, refused.isError, refused.body]).toEqual([name, true, { error: "No such trigger", code: "not_found" }]);
		}
		expect((await tool("list_triggers", {}, scoutChat)).body).toEqual({ triggers: [], nextCursor: null });
		expect((await tool("list_triggers", { agentId: boss }, scoutChat)).body).toEqual({ triggers: [], nextCursor: null });
		expect((await tool("create_trigger", { label: "Sneaky", instruction: "x", source: cron(), agentId: boss }, scoutChat)).body).toMatchObject({ code: "forbidden" });

		// Scout's own continues Scout's chat; the majordomo sees both, and makes one for Scout that starts new chats.
		const own = await tool("create_trigger", { label: "Scan", instruction: "Scan.", source: cron("0 8 * * *", "UTC") }, scoutChat);
		expect(own.body.trigger).toMatchObject({ agentId: scout.id, lifecycle: "draft", destination: { type: "existing_chat", chatId: scoutChat } });
		expect((await tool("list_triggers", {}, scoutChat)).body.triggers.map((trigger: { id: string }) => trigger.id)).toEqual([own.body.trigger.id]);
		expect((await tool("list_triggers", {})).body.triggers.map((trigger: { id: string }) => trigger.id)).toEqual(expect.arrayContaining([id, own.body.trigger.id]));
		expect((await tool("create_trigger", { label: "For Scout", instruction: "x", source: cron(), agentId: scout.id, newChat: false })).body).toMatchObject({ code: "forbidden" });
		const forScout = await tool("create_trigger", { label: "For Scout", instruction: "Look.", source: cron(), agentId: scout.id });
		expect(forScout.body.trigger).toMatchObject({ agentId: scout.id, destination: { type: "new_chat" }, origin: { type: "chat", chatId: ROOT } });
		expect((await tool("get_trigger", { id: forScout.body.trigger.id }, scoutChat)).body).toMatchObject({ id: forScout.body.trigger.id });

		// Tools change under the same rules as the routes.
		expect((await tool("update_trigger", { id, expectedRevision: 9, label: "x" })).body).toMatchObject({ code: "revision_conflict", currentRevision: 1 });
		expect((await tool("update_trigger", { id, expectedRevision: 1, label: "Stretch now" })).body).toMatchObject({ revision: 2, label: "Stretch now" });
		expect((await tool("pause_trigger", { id })).body).toMatchObject({ lifecycle: "paused" });
		expect((await tool("resume_trigger", { id, expectedRevision: 2 })).body).toMatchObject({ lifecycle: "enabled" });
		expect((await tool("list_trigger_runs", { id })).body).toEqual({ runs: [], nextCursor: null });
		expect((await tool("delete_trigger", { id })).body).toMatchObject({ deleted: true });
		for (const made of [own.body.trigger.id, forScout.body.trigger.id]) await call(`/triggers/${made}`, { method: "DELETE" });
	});

	it("keys a tool's creation by its durable call, so the same call replayed makes one trigger", async () => {
		expect(await inSpace((pim) => pim.registry.snapshot().extension(TRIGGERS_EXTENSION)?.tools?.map((candidate) => candidate.name))).toEqual([...TRIGGER_TOOLS]);
		// The same tool call (conversation and task) twice, as a replay after an eviction would run it.
		const made = await inSpace(async (pim) => {
			const chat = pim.store.sessionOf(ROOT)!;
			// The space's own tool, as it installed it.
			const installed = pim.registry.snapshot().extension(TRIGGERS_EXTENSION)!;
			const create = installed.tools!.find((candidate) => candidate.name === "create_trigger")!;
			const callApi = { conversationId: Number(chat), taskId: "task-replayed", callId: "call-1" } as never;
			const args = { label: "Replayed", instruction: "Once.", source: cron("0 12 * * *", "UTC") };
			const first = await create.execute(args as never, callApi, undefined as never);
			const second = await create.execute(args as never, callApi, undefined as never);
			const other = await create.execute(args as never, { ...(callApi as object), taskId: "task-other" } as never, undefined as never);
			const text = (result: { content?: readonly { type: string; text?: string }[] }) => JSON.parse(result.content![0]!.text!);
			return { first: text(first), second: text(second), other: text(other) };
		});
		expect(made.first.replayed).toBe(false);
		expect(made.second).toEqual({ trigger: made.first.trigger, replayed: true });
		expect(made.other.replayed).toBe(false);
		expect(made.other.trigger.id).not.toBe(made.first.trigger.id);
		for (const id of [made.first.trigger.id, made.other.trigger.id]) await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("lists schedules' shadows as owned by their schedule, never enabled or changed through the API, and deleting one cancels its schedule", async () => {
		const { shadow, scheduleId } = await inSpace(async (pim) => {
			const chat = pim.store.sessionOf(ROOT)!;
			const scheduled = await pim.schedule("0 9 * * *", "runScheduledTask" as never, { session: chat, instruction: "Write my brief.", label: "Brief", newChat: true });
			const applied = await pim.applyTriggerMigration();
			return { shadow: applied!.find((item) => item.outcome === "created")!, scheduleId: scheduled.id };
		});
		const id = (shadow as { triggerId: string }).triggerId;
		const listed = (await call("/triggers?lifecycle=draft")).body.triggers.find((trigger: { id: string }) => trigger.id === id);
		expect(listed).toMatchObject({ lifecycle: "draft", migration: { kind: "schedule", owner: "legacy", phase: "shadow", enableable: false }, source: { expression: "0 9 * * *", timeZone: "UTC" } });
		expect(await call(`/triggers/${encodeURIComponent(id)}/resume`, { method: "POST", headers: { "if-match": '"1"' } })).toMatchObject({ status: 409, body: { code: "owned_elsewhere" } });
		expect(await call(`/triggers/${encodeURIComponent(id)}`, { method: "PATCH", body: { label: "Mine" }, headers: { "if-match": '"1"' } })).toMatchObject({ status: 409, body: { code: "owned_elsewhere" } });
		expect(await call(`/triggers/${encodeURIComponent(id)}/test`, { method: "POST" })).toMatchObject({ status: 200, body: { blockers: ["owned_elsewhere"] } });
		expect((await tool("resume_trigger", { id, expectedRevision: 1 })).body).toMatchObject({ code: "owned_elsewhere" });
		expect((await call(`/triggers/${encodeURIComponent(id)}`)).body.lifecycle).toBe("draft");
		// Deleting it is how the person stops that work: only at the revision they saw, and then the schedule goes with it.
		expect(await call(`/triggers/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "if-match": '"2"' } })).toMatchObject({ status: 409, body: { code: "revision_conflict" } });
		expect(await inSpace(async (pim) => (await pim.listSchedules()).some((schedule) => schedule.id === scheduleId))).toBe(true);
		expect(await call(`/triggers/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "if-match": '"1"' } })).toMatchObject({ status: 200, body: { deleted: true } });
		expect(await inSpace(async (pim) => (await pim.listSchedules()).some((schedule) => schedule.id === scheduleId))).toBe(false);
		expect((await call(`/triggers/${encodeURIComponent(id)}`)).body).toMatchObject({ lifecycle: "deleted", migration: { phase: "rolled_back", enableable: false } });
		expect(await call(`/triggers/${encodeURIComponent(id)}`, { method: "DELETE" })).toMatchObject({ status: 409, body: { code: "trigger_deleted" } });
	});

	it("shows where each schedule and watch stands in the migration, a page at a time, to the person and the majordomo, and to another agent its own, writing nothing", async () => {
		const scout = (await post("/agents", { name: "Ranger", instructions: "Find things." })).body;
		expect(scout.id).toEqual(expect.any(String));
		const scoutChat = (await post("/sessions", { agent: scout.id })).body.id as string;
		const secret = "whsec_c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMw==";
		const made = await inSpace(async (pim) => {
			const chat = pim.store.sessionOf(ROOT)!;
			const task = (cron: string, payload: Record<string, unknown>) => pim.schedule(cron, "runScheduledTask" as never, { session: chat, ...payload } as never);
			// Moved: a new-chat task scheduled in Ranger's chat, which is Ranger's work.
			const moved = await task("0 9 * * *", { session: pim.store.sessionOf(scoutChat)!, instruction: "MOVED-INSTRUCTION", label: "Scout brief", newChat: true });
			// Given back by a cutback, which stands.
			const back = await task("0 10 * * *", { instruction: "BACK-INSTRUCTION", label: "Back" });
			// A day's name, which triggers would read differently, and no label.
			const named = await task("0 9 * * MON", { instruction: "NAMED-INSTRUCTION" });
			await pim.runTriggerMigration();
			expect(pim.cutbackTriggerMigration([{ kind: "schedule", legacyId: back.id }])!.map((item) => item.outcome)).toEqual(["cut_back"]);
			// Made since the last run: the next one moves it.
			const fresh = await task("0 11 * * *", { instruction: "FRESH-INSTRUCTION", label: "Fresh" });
			return { moved, back, named, fresh };
		});
		const ours = new Set([made.moved.id, made.back.id, made.named.id, made.fresh.id]);
		const schedule = (scheduled: { id: string; time: number }, rest: Record<string, unknown>) => ({ kind: "schedule", legacyId: scheduled.id, nextFiringAt: scheduled.time * 1000, ...rest });
		const expected = [
			schedule(made.moved, { label: "Scout brief", agentId: scout.id, status: "migrated", owner: "trigger", reason: null, triggerId: `legacy:schedule:${made.moved.id}:1` }),
			schedule(made.back, { label: "Back", agentId: boss, status: "given_back", owner: "legacy", reason: "cut_back", triggerId: `legacy:schedule:${made.back.id}:1` }),
			schedule(made.named, { label: null, agentId: boss, status: "unsupported", owner: "legacy", reason: "cron_syntax", triggerId: null }),
			schedule(made.fresh, { label: "Fresh", agentId: boss, status: "migratable", owner: "legacy", reason: null, triggerId: null }),
		].sort((a, b) => (a.legacyId < b.legacyId ? -1 : 1));
		try {
			const before = await everything();
			const listed = await call("/triggers/migration");
			expect(listed.status).toBe(200);
			expect(listed.body.items.filter((item: { legacyId: string }) => ours.has(item.legacyId))).toEqual(expected);
			expect(listed.body.runs).toMatchObject({ startedAt: expect.any(Number), lastRunAt: expect.any(Number), lastRun: "ok" });
			for (const kept of ["INSTRUCTION", secret, "cursor-kept-77", "https://pim.test", "sub_travel_1"]) expect(listed.text).not.toContain(kept);

			// A page at a time, in the same order, until there is no next cursor.
			const paged: unknown[] = [];
			let cursor: string | null = null;
			do {
				const page: Awaited<ReturnType<typeof call>> = await call(`/triggers/migration?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
				expect(page.body.items.length).toBeLessThanOrEqual(2);
				paged.push(...page.body.items);
				cursor = page.body.nextCursor;
			} while (cursor !== null);
			expect(paged).toEqual(listed.body.items);
			expect(await call("/triggers/migration?cursor=nope")).toMatchObject({ status: 400, body: { code: "invalid_cursor" } });
			expect(await call("/triggers/migration?limit=0")).toMatchObject({ status: 400, body: { code: "invalid_request" } });
			expect(await everything()).toBe(before);

			// The majordomo's tool shows the same; Ranger's shows its own and nothing else.
			const majordomo = await tool("list_trigger_migration", { limit: 50 });
			expect(majordomo.body.items.filter((item: { legacyId: string }) => ours.has(item.legacyId))).toEqual(expected);
			expect((await tool("list_trigger_migration", {}, scoutChat)).body.items).toEqual([expected.find((item) => item.legacyId === made.moved.id)]);
		} finally {
			for (const id of [made.moved.id, made.back.id, made.named.id, made.fresh.id]) await call(`/schedules/${id}`, { method: "DELETE" });
			await call(`/agents/${scout.id}`, { method: "DELETE" });
		}
	});

	it("is closed to guests: their accounts can't reach it, and a guest's space has no route or tool of it", async () => {
		const guest = { ownerId: "o_someguest", role: "guest" } as never;
		for (const path of ["/triggers", "/triggers/abc", "/triggers/abc/runs", "/triggers/migration", "/trigger-runs/abc"]) {
			const refused = await guestRequest(env, guest, new Request(apiUrl(path)), path);
			expect([path, refused?.status]).toEqual([path, 403]);
		}
		await inSpace((pim) => pim.store.setMeta("guest_bot", JSON.stringify({ bot: "b_0000000000000000", agent: pim.agents.majordomo().id, sharedAt: 1, owner: "o_admin", tools: [] })));
		try {
			const answered = await call("/triggers");
			expect({ status: answered.status, text: answered.text }).toEqual(NOT_FOUND);
			const fresh = (await post("/sessions", {})).body.id as string;
			const tools = await offeredTools(fresh);
			for (const name of TRIGGER_TOOLS) expect(tools).not.toContain(name);
		} finally {
			await inSpace((pim) => pim.store.deleteMeta("guest_bot"));
		}
	});

	it("is a neutral 404 again, and its tools go, when the space's triggers are turned off", async () => {
		expect((await call("/triggers")).status).toBe(200);
		await inSpace((pim) => pim.disableTriggerEngine());
		expect({ status: (await call("/triggers")).status }).toEqual({ status: 404 });
		const tools = await offeredTools();
		for (const name of TRIGGER_TOOLS) expect(tools).not.toContain(name);
		expect(await inSpace((pim) => pim.registry.snapshot().extension(TRIGGERS_EXTENSION))).toBeUndefined();
	});
});

describe("triggers as a space starts", () => {
	const engine = () => inSpace((pim) => pim.store.meta(ENGINE_KEY) ?? null);
	const neutral = async () => {
		const answered = await call("/triggers");
		return { status: answered.status, text: answered.text };
	};
	const makeTrigger = async (label: string) => {
		const made = await call("/triggers", { method: "POST", body: { label, instruction: "Write my brief.", source: cron(), enabled: true } });
		expect(made.status).toBe(201);
		return made.body.id as string;
	};

	it("turns them on in a person's own space, with its routes and tools, and changes nothing when it starts again", async () => {
		expect(await engine()).toBeNull();
		expect(await neutral()).toEqual(NOT_FOUND);
		await inSpace((pim) => pim.onStart());
		expect(await engine()).toBe("on");
		expect((await call("/triggers")).status).toBe(200);
		const tools = await offeredTools();
		for (const name of [...TRIGGER_TOOLS, "schedule_task"]) expect(tools).toContain(name);
		const id = await makeTrigger("Started");
		await inSpace((pim) => pim.onStart());
		expect(await engine()).toBe("on");
		expect(await call(`/triggers/${id}`)).toMatchObject({ status: 200, body: { revision: 1, lifecycle: "enabled" } });
		await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("keeps what a space the old allowlist opted in has, as it was", async () => {
		await inSpace((pim) => pim.disableTriggerEngine());
		// As the allowlist left a space: on, and marked as the list's.
		await inSpace((pim) => pim.enableTriggerEngine());
		await inSpace((pim) => pim.store.setMeta("triggers:engine:listed", "on"));
		const id = await makeTrigger("Listed");
		const before = await call(`/triggers/${id}`);
		await inSpace((pim) => pim.onStart());
		expect(await engine()).toBe("on");
		expect(await call(`/triggers/${id}`)).toMatchObject({ status: 200, body: before.body });
		expect(await inSpace((pim) => pim.exportData())).toContain(id);
		// A new instance over the same storage, as after an eviction, builds the engine over what it had.
		const rebuilt = await inSpace((pim) => {
			const again = new (pim.constructor as new (ctx: DurableObjectState, env: unknown) => Pim)((pim as unknown as { ctx: DurableObjectState }).ctx, ownEnv(pim));
			return again.triggerEngine()?.store.get(id)?.lifecycle ?? null;
		});
		expect(rebuilt).toBe("enabled");
		await call(`/triggers/${id}`, { method: "DELETE" });
	});

	it("never turns them on in a guest's space, or in one not yet provisioned", async () => {
		await inSpace((pim) => pim.disableTriggerEngine());
		await inSpace((pim) => pim.store.setMeta("guest_bot", JSON.stringify({ bot: "b_0000000000000000", agent: pim.agents.majordomo().id, sharedAt: 1, owner: "o_admin", tools: [] })));
		try {
			await inSpace((pim) => pim.onStart());
			expect(await engine()).toBeNull();
			expect(await neutral()).toEqual(NOT_FOUND);
		} finally {
			await inSpace((pim) => pim.store.deleteMeta("guest_bot"));
		}
		// Started before anyone owns it, as at registration.
		const ownerId = `unprovisioned-${crypto.randomUUID()}`;
		await getAgentByName(env.Pim, ownerId);
		const unprovisioned = env.Pim.getByName(ownerId);
		const before = await runInDurableObject(unprovisioned, async (pim: Pim) => {
			await pim.onStart();
			return { engine: pim.store.meta(ENGINE_KEY) ?? null, built: pim.triggerEngine(), tables: sqlOf(pim).exec("SELECT name FROM sqlite_master WHERE name LIKE 'pim_trigger%'").toArray() };
		});
		expect(before).toEqual({ engine: null, built: null, tables: [] });
		// Provisioned, its next start turns them on.
		const after = await runInDurableObject(unprovisioned, async (pim: Pim) => {
			await pim.provision({ ownerId, username: "unprovisioned" });
			await pim.onStart();
			return pim.triggerEngine() !== null;
		});
		expect(after).toBe(true);
	});

	it("starts the space when turning them on fails, without them, and turns them on at the next start", async () => {
		const started = await inSpace(async (pim) => {
			await pim.disableTriggerEngine();
			const failing = vi.spyOn(pim, "wakeTriggers").mockRejectedValue(new Error("No alarm today"));
			try {
				await pim.onStart();
			} finally {
				failing.mockRestore();
			}
			return { engine: pim.store.meta(ENGINE_KEY) ?? null, built: pim.triggerEngine() !== null, tools: pim.registry.snapshot().extension(TRIGGERS_EXTENSION) !== undefined };
		});
		expect(started).toEqual({ engine: null, built: false, tools: false });
		expect(await neutral()).toEqual(NOT_FOUND);
		// The space answers as ever, and its chats go on.
		expect((await call("/")).status).toBe(200);
		const tools = await offeredTools();
		expect(tools).toContain("schedule_task");
		for (const name of TRIGGER_TOOLS) expect(tools).not.toContain(name);
		await inSpace((pim) => pim.onStart());
		expect(await engine()).toBe("on");
		expect((await call("/triggers")).status).toBe(200);
	});
});
