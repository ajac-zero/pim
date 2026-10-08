import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { AGENT_NAME } from "../src/index";
import { api, connect, lastUserText, post, say, toolUse } from "./helpers";
import { faux, type Pim } from "./worker";

describe("scheduled tasks", () => {
	it("schedules work for later and hands it back to the same session when it fires", async () => {
		faux.setResponses([
			toolUse("schedule_task", {
				instruction: "Check whether the flight price dropped.",
				label: "Flight check",
				delay_seconds: 3600,
			}),
			fauxAssistantMessage("I'll check in an hour."),
		]);
		const before = Date.now();
		await say("Watch the flight price.");
		const { body } = await api("/schedules");
		expect(body.schedules).toHaveLength(1);
		const [schedule] = body.schedules;
		expect(schedule).toMatchObject({ type: "delayed", session: "1", label: "Flight check" });
		const next = Date.parse(schedule.next);
		expect(next).toBeGreaterThanOrEqual(before + 3_599_000);
		expect(next).toBeLessThanOrEqual(Date.now() + 3_601_000);

		// Fire it now instead of waiting an hour.
		let woken = "";
		faux.setResponses([
			(context) => {
				woken = lastUserText(context.messages);
				return fauxAssistantMessage("Same price.");
			},
		]);
		const operation = await runInDurableObject(env.Pim.getByName(AGENT_NAME), async (instance: Pim) => {
			const [due] = await instance.listSchedules();
			await instance.runScheduledTask(due!.payload as never, due as never);
			return `schedule:${due!.id}:${due!.time}`;
		});
		const settled = await api(`/sessions/1/operations/${encodeURIComponent(operation)}`);
		expect(settled.body).toMatchObject({ status: "done", text: "Same price." });
		expect(woken).toBe(`[Scheduled task "Flight check" ${schedule.id}] Check whether the flight price dropped.`);

		expect((await api(`/schedules/${schedule.id}`, { method: "DELETE" })).status).toBe(200);
		expect((await api("/schedules")).body.schedules).toEqual([]);
	});

	it("rejects ambiguous or past times without scheduling anything", async () => {
		let results = "";
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("schedule_task", { instruction: "x", delay_seconds: 60, cron: "0 9 * * *" }),
					fauxToolCall("schedule_task", { instruction: "x", at: "2001-01-01T00:00:00Z" }),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				results = JSON.stringify(context.messages.filter((message) => message.role === "toolResult"));
				return fauxAssistantMessage("Oops.");
			},
		]);
		await say("Remind me.");
		expect(results).toContain("exactly one of delay_seconds, at, or cron");
		expect(results).toContain("is in the past");
		expect((await api("/schedules")).body.schedules).toEqual([]);
	});
});

describe("notifications", () => {
	it("stores notifications and pushes them to every connected socket", async () => {
		const { body: other } = await post("/sessions");
		// Sockets on different sessions both receive it.
		const root = await connect();
		const elsewhere = await connect(other.id);

		faux.setResponses([
			toolUse("notify_user", { title: "Price drop", body: "Your flight is $80 cheaper." }),
			fauxAssistantMessage("Told you."),
		]);
		await say("Tell me if anything changes.");

		for (const { received } of [root, elsewhere]) {
			await vi.waitFor(() => expect(received.some((message) => message.type === "notification")).toBe(true));
		}
		const pushed = root.received.find((message) => message.type === "notification");
		expect(pushed.notification).toMatchObject({ title: "Price drop", body: "Your flight is $80 cheaper.", session: "1" });

		expect((await api("/notifications?unread=true")).body.notifications).toHaveLength(1);
		await post(`/notifications/${pushed.notification.id}/read`);
		expect((await api("/notifications?unread=true")).body.notifications).toEqual([]);
		expect((await api("/notifications")).body.notifications).toHaveLength(1);
		root.socket.close();
		elsewhere.socket.close();
	});
});
