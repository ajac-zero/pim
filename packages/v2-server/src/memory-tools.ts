/**
 * The memory tools with v1's rules (`src/extensions/optmem/index.ts`): an agent keeps, finds, reads, forgets and moves memories only in the scopes it reads, a memory's title is one
 * line of at most 280 bytes, recall says when it shows only the newest matches, and the majordomo names the person's shared scopes and, once the person approves, lets other agents read
 * them. Where the scopes are kept is `Memories` and `Agents.memoryOf` in `@pim/v2-app`.
 */
import { Type } from "typebox";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { App } from "@pim/v2-app/app";
import type { Principal } from "@pim/v2-contracts/identity";
import type { Db as RuntimeDb } from "@pim/v2-runtime/db";
import { rosterOf } from "./agent-team-tools.ts";
import { askFirst } from "./tool-approval.ts";

type Result = { output: { type: "text"; text: string }[]; isError?: boolean };
type Call = { chat: string | null; p: Principal; api: any; agentId: string | null; context: any };
type Define = (name: string, description: string, parameters: any, run: (app: App, call: Call, args: any) => Promise<Result>) => ToolRegistration;

const text = (s: string, isError = false): Result => ({ output: [{ type: "text", text: s }], ...(isError ? { isError } : {}) });

/** The longest one memory's title may be, in UTF-8 bytes, as in v1; the body is what a memory says in full, which `zoom` reads. */
export const TITLE_BYTES = 280;
export const BODY_CHARS = 10_000;
export const MAX_RECALLED = 50;
const MAX_SCOPE_NAME = 40;

export function memoryTools(deps: { ownerId: string; runtime: RuntimeDb; read: Define; write: Define }): ToolRegistration[] {
	const { ownerId, runtime, read, write } = deps;
	const S = Type.String;
	const O = Type.Optional;
	/** The scope an agent writes to by default, and the scopes it reads. */
	const access = (app: App, call: Call) => app.agents.memoryOf(call.p, call.agentId);
	const outside = (scope: string, reads: string[]) => text(`You can't keep memories in ${scope}: use one of ${reads.join(", ")}.`, true);
	/** Only the person's majordomo names scopes and shares them: it is the agent that reads every scope. */
	const majordomoOnly = async (call: Call) => ((await rosterOf(runtime, ownerId, call.chat)).majordomo ? undefined : text("Only the person's majordomo does that.", true));

	return [
		write("note", `Record one memory: a title of one line, at most ${TITLE_BYTES} bytes, and the text. Call it whenever you learn something new or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), any event of lasting effect. Do not record what your memory already holds. It goes to your own memory unless you give a scope your memory lists, such as everyone.`, Type.Object({ title: S({ minLength: 1 }), body: S({ minLength: 1, maxLength: BODY_CHARS }), scope: O(S({ description: "The scope to keep it in, one your memory lists. Left out, your own." })) }), async (app, call, a) => {
			const title = String(a.title).trim();
			if (!title) return text("A memory needs a title.", true);
			if (/[\r\n]/.test(title)) return text("A memory's title is one line: merge it, or note each part separately.", true);
			const size = Buffer.byteLength(title);
			if (size > TITLE_BYTES) return text(`Too long: the title is ${size} bytes, the limit is ${TITLE_BYTES}. Compress it, and put the rest in the text.`, true);
			const { own, reads } = await access(app, call);
			const scope = a.scope ?? own;
			if (!reads.includes(scope)) return outside(scope, reads);
			return text(`Saved as ${await app.memories.remember(call.p, scope, title, a.body)} in ${scope}.`);
		}),
		read("recall", "Search every memory ever recorded in the scopes you read, word for word, with a case-insensitive regular expression over titles and text. Returns the newest matches.", Type.Object({ pattern: S({ minLength: 1 }), scope: O(S()), limit: O(Type.Integer({ minimum: 1, maximum: MAX_RECALLED })) }), async (app, call, a) => {
			// In a visit to someone's space, what is recalled is the host's, in the scopes their circle may read: never the visitor's own memory.
			const visit = call.chat ? (await runtime.read<{ r: { matches: { id: string; scope: string; title: string }[]; total: number } | null }>(ownerId, "SELECT pim_app.runner_visit_recall($1, $2, $3, $4) AS r", [ownerId, call.chat, String(a.pattern), a.limit ?? 20]).catch((error) => { throw new Error(/regular expression/i.test(String(error)) ? `Invalid pattern: ${String(error)}` : String(error)); })).rows[0]?.r : null;
			if (visit) return visit.total === 0 ? text("No match.") : text(`${visit.matches.map((m) => `[${m.id}] (${m.scope}) ${m.title}`).join("\n")}\n${visit.total > visit.matches.length ? `Newest ${visit.matches.length} of ${visit.total} matches. Narrow the pattern.` : `${visit.total} matches.`}`);
			const { reads } = await access(app, call);
			if (a.scope && !reads.includes(a.scope)) return text(`You don't read the scope ${a.scope}.`, true);
			const { matches, total } = await app.memories.search(call.p, a.scope ? [a.scope] : reads, a.pattern, a.limit ?? 20);
			if (total === 0) return text("No match.");
			return text(`${matches.map((m) => `[${m.id}] (${m.scope}) ${m.title}`).join("\n")}\n${total > matches.length ? `Newest ${matches.length} of ${total} matches. Narrow the pattern.` : `${total} matches.`}`);
		}),
		read("zoom", "Read a memory in full, or a block of its lines.", Type.Object({ id: S(), start: O(Type.Integer({ minimum: 1 })), count: O(Type.Integer({ minimum: 1, maximum: 400 })) }), async (app, call, a) => {
			const z = await app.memories.zoom(call.p, a.id, a.start ?? 1, a.count ?? 40, (await access(app, call)).reads).catch((error) => {
				if ((error as { status?: number }).status === 404) return undefined;
				throw error;
			});
			return z ? text(`${z.lines.join("\n")}\n(${z.total} lines in all)`) : text(`There is no memory ${a.id}.`, true);
		}),
		write("forget", "Forget one memory for good, by its id. When the user asks you to forget something, recall every memory that holds it and forget each one.", Type.Object({ id: S() }), async (app, call, a) => {
			const done = await app.memories.forget(call.p, a.id, (await access(app, call)).reads).then(() => true, (error) => {
				if ((error as { status?: number }).status === 404) return false;
				throw error;
			});
			return done ? text(`Forgot ${a.id}.`) : text(`There is no memory ${a.id}.`, true);
		}),
		write("move_memory", "Move one memory, by its id, to another scope your memory lists, so the agents that read that scope know it, and those that read only its old scope don't.", Type.Object({ id: S(), scope: S() }), async (app, call, a) => {
			const { reads } = await access(app, call);
			if (!reads.includes(a.scope)) return outside(a.scope, reads);
			const done = await app.memories.move(call.p, a.id, a.scope, reads).then(() => true, (error) => {
				if ((error as { status?: number }).status === 404) return false;
				throw error;
			});
			return done ? text(`Moved ${a.id} to ${a.scope}.`) : text(`There is no memory ${a.id}.`, true);
		}),
		write("create_memory_scope", "Name a new memory scope, such as Health, to keep memories that only the agents the person chooses should read. It returns the scope's key; at first only you read it. Keep memories in it with `note` or `move_memory`, and let an agent that needs it read it with share_memory_scope. A scope of that name already there is returned instead.", Type.Object({ name: S({ minLength: 1, maxLength: MAX_SCOPE_NAME, pattern: "\\S" }) }), async (app, call, a) => {
			const refused = await majordomoOnly(call);
			if (refused) return refused;
			const name = String(a.name).trim();
			const known = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT key, name FROM pim_app.memory_scopes WHERE lower(name) = lower($1)", [name])).rows[0])) as { key: string; name: string } | undefined;
			if (known) return text(`The scope "${known.name}" is there already, as ${known.key}.`);
			return text(`Made the scope "${name}", as ${await app.memories.createScope(call.p, name)}. Only you read it until it is shared.`);
		}),
		// Parked for the person's approval, and run again when they decide, so a tool that may be run again.
		read("share_memory_scope", "Let another of the person's agents read one of their named memory scopes, by its key, or with stop no longer read it, when the agent needs what it holds for its work or the person asks. Use the agent's id from your_agents. The person is asked first. An agent always reads its own scope and everyone.", Type.Object({ scope: S({ description: "A named scope's key, as create_memory_scope gave it." }), agent: S({ description: "The agent's id from your_agents." }), stop: O(Type.Boolean({ description: "True to stop it reading the scope." })) }), async (app, call, a) => {
			const refused = await majordomoOnly(call);
			if (refused) return refused;
			const scope = (await app.db.owner(ownerId, async (tx) => (await tx.query("SELECT key, name FROM pim_app.memory_scopes WHERE key = $1", [a.scope])).rows[0])) as { key: string; name: string } | undefined;
			if (!scope) return text(`There is no named memory scope ${a.scope}: only a scope the person or you named can be shared.`, true);
			const target = await app.agents.get(call.p, a.agent).catch(() => undefined);
			if (!target) return text("That agent no longer exists.", true);
			if (target.id === (await rosterOf(runtime, ownerId, call.chat)).self) return text("You read every scope already.", true);
			const who = JSON.stringify(target.name);
			const waiting = await askFirst({ app, runtime, ownerId }, call, { action: "memory:share", resource: { scope: scope.key, agent: target.id }, summary: a.stop ? `Stop ${who} reading the memory scope ${JSON.stringify(scope.name)}` : `Let ${who} read the memory scope ${JSON.stringify(scope.name)}`, args: { scope: scope.key, agent: target.id, ...(a.stop ? { stop: true } : {}) }, denied: "The person did not approve that, so nothing changed." });
			if (waiting) return waiting;
			const kept = target.memoryScopes.filter((k) => k !== scope.key);
			await app.agents.update(call.p, target.id, { memoryScopes: a.stop ? kept : [...kept, scope.key] });
			return text(a.stop ? `${target.name} no longer reads "${scope.name}".` : `${target.name} reads "${scope.name}" from its next step.`);
		}),
	];
}
