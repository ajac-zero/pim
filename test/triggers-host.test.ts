import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getAgentByName } from "agents";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pim } from "../src/pim";
import { TaskStore } from "../src/tasks";
import { TriggerCoordinator, type TriggerRun } from "../src/triggers/coordinator";
import { ENGINE_TABLES, TRIGGER_TICK_CALLBACK, type TriggerEngine, triggerHistory } from "../src/triggers/engine";
import { PimTriggerHost, TriggerChatDoc, type TriggerSpace } from "../src/triggers/host";
import { TriggerStore } from "../src/triggers/store";
import { api, lastUserText, messagesOf, OWNER, pendingApproval, post, ROOT, settled, toolUse } from "./helpers";
import { faux, triggerClock } from "./worker";

// Time triggers in Pim itself: the engine, Pim's host over submitTo, and the wake, with the faux model in place of a
// real one. The tests' space was provisioned after it started, so its triggers are on only once a test turns them on.

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const space = () => env.Pim.getByName(OWNER);
const inSpace = <T>(work: (pim: Pim) => T | Promise<T>) => runInDurableObject(space(), work);
const engineOf = (pim: Pim): TriggerEngine => pim.triggerEngine()!;
/** The space's database, which tests read and write directly to stand for a crash at a given point. */
const sqlOf = (pim: Pim) => (pim as unknown as { ctx: DurableObjectState }).ctx.storage.sql;

/** The triggers' clock, which the tests move on; everything else in the space keeps the time. */
const clock = () => Date.now() + triggerClock.offset;
const moveTo = (at: number) => {
	triggerClock.offset = at - Date.now();
};

const base = (agent: string) => ({
	version: 1,
	owningAgentId: agent,
	originChatId: "1",
	label: "Morning brief",
	instruction: "Write my morning brief.",
	destination: { type: "new_chat" },
});
const once = (at: number) => ({ kind: "time", schedule: "once", at });
const interval = (anchorAt: number, everyMs = HOUR) => ({ kind: "time", schedule: "interval", everyMs, anchorAt });

async function create(id: string, spec: unknown): Promise<void> {
	await inSpace(async (pim) => {
		const result = engineOf(pim).store.create({ id, spec, lifecycle: "enabled" });
		if (!result.ok) throw new Error(`not created: ${result.reason} ${JSON.stringify(result)}`);
		await pim.wakeTriggers();
	});
}

const tick = () => inSpace((pim) => pim.runTriggerTick());
const runs = (id: string) => inSpace((pim) => engineOf(pim).coordinator.runs(id));
const run = async (id: string) => (await runs(id))[0]!;
const majordomo = () => inSpace((pim) => pim.agents.majordomo().id);
const publicId = (chat: string) => inSpace((pim) => pim.store.publicId(chat));
const wakes = () => inSpace(async (pim) => (await pim.listSchedules()).filter((schedule) => schedule.callback === TRIGGER_TICK_CALLBACK));
const runsToday = () => inSpace((pim) => pim.usage.today().runs);
const triggerTables = () =>
	inSpace((pim) =>
		sqlOf(pim)
			.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pim_trigger%' ORDER BY name")
			.toArray()
			.map((row) => String(row.name)),
	);
/** The keys of pi's records of inputs to a chat that contain `key`. */
const submissionsIn = (chat: string, key: string) =>
	inSpace((pim) =>
		sqlOf(pim)
			.exec("SELECT request_id FROM pi_submissions WHERE conversation_id = ? AND instr(request_id, ?) > 0 ORDER BY request_id", Number(chat), key)
			.toArray()
			.map((row) => JSON.parse(String(row.request_id)) as string),
	);

const UNSETTLED: readonly TriggerRun["phase"][] = ["submitting", "accepted", "queued", "running", "waiting_approval"];

/** Deletes every trigger, then ticks until no run of theirs is going: nothing a test left runs into the next. */
async function cleanUp() {
	if (!(await inSpace((pim) => pim.triggerEngine() !== null))) return;
	await inSpace((pim) => {
		for (const trigger of engineOf(pim).store.list()) engineOf(pim).store.remove({ id: trigger.id });
	});
	await vi.waitFor(
		async () => {
			moveTo(clock() + 2 * MINUTE);
			await tick();
			const open = await inSpace((pim) => sqlOf(pim).exec(`SELECT COUNT(*) AS n FROM pim_trigger_runs WHERE phase IN (${UNSETTLED.map((phase) => `'${phase}'`).join(", ")})`).one().n);
			expect(open).toBe(0);
		},
		{ timeout: 10_000, interval: 100 },
	);
}

describe("time triggers in Pim", () => {
	afterEach(cleanUp);

	it("builds nothing, and wakes nothing, in a space whose triggers aren't on", async () => {
		expect(await inSpace((pim) => pim.triggerEngine())).toBeNull();
		// A wake left behind runs nothing and makes nothing.
		await tick();
		expect(await triggerTables()).toEqual([]);
		expect(await wakes()).toEqual([]);
		expect(await inSpace((pim) => pim.remainingData())).not.toContain("triggers");
		expect(JSON.parse(await inSpace((pim) => pim.exportData()))).not.toHaveProperty("triggers");
		// On, it makes its tables, and still no wake while nothing waits.
		await inSpace((pim) => pim.enableTriggerEngine());
		expect(await triggerTables()).toEqual([...ENGINE_TABLES].sort());
		expect(await wakes()).toEqual([]);
	});

	it("runs a one-time trigger once, in a new chat with its agent, from its wake", async () => {
		const agent = await majordomo();
		const at = clock() + MINUTE;
		await create("once", { ...base(agent), source: once(at) });
		// A new trigger is looked at at once; then one wake, a minute on, as the space keeps time.
		await tick();
		const [wake, ...more] = await wakes();
		expect(more).toEqual([]);
		expect(wake!.time * SECOND - Date.now()).toBeGreaterThan(55 * SECOND);
		expect(wake!.time * SECOND - Date.now()).toBeLessThanOrEqual(62 * SECOND);

		const before = await runsToday();
		moveTo(at + SECOND);
		faux.setResponses([toolUse("send_to_user", { message: "Here is your brief." })]);
		await tick();
		const started = await run("once");
		expect(started).toMatchObject({ phase: "accepted", chatState: "pinned", scheduledFor: at });
		expect(started.receipt).toMatch(/^pim-trigger:[\w-]{43}$/);
		const chat = started.chatId!;
		expect(await inSpace((pim) => ({ agent: pim.agents.ofSession(chat).id, title: pim.store.sessionInfo(chat)?.title }))).toEqual({ agent, title: "Morning brief" });
		await settled(await publicId(chat));
		const [said] = await messagesOf(await publicId(chat), "user");
		expect(said).toBe(`[Trigger "Morning brief" once] Write my morning brief.\n\n(Due at ${new Date(at).toISOString()}.)`);
		// One run counted, and only one submission under its key.
		expect(await runsToday()).toBe(before + 1);
		expect(await submissionsIn(chat, started.operationId)).toEqual([started.operationId]);

		// Accepted is not done: it is done when the run says so.
		moveTo(clock() + 2 * MINUTE);
		await tick();
		expect(await run("once")).toMatchObject({ phase: "completed" });
		expect(await inSpace((pim) => engineOf(pim).store.get("once")?.lifecycle)).toBe("ended");
		expect(await wakes()).toEqual([]);
		expect(await inSpace((pim) => pim.remainingData())).toEqual(expect.arrayContaining(["triggers", "trigger history", "triggers' runs", "triggers' chats and submissions"]));
		const { triggers } = JSON.parse(await inSpace((pim) => pim.exportData()));
		expect(triggers.pim_triggers).toContainEqual(expect.objectContaining({ id: "once", lifecycle: "ended" }));
		expect(triggers.pim_trigger_runs).toContainEqual(expect.objectContaining({ trigger_id: "once", phase: "completed", receipt: started.receipt }));
		expect(triggers.pim_trigger_host_operations).toContainEqual(expect.objectContaining({ operation_id: started.operationId, chat_id: chat, receipt: started.receipt }));
	});

	it("keeps everything triggers recorded while they are off, hands nothing on, and goes on where it was when they are on again", async () => {
		const agent = await majordomo();
		const anchor = clock() + MINUTE;
		await create("resumed", { ...base(agent), source: interval(anchor) });
		moveTo(anchor + SECOND);
		faux.setResponses([toolUse("send_to_user", { message: "First." })]);
		await tick();
		const first = await run("resumed");
		await settled(await publicId(first.chatId!));
		moveTo(clock() + 2 * MINUTE);
		await tick();
		expect(await run("resumed")).toMatchObject({ phase: "completed" });
		const history = await inSpace((pim) => triggerHistory(sqlOf(pim)));
		const tables = await triggerTables();
		const exported = async () => JSON.parse(await inSpace((pim) => pim.exportData())).triggers;
		expect(await exported()).toEqual(JSON.parse(JSON.stringify(history)));

		// Off for the space: past its next firing, nothing is admitted or handed on, no wake is kept, and nothing is lost or made.
		await inSpace((pim) => pim.disableTriggerEngine());
		expect(await inSpace((pim) => pim.triggerEngine())).toBeNull();
		expect(await wakes()).toEqual([]);
		moveTo(anchor + HOUR + SECOND);
		await tick();
		expect(await inSpace((pim) => triggerHistory(sqlOf(pim)))).toEqual(history);
		expect(await triggerTables()).toEqual(tables);
		expect(await wakes()).toEqual([]);
		expect(await exported()).toEqual(JSON.parse(JSON.stringify(history)));
		expect(await inSpace((pim) => pim.remainingData())).toEqual(expect.arrayContaining(["triggers", "trigger revisions", "triggers' sources", "trigger history", "triggers' runs"]));

		// On again: what it had is as it was, and the firing it passed while off, still within its hour, goes on.
		await inSpace((pim) => pim.enableTriggerEngine());
		expect(await inSpace((pim) => triggerHistory(sqlOf(pim)))).toEqual(history);
		expect(await runs("resumed")).toEqual([expect.objectContaining({ operationId: first.operationId, receipt: first.receipt, phase: "completed" })]);
		expect(await inSpace((pim) => engineOf(pim).store.get("resumed"))).toMatchObject({ revision: 1, lifecycle: "enabled" });
		await inSpace((pim) => pim.wakeTriggers());
		expect(await wakes()).toHaveLength(1);
		faux.setResponses([toolUse("send_to_user", { message: "Second." })]);
		await tick();
		const [, second] = await runs("resumed");
		expect(second).toMatchObject({ phase: "accepted", scheduledFor: anchor + HOUR });
		await settled(await publicId(second!.chatId!));
	});

	it("keeps to two runs at once however many ticks run together, and hands the rest on as runs end", async () => {
		const agent = await majordomo();
		const anchor = clock() + MINUTE;
		for (const id of ["a", "b", "c"]) await create(id, { ...base(agent), label: `Brief ${id}`, source: interval(anchor) });
		moveTo(anchor + SECOND);
		faux.setResponses([toolUse("send_to_user", { message: "One." }), toolUse("send_to_user", { message: "Two." })]);
		await inSpace((pim) => Promise.all([pim.runTriggerTick(), pim.runTriggerTick(), pim.runTriggerTick()]));
		const started = (await Promise.all(["a", "b", "c"].map(runs))).flat().filter((one) => one.phase === "accepted");
		expect(started).toHaveLength(2);
		// However many ticks ran, one wake.
		expect(await wakes()).toHaveLength(1);
		for (const one of started) await settled(await publicId(one.chatId!));

		faux.setResponses([toolUse("send_to_user", { message: "Three." })]);
		moveTo(clock() + 2 * MINUTE);
		await tick();
		const all = (await Promise.all(["a", "b", "c"].map(runs))).flat();
		expect(all.filter((one) => one.phase === "completed")).toHaveLength(2);
		const third = all.find((one) => one.phase === "accepted")!;
		await settled(await publicId(third.chatId!));
	});

	it("waits for the person's approval as the run's own, holding its trigger but no compute, through a pause and a deletion", async () => {
		const agent = await majordomo();
		expect((await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: "explicit" }) })).status).toBe(200);
		try {
			const anchor = clock() + MINUTE;
			await create("asks", { ...base(agent), instruction: "Post the order.", source: interval(anchor) });
			moveTo(anchor + SECOND);
			faux.setResponses([
				toolUse("http_request", { method: "POST", url: "https://hooks.example.test/trigger" }),
				toolUse("send_to_user", { message: "Okay, I didn't post it." }),
			]);
			await tick();
			const approval = await pendingApproval();
			moveTo(clock() + 2 * MINUTE);
			await tick();
			expect(await run("asks")).toMatchObject({ phase: "waiting_approval" });

			// Pausing or deleting the trigger stops nothing the run is doing: the request still waits for the person.
			await inSpace((pim) => engineOf(pim).store.setLifecycle({ id: "asks", to: "paused" }));
			moveTo(clock() + 2 * MINUTE);
			await tick();
			await inSpace((pim) => engineOf(pim).store.remove({ id: "asks" }));
			moveTo(clock() + 2 * MINUTE);
			await tick();
			expect(await run("asks")).toMatchObject({ phase: "waiting_approval" });
			expect((await api(`/approvals/${approval.id}`)).body).toMatchObject({ status: "pending", decidedBy: null });

			expect((await post(`/approvals/${approval.id}/deny`)).body).toMatchObject({ status: "denied", decidedBy: "user" });
			await settled(await publicId((await run("asks")).chatId!));
			moveTo(clock() + 2 * MINUTE);
			await tick();
			expect(await runs("asks")).toEqual([expect.objectContaining({ phase: "completed" })]);
			expect(await inSpace((pim) => engineOf(pim).store.get("asks")?.lifecycle)).toBe("deleted");
		} finally {
			await api("/settings", { method: "PUT", body: JSON.stringify({ approvalPolicy: null }) });
		}
	});

	it("never hands a firing to another chat or agent once its own is deleted", async () => {
		const planner = (await post("/agents", { name: "Planner", instructions: "Plan." })).body;
		const shown = (await post("/sessions", { agent: planner.id })).body.id as string;
		const chat = await inSpace((pim) => pim.store.sessionOf(shown)!);
		const anchor = clock() + MINUTE;
		await create("kept", { ...base(planner.id), destination: { type: "existing_chat", chatId: chat }, source: interval(anchor) });
		const chats = async () => (await api<{ sessions: unknown[] }>("/sessions")).body.sessions.length;

		expect((await api(`/sessions/${shown}`, { method: "DELETE" })).status).toBe(200);
		const before = await chats();
		moveTo(anchor + SECOND);
		await tick();
		expect(await run("kept")).toMatchObject({ phase: "not_submitted", lastError: "the trigger's chat was deleted" });
		expect(await inSpace((pim) => engineOf(pim).store.get("kept"))).toMatchObject({ lifecycle: "enabled", health: "configuration_error", healthDetail: "the trigger's chat was deleted" });

		await create("fresh", { ...base(planner.id), source: interval(clock() + MINUTE) });
		expect((await api(`/agents/${planner.id}`, { method: "DELETE" })).status).toBe(200);
		moveTo(clock() + MINUTE + SECOND);
		await tick();
		expect(await run("fresh")).toMatchObject({ phase: "not_submitted", chatId: null, lastError: "the trigger's agent was deleted" });
		// No chat was made, for the majordomo or anyone.
		expect(await chats()).toBe(before);
	});

	it("hands a firing for a chat carried on to the chat it carries on in, through a chain, and never to a deleted one", async () => {
		const planner = (await post("/agents", { name: "Planner", instructions: "Plan." })).body;
		const shown: string[] = [];
		for (let i = 0; i < 3; i++) shown.push((await post("/sessions", { agent: planner.id })).body.id as string);
		const [first, second, third] = await inSpace((pim) => shown.map((id) => pim.store.sessionOf(id)!));
		// As the continuation hook records it, when a chat grows too long.
		const carry = (from: string, to: string) => inSpace((pim) => pim.store.continueSession(to, from));
		const delivered = async (operationId: string) => (await inSpace((pim) => engineOf(pim).host.operation(operationId)))?.submissionChat;
		const anchor = clock() + MINUTE;
		await create("carried", { ...base(planner.id), destination: { type: "existing_chat", chatId: first! }, source: interval(anchor) });
		const fire = async (at: number, message: string) => {
			moveTo(at + SECOND);
			faux.setResponses([toolUse("send_to_user", { message })]);
			await tick();
			const fired = (await runs("carried")).at(-1)!;
			// The run keeps the trigger's own chat; where it went is the host's record.
			expect(fired).toMatchObject({ phase: "accepted", chatId: first, scheduledFor: at });
			return fired;
		};
		const finish = async (chat: string) => {
			await settled(await publicId(chat));
			moveTo(clock() + 2 * MINUTE);
			await tick();
			expect((await runs("carried")).at(-1)).toMatchObject({ phase: "completed" });
		};

		// Carried on once: the firing goes to the continuation, and nothing to the chat it carries on.
		await carry(first!, second!);
		const once = await fire(anchor, "In the new chat.");
		expect(await delivered(once.operationId)).toBe(second);
		expect(await submissionsIn(second!, once.operationId)).toEqual([once.operationId]);
		expect(await submissionsIn(first!, "carried")).toEqual([]);
		await finish(second!);
		expect((await messagesOf(shown[1]!, "user")).at(-1)).toContain(`[Trigger "Morning brief" carried] Write my morning brief.`);
		expect(await messagesOf(shown[0]!, "user")).toEqual([]);

		// Carried on again: the last of the chain hears it.
		await carry(second!, third!);
		const twice = await fire(anchor + HOUR, "In the newest chat.");
		expect(await delivered(twice.operationId)).toBe(third);
		expect(await submissionsIn(third!, twice.operationId)).toEqual([twice.operationId]);
		expect(await submissionsIn(second!, twice.operationId)).toEqual([]);
		expect(await submissionsIn(first!, "carried")).toEqual([]);
		await finish(third!);

		// The continuation deleted: the firing ends, and goes to no chat earlier in the chain.
		expect((await api(`/sessions/${shown[2]}`, { method: "DELETE" })).status).toBe(200);
		moveTo(anchor + 2 * HOUR + SECOND);
		await tick();
		const gone = (await runs("carried")).at(-1)!;
		expect(gone).toMatchObject({ phase: "not_submitted", chatId: first, scheduledFor: anchor + 2 * HOUR, lastError: "the trigger's chat was deleted" });
		expect(await delivered(gone.operationId)).toBeUndefined();
		expect(await submissionsIn(first!, "carried")).toEqual([]);
		expect(await submissionsIn(second!, "carried")).toEqual([once.operationId]);
		expect(await inSpace((pim) => engineOf(pim).store.get("carried"))).toMatchObject({ lifecycle: "enabled", health: "configuration_error", healthDetail: "the trigger's chat was deleted" });
	});

	it("hands nothing on while the space is suspended, and goes on once it is restored", async () => {
		const agent = await majordomo();
		const anchor = clock() + MINUTE;
		await create("held", { ...base(agent), source: interval(anchor) });
		const before = await runsToday();
		await inSpace((pim) => pim.setStatus("suspended"));
		try {
			moveTo(anchor + SECOND);
			await tick();
			expect(await run("held")).toMatchObject({ phase: "preparing", chatId: null, deferrals: 1, lastError: "the space is suspended" });
			expect(await runsToday()).toBe(before);
		} finally {
			await inSpace((pim) => pim.setStatus("active"));
		}
		faux.setResponses([toolUse("send_to_user", { message: "Back." })]);
		moveTo(clock() + 15 * MINUTE);
		await tick();
		const resumed = await run("held");
		expect(resumed).toMatchObject({ phase: "accepted", scheduledFor: anchor });
		await settled(await publicId(resumed.chatId!));
		expect(await runsToday()).toBe(before + 1);
	});

	it("skips a local time that daylight saving skips, and wakes for the next one", async () => {
		const agent = await majordomo();
		moveTo(Date.parse("2027-03-13T12:00:00Z"));
		await create("early", { ...base(agent), source: { kind: "time", schedule: "cron", expression: "30 2 * * *", timeZone: "America/New_York" } });
		// 02:30 doesn't happen in New York on 14 March 2027.
		moveTo(Date.parse("2027-03-14T12:00:00Z"));
		await tick();
		expect(await runs("early")).toEqual([]);
		const next = Date.parse("2027-03-15T06:30:00Z");
		expect(await inSpace((pim) => engineOf(pim).store.sourceState("early")?.nextWakeAt)).toBe(next);
		const [wake] = await wakes();
		expect(Math.abs(wake!.time * SECOND - (Date.now() + (next - clock())))).toBeLessThan(3 * SECOND);

		moveTo(next + SECOND);
		faux.setResponses([toolUse("send_to_user", { message: "Early brief." })]);
		await tick();
		const started = await run("early");
		expect(started).toMatchObject({ phase: "accepted", scheduledFor: next });
		await settled(await publicId(started.chatId!));
		expect((await messagesOf(await publicId(started.chatId!), "user"))[0]).toContain("(Due at 2027-03-15T06:30:00.000Z (America/New_York).)");
	});

	it("stops waking a schedule that reaches the end of the supported calendar", async () => {
		const agent = await majordomo();
		moveTo(Date.parse("2099-12-31T20:00:00Z"));
		const late = await inSpace((pim) => {
			try {
				return engineOf(pim).store.create({ id: "late", spec: { ...base(agent), source: once(Date.parse("2100-01-01T00:00:00.001Z")) }, lifecycle: "enabled" });
			} catch (error) {
				return String(error);
			}
		});
		expect(late).toBe("TriggerValidationError: spec.source.at: must be from 946684800000 to 4102444800000");
		await create("yearly", { ...base(agent), source: { kind: "time", schedule: "cron", expression: "0 22 31 12 *", timeZone: "UTC" } });
		expect(await wakes()).toHaveLength(1);
		// Late past its hour of catching up, its last firing is missed, and the next would be past 2100.
		moveTo(Date.parse("2099-12-31T23:30:00Z"));
		await tick();
		expect(await runs("yearly")).toEqual([]);
		expect(await inSpace((pim) => engineOf(pim).store.get("yearly"))).toMatchObject({ lifecycle: "enabled", health: "configuration_error" });
		expect(await inSpace((pim) => engineOf(pim).store.occurrences("yearly").map((occurrence) => occurrence.status))).toEqual(["missed"]);
		expect(await wakes()).toEqual([]);
	});
});

describe("the triggers' host in Pim", () => {
	beforeAll(async () => {
		// Back to the time, past the dates the tests before went to: nothing of theirs is left to fire.
		triggerClock.offset = 0;
		await inSpace((pim) => pim.enableTriggerEngine());
	});
	afterEach(cleanUp);

	const host = <T>(work: (engine: TriggerEngine, pim: Pim) => T | Promise<T>) => inSpace((pim) => work(engineOf(pim), pim));
	const evidence = (triggerId: string) => ({
		kind: "time" as const,
		triggerId,
		revision: 1,
		label: "Morning brief",
		scheduledFor: Date.parse("2027-01-15T08:00:00Z"),
		admittedAt: Date.parse("2027-01-15T08:00:01Z"),
		schedule: { schedule: "once" as const, at: Date.parse("2027-01-15T08:00:00Z") },
		older: null,
	});

	it("makes one chat per operation, whatever was lost on the way", async () => {
		const agent = await majordomo();
		// The operation recorded, and nothing made: none is found, and one is made.
		await host((engine, pim) =>
			sqlOf(pim).exec("INSERT INTO pim_trigger_host_operations (operation_id, agent_id, title, chat_made, created_at, updated_at) VALUES ('op-chat', ?, 'Brief', 1, 0, 0)", agent),
		);
		expect(await host((engine) => engine.host.findChat({ operationId: "op-chat" }))).toEqual({ status: "absent" });
		// A chat id recorded as pi staged a commit it never wrote, or one pi gave another chat since, is not the operation's.
		for (const stale of ["999999", "1"]) {
			await host((engine, pim) => sqlOf(pim).exec("UPDATE pim_trigger_host_operations SET chat_id = ? WHERE operation_id = 'op-chat'", stale));
			expect(await host((engine) => engine.host.findChat({ operationId: "op-chat" }))).toEqual({ status: "absent" });
			expect(await host((engine) => engine.host.operation("op-chat")?.chatId)).toBeNull();
		}

		// Made, and the answer lost: asked again, it is the same chat, found or made.
		const made = await host((engine) => engine.host.createChat({ operationId: "op-chat", agentId: agent, title: "Brief" }));
		expect(made).toMatchObject({ status: "created" });
		const chat = (made as { chatId: string }).chatId;
		expect(await host((engine) => engine.host.findChat({ operationId: "op-chat" }))).toEqual({ status: "found", chatId: chat });
		expect(await host((engine) => engine.host.createChat({ operationId: "op-chat", agentId: agent, title: "Brief" }))).toEqual({ status: "created", chatId: chat });
		expect(await host(async (engine, pim) => (await (await pim.harness.pi()).snapshot(TriggerChatDoc, Number(chat) as never, BACKGROUND_CONTEXT))?.operationId)).toBe("op-chat");

		// Written by pi, and cut short before it was tied to its agent: found, and tied then.
		const other = await post("/agents", { name: "Scribe", instructions: "Write." });
		const scribe = other.body.id as string;
		const cut = await host((engine) => engine.host.createChat({ operationId: "op-cut", agentId: scribe, title: "Cut" }));
		const cutChat = (cut as { chatId: string }).chatId;
		await host((engine, pim) => {
			sqlOf(pim).exec("UPDATE pim_trigger_host_operations SET chat_ready = 0 WHERE operation_id = 'op-cut'");
			sqlOf(pim).exec("DELETE FROM pim_agent_sessions WHERE session = ?", cutChat);
		});
		expect(await host((engine) => engine.host.findChat({ operationId: "op-cut" }))).toEqual({ status: "found", chatId: cutChat });
		expect(await host((engine, pim) => pim.agents.ofSession(cutChat).id)).toBe(scribe);
		expect(await host((engine) => engine.host.operation("op-cut"))).toMatchObject({ chatId: cutChat, chatReady: true });
		await api(`/agents/${scribe}`, { method: "DELETE" });
	});

	it("submits once per operation under one key, and finds it when the answer is lost", async () => {
		const agent = await majordomo();
		const chat = await host(async (engine) => ((await engine.host.createChat({ operationId: "op-run", agentId: agent, title: "Brief" })) as { chatId: string }).chatId);
		const submit = (operationId: string) =>
			host((engine) => engine.host.submit({ idempotencyKey: operationId, chatId: chat, agentId: agent, instruction: "Write my morning brief.", evidence: evidence("t") }));
		const before = await runsToday();

		// Over the run limit: refused, with nothing recorded, reserved or submitted.
		await host((engine, pim) => pim.setLimits({ dailyRuns: before }));
		try {
			expect(await submit("op-run")).toMatchObject({ status: "budget_blocked" });
		} finally {
			await host((engine, pim) => pim.setLimits(null));
		}
		expect(await host((engine) => engine.host.operation("op-run")?.submissionKey)).toBeNull();
		expect(await host((engine) => engine.host.lookupSubmission({ operationId: "op-run" }))).toEqual({ status: "absent" });
		expect(await runsToday()).toBe(before);

		// Accepted, and the answer lost: looked up, then submitted again, it is the same submission and receipt, counted once.
		faux.setResponses([toolUse("send_to_user", { message: "Here." })]);
		const [first, during] = await host(async (engine) => {
			const pending = engine.host.submit({ idempotencyKey: "op-run", chatId: chat, agentId: agent, instruction: "Write my morning brief.", evidence: evidence("t") });
			// While it is under way here, nothing about it is known yet, and it isn't submitted twice.
			const meanwhile = await Promise.all([
				engine.host.lookupSubmission({ operationId: "op-run" }),
				engine.host.submit({ idempotencyKey: "op-run", chatId: chat, agentId: agent, instruction: "Write my morning brief.", evidence: evidence("t") }),
			]);
			return [await pending, meanwhile] as const;
		});
		expect(first).toMatchObject({ status: "accepted" });
		expect(during).toEqual([{ status: "unknown" }, expect.objectContaining({ status: "uncertain" })]);
		const receipt = (first as { receipt: string }).receipt;
		expect(await host((engine) => engine.host.lookupSubmission({ operationId: "op-run" }))).toEqual({ status: "accepted", receipt });
		expect(await submit("op-run")).toEqual({ status: "duplicate", receipt });
		expect(await runsToday()).toBe(before + 1);
		expect(await submissionsIn(chat, "op-run")).toEqual(["op-run"]);
		await settled(await publicId(chat));
		expect(await host((engine) => engine.host.lookupRun({ operationId: "op-run", receipt }))).toBe("completed");
		expect(await host((engine) => engine.host.lookupRun({ operationId: "op-run", receipt: "pim-trigger:another" }))).toBe("unknown");

		// Its key recorded, and then the isolate lost before pi took it: absent, and submitted under exactly that key.
		await host((engine, pim) =>
			sqlOf(pim).exec(
				"INSERT INTO pim_trigger_host_operations (operation_id, agent_id, submission_chat, submission_key, keyed_at, created_at, updated_at) VALUES ('op-lost', ?, ?, 'op-lost', 0, 0, 0)",
				agent,
				chat,
			),
		);
		expect(await host((engine) => engine.host.lookupSubmission({ operationId: "op-lost" }))).toEqual({ status: "absent" });
		faux.setResponses([toolUse("send_to_user", { message: "Again." })]);
		expect(await submit("op-lost")).toMatchObject({ status: "accepted" });
		expect(await submissionsIn(chat, "op-lost")).toEqual(["op-lost"]);
		await settled(await publicId(chat));
		expect(await runsToday()).toBe(before + 2);
	});

	it("keeps a woken task's key through its reopening, and a key recorded unwoken unwoken", async () => {
		const agent = await majordomo();
		const shown = (await post("/sessions", { agent })).body.id as string;
		const chat = await inSpace((pim) => pim.store.sessionOf(shown)!);
		const root = await inSpace((pim) => pim.store.sessionOf(ROOT)!);
		const finished = () =>
			inSpace((pim) => {
				const tasks = new TaskStore(sqlOf(pim));
				const task = tasks.start({ kind: "agent", conversation: chat, requester: root, parent: null, root, batch: crypto.randomUUID(), chat: true, position: 0, agent, task: "Watch the fares." });
				tasks.finish(task.id, "completed", "Fares are flat.");
				return task.id;
			});
		const state = (id: string) => inSpace((pim) => new TaskStore(sqlOf(pim)).get(id)!.state);
		const submit = (operationId: string) =>
			host((engine) => engine.host.submit({ idempotencyKey: operationId, chatId: chat, agentId: agent, instruction: "Check the fares.", evidence: evidence("t") }));
		const before = await runsToday();

		const task = await finished();
		// Woken, its agent answers the agent that asked, which hears it in its own chat.
		// Held until the test has seen the task at work again.
		const gate = { open: false };
		faux.setResponses([
			async () => {
				while (!gate.open) await new Promise((resolve) => setTimeout(resolve, 10));
				return toolUse("send_to_user", { message: "Fares dropped 20%." });
			},
			(context) => {
				expect(lastUserText(context.messages)).toMatch(/^\[Task update\]/);
				return toolUse("send_to_user", { message: "Noted." });
			},
		]);
		const woken = await submit("op-wake");
		expect(woken).toMatchObject({ status: "accepted" });
		expect(await host((engine) => engine.host.operation("op-wake")?.submissionKey)).toBe("wake:op-wake");
		// The task is back at work, so the same operation now would go in unwoken: it doesn't, it is the same submission.
		expect(await state(task)).toBe("working");
		expect(await submit("op-wake")).toEqual({ status: "duplicate", receipt: (woken as { receipt: string }).receipt });
		gate.open = true;
		await settled(shown);
		await settled(ROOT);
		expect(await state(task)).toBe("completed");
		expect(await submit("op-wake")).toEqual({ status: "duplicate", receipt: (woken as { receipt: string }).receipt });
		expect(await submissionsIn(chat, "op-wake")).toEqual(["wake:op-wake"]);
		expect(await runsToday()).toBe(before + 1);

		// Recorded unwoken (the task was at work), and lost before pi took it: once the task finished, it still goes in unwoken.
		await host((engine, pim) =>
			sqlOf(pim).exec(
				"INSERT INTO pim_trigger_host_operations (operation_id, agent_id, submission_chat, submission_key, keyed_at, created_at, updated_at) VALUES ('op-plain', ?, ?, 'op-plain', 0, 0, 0)",
				agent,
				chat,
			),
		);
		faux.setResponses([toolUse("send_to_user", { message: "Fares are flat still." })]);
		expect(await submit("op-plain")).toMatchObject({ status: "accepted" });
		expect(await submissionsIn(chat, "op-plain")).toEqual(["op-plain"]);
		expect(await state(task)).toBe("completed");
		await settled(shown);
		expect(await runsToday()).toBe(before + 2);
	});

	it("submits again to the chat a key was recorded with, even once that chat is carried on, and never to a chat outside the run's", async () => {
		const agent = await majordomo();
		const shown: string[] = [];
		for (let i = 0; i < 4; i++) shown.push((await post("/sessions", { agent })).body.id as string);
		const [pinned, carried, later, stranger] = await inSpace((pim) => shown.map((id) => pim.store.sessionOf(id)!));
		const submit = (operationId: string, chatId: string) =>
			host((engine) => engine.host.submit({ idempotencyKey: operationId, chatId, agentId: agent, instruction: "Check the fares.", evidence: evidence("t") }));
		const keyed = (operationId: string, chat: string) =>
			host((engine, pim) =>
				sqlOf(pim).exec(
					"INSERT INTO pim_trigger_host_operations (operation_id, agent_id, submission_chat, submission_key, keyed_at, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0)",
					operationId,
					agent,
					chat,
					operationId,
				),
			);
		await inSpace((pim) => pim.store.continueSession(carried!, pinned!));

		// Keyed for the continuation, and lost before pi took it; carried on again since: it still goes where it was keyed.
		await keyed("op-carried", carried!);
		await inSpace((pim) => pim.store.continueSession(later!, carried!));
		faux.setResponses([toolUse("send_to_user", { message: "Fares are flat." })]);
		expect(await submit("op-carried", pinned!)).toMatchObject({ status: "accepted" });
		expect(await submissionsIn(carried!, "op-carried")).toEqual(["op-carried"]);
		expect(await submissionsIn(later!, "op-carried")).toEqual([]);
		expect(await submissionsIn(pinned!, "op-carried")).toEqual([]);
		await settled(shown[1]);

		// A key recorded for a chat that neither is the run's nor carries it on is refused, and nothing goes in.
		await keyed("op-astray", stranger!);
		expect(await submit("op-astray", pinned!)).toEqual({ status: "failed", reason: "the operation was keyed for another chat" });
		expect(await submissionsIn(stranger!, "op-astray")).toEqual([]);

		// A chat that was never there is refused as a deleted one is, with nothing recorded.
		expect(await submit("op-missing", "999999")).toEqual({ status: "failed", reason: "the trigger's chat was deleted" });
		expect(await host((engine) => engine.host.operation("op-missing"))).toBeUndefined();
	});
});

describe("the triggers' host, cut short", () => {
	beforeAll(async () => {
		// Back to the time, past the dates the tests before went to: nothing of theirs is left to fire.
		triggerClock.offset = 0;
		await inSpace((pim) => pim.enableTriggerEngine());
	});
	afterEach(cleanUp);

	type StartChat = TriggerSpace["startChat"];
	type Submit = TriggerSpace["submit"];

	/**
	 * Pim's own host and coordinator over the space's tables, built by the
	 * test so it can build them again as after a restart, with the space's
	 * real `startChat` and `submit` cut short where a test says, its own
	 * clock, and deadlines that pass only when it says. The engine is off
	 * meanwhile, so its own wake hands nothing on.
	 */
	async function rigged(pim: Pim) {
		const real = engineOf(pim).space;
		await pim.disableTriggerEngine();
		const faults: { startChat: StartChat[]; submit: Submit[] } = { startChat: [], submit: [] };
		const calls = { startChat: 0, submit: 0 };
		const space: TriggerSpace = {
			...real,
			startChat: (...args) => {
				calls.startChat++;
				return (faults.startChat.shift() ?? real.startChat)(...args);
			},
			submit: (...args) => {
				calls.submit++;
				return (faults.submit.shift() ?? real.submit)(...args);
			},
		};
		const time = { now: clock() };
		const deadlines = new Set<() => void>();
		const sleep = (_ms: number, signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				const fire = () => {
					deadlines.delete(fire);
					resolve();
				};
				deadlines.add(fire);
				signal.addEventListener("abort", fire);
			});
		const sql = sqlOf(pim);
		const transaction = <T>(work: () => T): T => (pim as unknown as { ctx: DurableObjectState }).ctx.storage.transactionSync(work);
		const build = () => {
			const store = new TriggerStore(sql, { transaction, now: () => time.now });
			const host = new PimTriggerHost(sql, space);
			return { store, host, coordinator: new TriggerCoordinator(sql, { store, host, transaction, now: () => time.now, sleep, maxRunning: 2 }) };
		};
		return {
			real,
			faults,
			calls,
			time,
			build,
			/** Every question to the host still out passes its deadline. */
			expire: () => {
				for (const fire of [...deadlines]) fire();
			},
			conversations: () => Number(sql.exec("SELECT COUNT(*) AS n FROM pi_conversations").one().n),
			submissions: (chat: string, key: string) => Number(sql.exec("SELECT COUNT(*) AS n FROM pi_submissions WHERE conversation_id = ? AND request_id = ?", Number(chat), JSON.stringify(key)).one().n),
		};
	}

	const completed = (host: PimTriggerHost, run: TriggerRun) =>
		vi.waitFor(async () => expect(await host.lookupRun({ operationId: run.operationId, receipt: run.receipt! })).toBe("completed"), { timeout: 10_000 });

	it("makes one chat and one run when cut short inside the commit that makes the chat, after pi wrote it, and after pi took the input, and a host made again finds them", async () => {
		const agent = await majordomo();
		const before = await runsToday();
		faux.setResponses([toolUse("send_to_user", { message: "Brief." })]);
		await inSpace(async (pim) => {
			const rig = await rigged(pim);
			try {
				const made = rig.conversations();
				const first = rig.build();
				const anchor = rig.time.now + MINUTE;
				expect(first.store.create({ id: "cut", spec: { ...base(agent), source: interval(anchor, 24 * HOUR) }, lifecycle: "enabled" })).toMatchObject({ ok: true });
				rig.time.now = anchor + SECOND;

				// Cut inside the commit that makes the chat, once its id is recorded: pi writes nothing, and the id is pi's to give again.
				rig.faults.startChat.push((agentId, title, init) =>
					rig.real.startChat(agentId, title, async (tx, id) => {
						await init(tx, id);
						throw new Error("cut before pi wrote the chat");
					}),
				);
				await first.coordinator.tick();
				const [run] = first.coordinator.runs("cut");
				const operationId = run!.operationId;
				expect(run).toMatchObject({ phase: "preparing", chatState: "creating", chatId: null });
				expect(first.host.operation(operationId)?.chatId).not.toBeNull();
				expect(rig.conversations()).toBe(made);

				// pi wrote the chat, and the answer was lost before it was tied to its agent.
				rig.faults.startChat.push(async (...args) => {
					await rig.real.startChat(...args);
					throw new Error("answer lost after pi wrote the chat");
				});
				rig.time.now += 15 * MINUTE;
				await first.coordinator.tick();
				expect(rig.conversations()).toBe(made + 1);
				expect(first.coordinator.run(operationId)).toMatchObject({ phase: "preparing", chatState: "creating", chatId: null });

				// pi took the input, and the answer was lost before the host recorded its receipt.
				rig.faults.submit.push(async (...args) => {
					await rig.real.submit(...args);
					throw new Error("answer lost after pi took the input");
				});
				rig.time.now += 15 * MINUTE;
				await first.coordinator.tick();
				const submitting = first.coordinator.run(operationId)!;
				expect(submitting).toMatchObject({ phase: "submitting", chatState: "pinned", receipt: null, lastError: "answer lost after pi took the input" });
				expect(first.host.operation(operationId)).toMatchObject({ chatId: submitting.chatId, chatReady: true, submissionKey: operationId, receipt: null });

				// As after a restart: a host and a coordinator made again, from what is recorded, find the chat and the submission.
				const again = rig.build();
				rig.time.now += 15 * MINUTE;
				await again.coordinator.tick();
				const accepted = again.coordinator.run(operationId)!;
				expect(accepted).toMatchObject({ chatId: submitting.chatId, receipt: expect.stringMatching(/^pim-trigger:[\w-]{43}$/) });
				expect(["accepted", "running", "completed"]).toContain(accepted.phase);
				expect(rig.calls).toEqual({ startChat: 2, submit: 1 });
				expect(rig.conversations()).toBe(made + 1);
				expect(rig.submissions(submitting.chatId!, operationId)).toBe(1);
				expect(pim.agents.ofSession(submitting.chatId!).id).toBe(agent);
				await completed(again.host, accepted);
			} finally {
				await pim.enableTriggerEngine();
			}
		});
		expect(await runsToday()).toBe(before + 1);
	});

	it("waits out a chat and a submission that answer after their deadline, without making another or submitting again", async () => {
		const agent = await majordomo();
		const before = await runsToday();
		faux.setResponses([toolUse("send_to_user", { message: "Late brief." })]);
		await inSpace(async (pim) => {
			const rig = await rigged(pim);
			try {
				const made = rig.conversations();
				const { store, host, coordinator } = rig.build();
				const gates = { chat: false, submit: false };
				const held = { chat: false, submit: false };
				const hold = async (step: "chat" | "submit") => {
					held[step] = true;
					while (!gates[step]) await new Promise((resolve) => setTimeout(resolve, 10));
				};
				rig.faults.startChat.push(async (...args) => {
					await hold("chat");
					return rig.real.startChat(...args);
				});
				rig.faults.submit.push(async (...args) => {
					await hold("submit");
					return rig.real.submit(...args);
				});
				/** A tick whose question held at `step` passes its deadline. */
				const tickPast = async (step: "chat" | "submit") => {
					const ticking = coordinator.tick();
					await vi.waitFor(() => expect(held[step]).toBe(true));
					rig.expire();
					await ticking;
				};
				const anchor = rig.time.now + MINUTE;
				expect(store.create({ id: "late", spec: { ...base(agent), source: interval(anchor, 24 * HOUR) }, lifecycle: "enabled" })).toMatchObject({ ok: true });
				rig.time.now = anchor + SECOND;

				await tickPast("chat");
				const operationId = coordinator.runs("late")[0]!.operationId;
				expect(coordinator.run(operationId)).toMatchObject({ phase: "preparing", chatState: "creating", lastError: expect.stringContaining("no answer within") });
				// Asked again while it is still being made: not known, so no other is made.
				rig.time.now += 15 * MINUTE;
				await coordinator.tick();
				expect(coordinator.run(operationId)).toMatchObject({ chatState: "creating", lastError: "whether its chat was made isn't known yet" });
				expect(rig.calls.startChat).toBe(1);
				gates.chat = true;
				await vi.waitFor(() => expect(host.operation(operationId)?.chatReady).toBe(true));

				rig.time.now += 15 * MINUTE;
				await tickPast("submit");
				expect(coordinator.run(operationId)).toMatchObject({ phase: "submitting", chatState: "pinned", receipt: null });
				// Asked about while it is still being submitted: not known, so it isn't submitted again.
				rig.time.now += 15 * MINUTE;
				await coordinator.tick();
				expect(coordinator.run(operationId)).toMatchObject({ phase: "submitting", unknownAnswers: 1 });
				expect(rig.calls.submit).toBe(1);
				gates.submit = true;
				await vi.waitFor(async () => expect((await host.lookupSubmission({ operationId })).status).toBe("accepted"));

				rig.time.now += 15 * MINUTE;
				await coordinator.tick();
				const accepted = coordinator.run(operationId)!;
				expect(["accepted", "running", "completed"]).toContain(accepted.phase);
				expect(rig.calls).toEqual({ startChat: 1, submit: 1 });
				expect(rig.conversations()).toBe(made + 1);
				expect(rig.submissions(accepted.chatId!, operationId)).toBe(1);
				await completed(host, accepted);
			} finally {
				await pim.enableTriggerEngine();
			}
		});
		expect(await runsToday()).toBe(before + 1);
	});
});

describe("a space with triggers, erased", () => {
	it("keeps nothing of them", async () => {
		triggerClock.offset = 0;
		const ownerId = `erased-${crypto.randomUUID()}`;
		const stub = await getAgentByName(env.Pim, ownerId);
		await stub.provision({ ownerId, username: "erased" });
		const erased = env.Pim.getByName(ownerId);
		await runInDurableObject(erased, async (pim: Pim) => {
			await pim.enableTriggerEngine();
			const agent = pim.agents.majordomo().id;
			expect(engineOf(pim).store.create({ id: "daily", spec: { ...base(agent), source: interval(clock() + HOUR) }, lifecycle: "enabled" })).toMatchObject({ ok: true });
			await pim.wakeTriggers();
			expect(await pim.remainingData()).toEqual(expect.arrayContaining(["triggers", "trigger revisions", "triggers' sources"]));
		});
		await runInDurableObject(erased, (pim: Pim) => pim.deleteEverything()).catch(() => undefined);
		expect(await runInDurableObject(env.Pim.getByName(ownerId), (pim: Pim) => pim.erasure())).toEqual({ sealed: true, remaining: [] });
		expect(await runInDurableObject(env.Pim.getByName(ownerId), (pim: Pim) => pim.triggerEngine())).toBeNull();
	});
});
