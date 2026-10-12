import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { type Persona, personaInstructions } from "../personas";
import { memberInstructions, memberPreamble, type Role } from "../team";
import type { PimDefinition } from "./define";
import { type PimServices, json } from "./services";

/**
 * How every Pim works, whatever it is for: how it talks to the person, and
 * the rules no Pim's instructions change. Who it is and what it is good at
 * come in the `pim` section, from the Pim it builds on and the person's own
 * instructions.
 */
const PREAMBLE = `You are a Pim, an AI agent working for one person. Who you are in this conversation, and how you work, is in the \`pim\` section.

How you talk to the person:
- They see only what you send with \`send_to_user\`. Everything else you write, between tool calls or at the end of your work, is private working notes they never see.
- When they message you, answer with \`send_to_user\`: usually once, when you have the answer. For long work, a short note first that you're on it is fine.
- When something else wakes you (a scheduled task, an app event, an approval's decision), do the work and send only what is worth their attention. Staying silent is fine, and often right.
- Write like a capable assistant messaging them: short, warm, direct. No filler.

Rules that always hold:
- Ask before acting on the world. Tools that change things outside this conversation (sending requests, messages or purchases) need the person's approval. Calling them files an approval request; do not retry. The decision and result arrive later as a message starting with "[Approval".
- Be honest about what you can and cannot do. Never claim an action happened unless a tool result says so.
- Times: call \`current_time\` when the time matters.`;

/**
 * How every Pim works, and the Pim each chat talks as, or the team member it
 * is (`roleOf` its session). A Pim's instructions are those of the
 * extension's Pim it builds on (`baseOf`), then the person's own.
 */
export function personaExtension(
	services: PimServices,
	roleOf: (session: string) => Role,
	baseOf: (pim: Persona) => PimDefinition | undefined,
) {
	const currentTime = defineTool({
		name: "current_time",
		description: "The current date and time, in UTC and in the user's time zone.",
		parameters: Type.Object({}),
		replay: "safe",
		async execute() {
			const now = new Date();
			return json({
				utc: now.toISOString(),
				timeZone: services.timeZone,
				local: now.toLocaleString("en-US", { timeZone: services.timeZone, dateStyle: "full", timeStyle: "long" }),
			});
		},
	});

	return defineExtension({
		name: "pim.persona",
		sections: [
			section(
				"preamble",
				({ conversationId }) => {
					const { pim, member } = roleOf(String(conversationId));
					return member ? memberPreamble(pim, member) : PREAMBLE;
				},
				{ tag: false },
			),
			section("user_time_zone", () => services.timeZone),
			// Rendered at each request, so a chat follows its Pim's edits from the next one.
			section("pim", ({ conversationId }) => {
				const { pim, member } = roleOf(String(conversationId));
				return member ? memberInstructions(member) : personaInstructions(pim, baseOf(pim));
			}),
		],
		tools: [currentTime],
	});
}
