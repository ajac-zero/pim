/**
 * The goal tools with v1's parameters and answers (`src/extensions/goals.ts`): a plan of at least one step, `update_goal` that ticks off several steps at once by their 1-based
 * numbers, adds steps, leaves a progress note and changes the status, and `list_goals` by status. The service is `Memories` in `@pim/v2-app`, whose step positions are 0-based.
 */
import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ content: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** A goal as the prompt and the tools show it: its steps numbered from 1, the number `update_goal` takes, and its latest progress note. */
export function describeGoal(goal: { id: string; title: string; steps: { title: string; done: boolean }[] }, latestNote?: string): string {
	const done = goal.steps.filter((s) => s.done).length;
	return [`- ${goal.title} (id ${goal.id}, ${done}/${goal.steps.length} steps done)`, ...goal.steps.map((s, i) => `  ${i + 1}. [${s.done ? "x" : " "}] ${s.title}`), ...(latestNote ? [`  Latest note: ${latestNote}`] : [])].join("\n");
}

const Status = Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("done"), Type.Literal("dropped")]);

export function goalTools(deps: { read: Define; write: Define }): ToolRegistration[] {
	const { read, write } = deps;
	const S = Type.String;
	const O = Type.Optional;
	const shown = async (app: App, p: Principal, id: string) => {
		const goal = await app.memories.getGoal(p, id);
		return describeGoal(goal, goal.notes.at(-1)?.text);
	};
	return [
		write("create_goal", "Start tracking a goal the user wants to reach, with an ordered action plan of concrete steps. Use it for anything that takes more than one sitting.", Type.Object({ title: S({ minLength: 1 }), steps: Type.Array(S({ minLength: 1 }), { minItems: 1 }) }), async (app, call, a) =>
			text(`Goal created.\n${await shown(app, call.p, await app.memories.createGoal(call.p, a.title, a.steps))}`)),
		write("update_goal", "Record progress on a goal: mark steps done (1-based numbers), add steps, add a progress note, or change its status (active, paused, done or dropped). title renames it; steps replaces the whole plan.", Type.Object({
			id: S(),
			title: O(S({ minLength: 1 })),
			status: O(Status),
			complete_steps: O(Type.Array(Type.Integer({ minimum: 1 }))),
			add_steps: O(Type.Array(S({ minLength: 1 }))),
			steps: O(Type.Array(S({ minLength: 1 }))),
			note: O(S()),
		}), async (app, call, a) => {
			// A step number that is not in the plan is refused before anything changes.
			if (a.complete_steps?.length) {
				const goal = await app.memories.getGoal(call.p, a.id).catch(() => undefined);
				const count = (goal?.steps.length ?? 0) + (a.steps === undefined ? (a.add_steps?.length ?? 0) : a.steps.length);
				const wrong = a.complete_steps.filter((n: number) => n > count);
				if (goal && wrong.length > 0) return text(`Goal ${a.id} has ${goal.steps.length} steps; there is no step ${wrong.join(", ")}.`, true);
			}
			if (a.title !== undefined || a.status !== undefined || a.steps !== undefined || a.add_steps !== undefined || a.note !== undefined) await app.memories.updateGoal(call.p, a.id, { title: a.title, status: a.status, steps: a.steps, addSteps: a.add_steps, note: a.note });
			for (const n of [...new Set<number>(a.complete_steps ?? [])]) await app.memories.completeStep(call.p, a.id, n - 1);
			return text(`Goal updated.\n${await shown(app, call.p, a.id)}`);
		}),
		read("list_goals", "List the user's goals with their plans and notes, optionally by status.", Type.Object({ status: O(Status) }), async (app, call, a) =>
			text(JSON.stringify((await app.memories.listGoals(call.p)).filter((g) => a.status === undefined || g.status === a.status).map((g) => ({ ...g, steps: g.steps.map((s) => ({ number: s.position + 1, title: s.title, done: s.done })) })), null, 1))),
	];
}
