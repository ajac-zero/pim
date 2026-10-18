import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { Goal, PimStore } from "../store";
import { definePimExtension } from "./define";
import { type PimServices, json, text } from "./services";

const GoalStatus = Type.Union([
	Type.Literal("active"),
	Type.Literal("paused"),
	Type.Literal("done"),
	Type.Literal("abandoned"),
]);

function describeGoal(goal: Goal): string {
	const done = goal.steps.filter((step) => step.done).length;
	const steps = goal.steps.map((step, index) => `  ${index + 1}. [${step.done ? "x" : " "}] ${step.text}`);
	const lastNote = goal.notes.at(-1);
	return [
		`- ${goal.title} (id ${goal.id}, ${done}/${goal.steps.length} steps done)`,
		...steps,
		...(lastNote ? [`  Latest note: ${lastNote.text}`] : []),
	].join("\n");
}

export function goalsExtension({ store }: PimServices) {
	const createGoal = defineTool({
		name: "create_goal",
		description:
			"Start tracking a goal the user wants to reach, with an ordered action plan of concrete steps. Use it for anything that takes more than one sitting.",
		parameters: Type.Object({
			title: Type.String({ minLength: 1 }),
			steps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		}),
		replay: "safe",
		async execute({ title, steps }, api, context) {
			const id = await api.memo("goal", crypto.randomUUID(), context);
			const goal = store.createGoal({ id, title, steps, session: String(api.conversationId) });
			return text(`Goal created.\n${describeGoal(goal)}`);
		},
	});

	const updateGoal = defineTool({
		name: "update_goal",
		description:
			"Record progress on a goal: mark steps done (1-based numbers), add steps, add a progress note, or change its status.",
		parameters: Type.Object({
			id: Type.String(),
			status: Type.Optional(GoalStatus),
			complete_steps: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
			add_steps: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			note: Type.Optional(Type.String()),
		}),
		async execute({ id, status, complete_steps, add_steps, note }) {
			const goal = store.updateGoal(id, {
				...(status ? { status } : {}),
				...(complete_steps ? { completeSteps: complete_steps } : {}),
				...(add_steps ? { addSteps: add_steps } : {}),
				...(note ? { note } : {}),
			});
			return goal ? text(`Goal updated.\n${describeGoal(goal)}`) : text(`No goal with id ${id}.`, true);
		},
	});

	const listGoals = defineTool({
		name: "list_goals",
		description: "List the user's goals with their plans and notes, optionally by status.",
		parameters: Type.Object({ status: Type.Optional(GoalStatus) }),
		replay: "safe",
		async execute({ status }) {
			return json(store.goals(status).map((goal) => ({ ...goal, session: store.publicId(goal.session) })));
		},
	});

	return defineExtension({
		name: "pim.goals",
		tools: [createGoal, updateGoal, listGoals],
		sections: [
			section("active_goals", () => {
				const goals = store.goals("active");
				// Always present: a section that appears later out of order makes pi re-send every section.
				return goals.length === 0 ? "No active goals." : goals.map(describeGoal).join("\n");
			}),
		],
	});
}

/** On a dashboard: the Pim's active goals, newest first, each with its progress and next step. */
export function goalsWidgets(store: PimStore) {
	return definePimExtension({
		id: "pim.goals",
		name: "Goals",
		description: "Goals with step-by-step plans that Pim keeps moving.",
		widgets: {
			active: {
				title: { en: "Goals", es: "Metas" },
				description: "The active goals of this chat's Pim, each with its progress and next step.",
				empty: { en: "No goals yet. Ask to start tracking one.", es: "Aún no hay metas. Pide empezar a seguir una." },
				load: ({ chatOf }) => ({
					kind: "progress",
					items: store
						.goals("active")
						.flatMap((goal) => {
							const chat = chatOf(goal.session);
							if (chat === null) return [];
							const next = goal.steps.find((step) => !step.done);
							return [
								{
									title: goal.title,
									value: goal.steps.filter((step) => step.done).length,
									max: goal.steps.length,
									...(next ? { detail: next.text } : {}),
									link: { chat },
								},
							];
						})
						.slice(0, 5),
				}),
			},
		},
	});
}
