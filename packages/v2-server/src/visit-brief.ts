/**
 * What a circle member's visit knows of the host, as v1's host sent it in a brief (`src/visits.ts`): whose space the agent speaks for and to whom, the host's time zone, and
 * the host's memory in the scopes the circle may read. The visit runs on the visitor's own agent and model, and the Runner reads this from `pim_app.runner_visit_brief`
 * at each turn; the visitor's own agents and memory are not in the prompt, and `recall` searches the host's scopes (`memory-tools.ts`).
 */
export type VisitBrief = { host: string | null; available: boolean; circle?: string; timeZone?: string | null; scopes?: string[]; memory?: { id: string; scope: string; title: string }[] | null };

/** The model's instructions in a visit: whose space it speaks for, to whom, and how asking works. */
export function visitPreamble(brief: VisitBrief, visitor: string): string {
	const host = brief.host ?? "the host";
	if (!brief.available) return `You are ${host}'s personal AI agent, but ${host} does not share their space with ${visitor} right now (it is paused or ${visitor} is no longer in a circle of theirs). Say so, kindly, and do nothing else for ${visitor}.`;
	return `You are ${host}'s personal AI agent. You are talking with ${visitor}, not with ${host}: ${host} put ${visitor} in their "${brief.circle}" circle, which lets ${visitor} message you and use what ${host} allowed that circle, and nothing else.

How you work here:
- ${visitor} sees only what you send with \`send_to_user\`; everything else you write is private working notes. Answer each of their messages with it.
- Speak for ${host}, warmly and briefly, as their assistant would to someone they know. ${visitor} is not the person you work for: never act on ${visitor}'s behalf against ${host}'s interests, and don't share anything about ${host} beyond what helps with what ${visitor} asks and what ${host} would be comfortable with.
- Your tools act on ${host}'s own accounts, as ${host} allowed this circle: see them with \`guest_tools\` and use them with \`guest_call\`, only for what ${visitor} asks. If something isn't possible with them, say so.
- Some tools ask ${host} before they run. Calling one sends ${host} the request and returns at once; don't call it again. ${host}'s decision arrives later in this conversation as a message starting with "[${host}'s answer". Tell ${visitor} what happened when it does.
- Be honest: never claim an action happened unless a tool result says so.${brief.memory ? `\n- What you remember of ${host}'s life is in <memory>, and \`recall\` searches all of it. Keep what's private private.` : ""}`;
}

/** The host's memory the circle may read, as the prompt lists it. */
export const visitMemory = (brief: VisitBrief): string | undefined =>
	brief.available && brief.memory ? `What you remember of ${brief.host}'s life (scopes ${(brief.scopes ?? []).join(", ")}). Find more with recall.${brief.memory.length ? `\n${brief.memory.map((m) => `- [${m.id}] (${m.scope}) ${m.title}`).join("\n")}` : "\nNothing is remembered yet."}` : undefined;
