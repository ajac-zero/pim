import type { Context } from "@earendil-works/chord";
import { type JsonValue, Type } from "@earendil-works/pi-ai";
import {
	defineExtension,
	defineTask,
	defineTool,
	type ModelRef,
	type PromptInput,
	section,
	type TaskId,
	type TaskRecord,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { definePimExtension } from "../define";
import { text } from "../services";
import { type Block, blockName, cover, halves, parseBlock, RAW_MAX } from "./cover";
import { byteLength, ENTRY_BYTES, entryLine, MAX_NAMED_SCOPES, MAX_SCOPE_NAME, OptMemStore, PRIVATE_SCOPE } from "./store";

export const CREATE_MEMORY_SCOPE = "create_memory_scope";

export { OptMemStore } from "./store";

/** A scope a conversation reads, and what its model is told about who else reads it. */
export type MemoryScope = { readonly key: string; readonly about: string };

/** What one conversation's memory is: the scopes it reads, in the order its view shows them, and where its notes go. */
export type MemoryAccess = {
	readonly read: readonly MemoryScope[];
	/** One of `read`: where `note` keeps a memory unless it names another. */
	readonly own: string;
};

/**
 * Long-term memory after Victor Taelin's OptMem: an append-only log of
 * one-line memories, summarized into a binary tree of one-line blocks, and
 * shown to the model as a fixed-size view where recent memories are verbatim
 * and older ones fade into coarser summaries.
 *
 * Differences from OptMem, for an agent hosted in a Durable Object:
 * - the view is a system prompt section, so every request has it;
 * - compression runs in a durable background task, not in the user's turn;
 * - forgetting is real: a memory's text is blanked and the summaries built
 *   over it are dropped and rebuilt without it;
 * - memories are kept in scopes, each with a log and tree of its own, and
 *   each conversation reads only the scopes its host gives it (`access`).
 */
export type OptMemOptions = {
	readonly sql: SqlStorage;
	/** IANA time zone memories are dated in; a function follows the person's setting as it changes. */
	readonly timeZone: string | (() => string);
	/** Lines in the memory view. Default 96 (about 8k tokens). */
	readonly viewLines?: number;
	/**
	 * Memories from outside a conversation listed in its `memory_since` section
	 * before its view is re-rendered instead. Default: an eighth of
	 * `viewLines`, at least 4.
	 */
	readonly sinceLines?: number;
	/** Model that writes summaries. Default: the model of the conversation that noted. */
	readonly compressionModel?: () => ModelRef | undefined;
	/** The scopes a conversation reads, and where its notes go. */
	readonly access: (conversation: string) => MemoryAccess;
};

type NapCheckpoint =
	| { readonly phase: "next" }
	| { readonly phase: "summarize"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number }
	| { readonly phase: "retry"; readonly scope?: string; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number };

/** Ways to reach the nap task, from a tool call or from the host. */
export type NapStarter = {
	getTask(id: TaskId): Promise<TaskRecord<JsonValue, JsonValue, unknown> | undefined>;
	createTask(): Promise<TaskId>;
};

const DEFAULT_VIEW_LINES = 96;
const MAX_ATTEMPTS = 4;
const RECALL_LIMIT = 50;

const NAP_SYSTEM = `You compress an agent's long-term memory about the person it works for.
Write ONE line of at most ${ENTRY_BYTES} bytes that summarizes the memories you are given.
Keep what has lasting effect: facts about the person and the people in their life, preferences, decisions, commitments, outcomes. Keep the names, dates and numbers that matter. Drop what does not last.
Invent nothing. Answer with the line only.`;

function today(timeZone: string): string {
	// en-CA formats as YYYY-MM-DD.
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
		new Date(),
	);
}

/** The first non-empty line of a model's answer, unquoted and clipped to the entry size. */
export function summaryLine(answer: string): string {
	const line = answer
		.split(/\r?\n/)
		.map((part) => part.trim())
		.find((part) => part !== "");
	if (!line) return "";
	const clean = line.replace(/^["'`]+|["'`]+$/g, "").trim();
	if (byteLength(clean) <= ENTRY_BYTES) return clean;
	// Clip by code points, so no character is cut in half, leaving room for the ellipsis.
	const chars = [...clean];
	while (byteLength(`${chars.join("")}…`) > ENTRY_BYTES) chars.pop();
	return `${chars.join("").trimEnd()}…`;
}

/**
 * How many of the view's lines each scope gets, given how many places each
 * has: an equal share, never more than a scope holds, and what a small scope
 * leaves goes to the others.
 */
export function shares(sizes: readonly number[], lines: number): number[] {
	const out = sizes.map(() => 0);
	let left = lines;
	const order = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
	for (const [n, { size, index }] of order.entries()) {
		out[index] = Math.min(size, Math.max(1, Math.floor(left / (order.length - n))));
		left -= out[index]!;
	}
	return out;
}

/** Parses a block as the model names it, `<scope>/a-b`, or returns undefined. */
export function parseScopedBlock(name: string): { scope: string; block: Block } | undefined {
	const match = /^#?([a-z0-9][a-z0-9_-]*)\/(\d+-\d+)$/.exec(name.trim());
	const block = match ? parseBlock(match[2]!) : undefined;
	return block ? { scope: match![1]!, block } : undefined;
}

export function createOptMem(options: OptMemOptions) {
	const store = new OptMemStore(options.sql);
	const viewLines = options.viewLines ?? DEFAULT_VIEW_LINES;
	const zone = () => (typeof options.timeZone === "function" ? options.timeZone() : options.timeZone);
	const sinceLines = options.sinceLines ?? Math.max(4, Math.floor(viewLines / 8));

	/** One scope's part of a view, in about `lines` lines: the past in summaries, the newest memories verbatim. */
	function scopeView(scope: string, lines: number): string[] {
		const size = store.size(scope);
		if (size === 0) return [];
		const describe = (block: Block): string[] => {
			const [lo, hi] = block;
			// A place a move emptied shows nothing: the memory is in the scope it went to.
			if (hi - lo === 1) return store.moved(scope, lo) ? [] : [entryLine(store.at(scope, lo)!)];
			const summary = store.summary(scope, block);
			// Not compressed yet: show its halves until the nap catches up.
			return summary === undefined ? halves(block).flatMap(describe) : [`#${scope}/${blockName(block)} ${summary}`];
		};
		const out = cover(size, lines).flatMap(describe);
		const limit = Math.max(2, lines * 2);
		if (out.length <= limit) return out;
		return ["(Older memories are still being compressed; use recall or zoom for them.)", ...out.slice(out.length - limit)];
	}

	/** The memory as the model sees it: each scope, under a line saying who reads it, sharing `viewLines` lines. */
	function view(scopes: readonly MemoryScope[]): string[] {
		const budget = shares(
			scopes.map((scope) => store.size(scope.key)),
			viewLines,
		);
		return scopes.flatMap((scope, index) => {
			const lines = scopeView(scope.key, budget[index]!);
			return [`Scope ${scope.key}, ${scope.about}:`, ...(lines.length === 0 ? ["(nothing yet)"] : lines)];
		});
	}

	/**
	 * The memory view's section text. Its first line records the scopes it
	 * shows, with how many places each had, and the forget epoch it was
	 * rendered at, which `plan` reads back.
	 */
	function renderView(access: MemoryAccess): string {
		const sizes = access.read.map((scope) => `${scope.key}:${store.size(scope.key)}`).join(" ");
		const header = `<memory scopes="${sizes}" epoch="${store.epoch()}">`;
		const about = `Your long-term memory, oldest first, kept in scopes that different agents read. Recent memories are verbatim; a line "#<scope>/a-b" summarizes memories a through b of that scope, and zoom opens it. Later memories override earlier ones. Memories recorded after this view are in the conversation, or in <memory_since>. \`note\` keeps a memory in your own scope, ${access.own}, unless you name another scope listed here: keep in a wider scope only what every agent that reads it should know.`;
		return `${header}\n${about}\n${view(access.read).join("\n")}\n</memory>`;
	}

	/**
	 * What the two memory sections show in one request.
	 *
	 * pi keeps prompt caches warm by never editing what it sent: a changed
	 * section is appended to the transcript as a whole new copy, and old copies
	 * stay until a compaction writes a fresh baseline. So the view a
	 * conversation was shown is kept, and re-rendered only when
	 * - it has none: a new conversation, or its copy was compacted away, where
	 *   pi writes every section again anyway;
	 * - a memory was forgotten or moved since, which the old view may still show;
	 * - the conversation reads other scopes now;
	 * - a whole view's worth of memories arrived since, as an upper bound;
	 * - too many memories from outside the conversation piled up in `since`.
	 * Memories the conversation noted itself are in its transcript already;
	 * the others are listed in the small `memory_since` section.
	 */
	function plan(input: PromptInput): { view: string; since: readonly string[] } {
		const conversation = String(input.conversationId);
		const access = options.access(conversation);
		const shown = input.shown.memory;
		const match = shown === undefined ? null : /^<memory scopes="([^"]*)" epoch="(\d+)">/.exec(shown);
		if (shown !== undefined && match && Number(match[2]) === store.epoch()) {
			const from = new Map(
				match[1]!
					.split(" ")
					.filter((part) => part !== "")
					.map((part) => [part.slice(0, part.lastIndexOf(":")), Number(part.slice(part.lastIndexOf(":") + 1))] as const),
			);
			if (from.size === access.read.length && access.read.every((scope) => from.has(scope.key))) {
				const since = store.since(from, conversation);
				const grown = access.read.reduce((sum, scope) => sum + store.size(scope.key) - from.get(scope.key)!, 0);
				if (grown < viewLines && since.length <= sinceLines) return { view: shown, since: since.map(entryLine) };
			}
		}
		return { view: renderView(access), since: [] };
	}

	const NapTask = defineTask<Record<string, never>, NapCheckpoint, Record<string, never>>({
		name: "optmem.nap",
		version: 1,
		initial: () => ({ phase: "next" }),
		phases: {
			next: async (_task, runtime, context) => {
				await runtime.commit(() => {
					// Read at commit time, so a memory noted while this task was finishing is not left behind.
					const [next] = store.pending(1);
					return next
						? { status: "running", checkpoint: { phase: "summarize", scope: next.scope, lo: next.block[0], hi: next.block[1], attempt: 0 } }
						: { status: "terminal", outcome: { status: "completed", result: {} } };
				}, context);
			},
			summarize: async (task, runtime, context) => {
				// Checkpoints from before scopes were all of the one scope memories had then.
				const { scope = PRIVATE_SCOPE, lo, hi, attempt } = task.state.checkpoint;
				const input = store.napInput(scope, [lo, hi], RAW_MAX);
				if (!input) {
					// Built meanwhile, or it waits on a half: pick again.
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
					return;
				}
				const ref = options.compressionModel?.() ?? (await runtime.agent(context)).model;
				const model = ref === undefined ? undefined : runtime.models.getModel(ref.provider, ref.modelId);
				if (model === undefined) {
					const message = ref === undefined ? "No model is configured" : `Model ${ref.provider}/${ref.modelId} is not available`;
					await runtime.commit(
						() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }),
						context,
					);
					return;
				}
				const answer = await runtime.models.completeSimple(
					model,
					{
						systemPrompt: NAP_SYSTEM,
						messages: [
							{
								role: "user",
								content: `Compress memories #${blockName([lo, hi])} of the scope ${scope} into one line:\n${input.lines.join("\n")}`,
								timestamp: Date.now(),
							},
						],
					},
					{ signal: runtime.signal },
				);
				runtime.signal.throwIfAborted();
				const line = summaryLine(
					answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
				);
				if (answer.stopReason === "error" || line === "") {
					const error = answer.errorMessage ?? "The model returned no summary";
					await runtime.commit(
						() =>
							attempt + 1 < MAX_ATTEMPTS
								? {
										status: "running",
										checkpoint: { phase: "retry", scope, lo, hi, attempt, until: Date.now() + 2 ** attempt * 2000 },
									}
								: { status: "terminal", outcome: { status: "failed", error: { message: error } } },
						context,
					);
					return;
				}
				// Stale lines (a memory was forgotten or moved meanwhile) are discarded, and the block is picked again.
				store.putSummary(scope, input.block, line, input.epoch);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
			retry: async (task, runtime, context) => {
				const { scope, lo, hi, attempt, until } = task.state.checkpoint;
				await runtime.sleep(until, context);
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "summarize", scope, lo, hi, attempt: attempt + 1 } }),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
		},
	});

	/**
	 * Starts the nap task when there is compression to do and none is running.
	 * Returns the id of a task it created.
	 */
	async function startNap(starter: NapStarter): Promise<TaskId | undefined> {
		if (store.pending(1).length === 0) return undefined;
		const known = store.meta("nap_task");
		if (known !== undefined) {
			const record = await starter.getTask(Number(known) as TaskId);
			if (record && record.state.status !== "terminal") return undefined;
		}
		const id = await starter.createTask();
		store.setMeta("nap_task", String(id));
		return id;
	}

	/** Starts the nap task from a tool call. */
	const napFrom = (api: ToolExecutionApi, context: Context) =>
		startNap({
			getTask: (id) => api.getTask(id, context),
			createTask: () => api.createTask(NapTask, {}, { ownership: { kind: "conversation" }, background: true }, context),
		});

	/** The keys of the scopes a conversation reads. */
	const readable = (conversation: unknown) => options.access(String(conversation)).read.map((scope) => scope.key);

	const note = defineTool({
		name: "note",
		description: `Record one memory: one line, at most ${ENTRY_BYTES} bytes. Call it whenever you learn something new or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), any event of lasting effect. Do not record what your memory already holds.`,
		parameters: Type.Object({
			text: Type.String({ minLength: 1 }),
			scope: Type.Optional(Type.String({ description: "The scope to keep it in, one your memory lists. Left out, your own." })),
		}),
		replay: "safe",
		async execute({ text: raw, scope: chosen }, api, context) {
			const line = raw.trim();
			if (/[\r\n]/.test(line)) return text("A memory is one line: merge it, or note each part separately.", true);
			if (byteLength(line) > ENTRY_BYTES) {
				return text(`Too long: ${byteLength(line)} bytes, the limit is ${ENTRY_BYTES}. Compress it.`, true);
			}
			const access = options.access(String(api.conversationId));
			const scope = chosen ?? access.own;
			if (!access.read.some((candidate) => candidate.key === scope)) {
				return text(`You can't keep memories in ${scope}: use one of ${access.read.map((candidate) => candidate.key).join(", ")}.`, true);
			}
			// The key is memoized, so a call replayed after an eviction saves the memory once.
			const key = await api.memo("note", crypto.randomUUID(), context);
			const entry = store.append(line, today(zone()), { key, source: String(api.conversationId), scope });
			await napFrom(api, context);
			return text(`Saved as #${entry.id} in ${scope}.`);
		},
	});

	/** `recall`'s answer: the newest memories in the given scopes matching a case-insensitive regular expression. */
	function search(pattern: string, scopes: readonly string[]): { text: string; isError: boolean } {
		let regex: RegExp;
		try {
			regex = new RegExp(pattern, "i");
		} catch (error) {
			return { text: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`, isError: true };
		}
		const { matches, total } = store.search(regex, RECALL_LIMIT, scopes);
		if (total === 0) return { text: "No match.", isError: false };
		const lines = matches.map(entryLine).reverse();
		const footer = total > matches.length ? `Newest ${matches.length} of ${total} matches. Narrow the pattern.` : `${total} matches.`;
		return { text: [...lines, footer].join("\n"), isError: false };
	}

	const recall = defineTool({
		name: "recall",
		description:
			"Search every memory ever recorded in the scopes you read, word for word, with a case-insensitive regular expression. Returns the newest matches.",
		parameters: Type.Object({ pattern: Type.String({ minLength: 1 }) }),
		replay: "safe",
		async execute({ pattern }, api) {
			const found = search(pattern, readable(api.conversationId));
			return text(found.text, found.isError);
		},
	});

	const zoom = defineTool({
		name: "zoom",
		description:
			'Open a memory summary into its two halves, given its block as shown in your memory, like "private/16-31". Repeat to reach the raw memories.',
		parameters: Type.Object({ block: Type.String() }),
		replay: "safe",
		async execute({ block: name }, api) {
			const found = parseScopedBlock(name);
			if (!found) return text(`${name} is not a block. Use one shown in your memory, like private/16-31.`, true);
			const { scope, block } = found;
			if (!readable(api.conversationId).includes(scope)) return text(`You don't read the scope ${scope}.`, true);
			const size = store.size(scope);
			if (block[0] >= size) return text(`#${name} is beyond that scope: it holds ${size} memories.`, true);
			const lines = halves(block)
				.filter(([lo]) => lo < size)
				.map((half) =>
					half[1] - half[0] === 1
						? entryLine(store.at(scope, half[0])!)
						: `#${scope}/${blockName(half)} ${store.summary(scope, half) ?? "(not compressed yet; zoom further)"}`,
				);
			return text(lines.join("\n"));
		},
	});

	const forget = defineTool({
		name: "forget",
		description:
			"Forget one memory for good, by its number. When the user asks you to forget something, recall every memory that holds it and forget each one. Summaries built over a forgotten memory are rebuilt without it.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
		replay: "safe",
		async execute({ id }, api, context) {
			const entry = store.entry(id);
			if (!entry || !readable(api.conversationId).includes(entry.scope)) return text(`There is no memory #${id}.`, true);
			store.forget(id);
			await napFrom(api, context);
			return text(`Forgot #${id}.`);
		},
	});

	const move = defineTool({
		name: "move_memory",
		description:
			"Move one memory, by its number, to another scope your memory lists, so the agents that read that scope know it, and those that read only its old scope don't. It gets a new number there.",
		parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), scope: Type.String() }),
		replay: "safe",
		async execute({ id, scope }, api, context) {
			// The key is memoized, so a call replayed after an eviction finds the move it made.
			const key = await api.memo("move", crypto.randomUUID(), context);
			const done = store.keyed(key);
			if (done) return text(`Moved #${id} to ${done.scope}, as #${done.id}.`);
			const scopes = readable(api.conversationId);
			const entry = store.entry(id);
			if (!entry || !scopes.includes(entry.scope)) return text(`There is no memory #${id}.`, true);
			if (entry.forgotten) return text(`#${id} was forgotten.`, true);
			if (!scopes.includes(scope)) return text(`You can't keep memories in ${scope}: use one of ${scopes.join(", ")}.`, true);
			if (scope === entry.scope) return text(`#${id} is in ${scope} already.`);
			const moved = store.move(id, scope, { key, source: String(api.conversationId) });
			await napFrom(api, context);
			return text(`Moved #${id} to ${scope}, as #${moved.id}.`);
		},
	});

	const createScope = defineTool({
		name: CREATE_MEMORY_SCOPE,
		description:
			"Name a new memory scope, such as Health, to keep memories that only the agents the person chooses should read. At first only you read it; keep memories in it with `note` or `move_memory`. A scope of that name already there is returned instead.",
		parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: MAX_SCOPE_NAME, pattern: "\\S" }) }),
		replay: "safe",
		async execute({ name: raw }) {
			const name = raw.trim();
			const known = store.namedScopes().find((scope) => scope.name.toLowerCase() === name.toLowerCase());
			if (known) return text(`The scope "${known.name}" is there already, as ${known.key}.`);
			if (store.namedScopes().length >= MAX_NAMED_SCOPES) return text(`The person has the most named scopes there can be, ${MAX_NAMED_SCOPES}: use one of them.`, true);
			const scope = store.createScope(name);
			return text(`Made the scope "${scope.name}", as ${scope.key}. Only you read it until it is shared.`);
		},
	});

	const extension = defineExtension({
		name: "optmem",
		tools: [note, recall, zoom, forget, move, createScope],
		tasks: [NapTask],
		sections: [
			section("memory", (input) => plan(input).view, { tag: false }),
			// Last, so it can appear and disappear without reordering the shown sections.
			section("memory_since", (input) => {
				const { since } = plan(input);
				return since.length === 0 ? undefined : ["Memories recorded elsewhere since your memory view:", ...since].join("\n");
			}),
		],
	});

	return { store, extension, NapTask, view, search, startNap, today: () => today(zone()) };
}

export type OptMem = ReturnType<typeof createOptMem>;

/** On a dashboard: the newest memories its agent reads. */
export function memoryWidgets(store: OptMemStore, scopesOf: (agent: string) => readonly string[]) {
	return definePimExtension({
		id: "pim.memory",
		name: "Memory",
		description: "What Pim remembers about you, in every chat.",
		widgets: {
			recent: {
				title: { en: "Remembered lately", es: "Recordado últimamente" },
				description: "The five newest memories.",
				empty: { en: "Nothing remembered yet. Tell your agents about yourself.", es: "Aún no recuerda nada. Cuéntales a tus agentes sobre ti." },
				load: (context) => ({
					kind: "list",
					// Forgotten ones keep their place in the log, empty: skip them.
					items: store
						.page(25, undefined, scopesOf(context.agent.id))
						.filter((entry) => !entry.forgotten)
						.slice(0, 5)
						.map((entry) => ({ title: entry.text, detail: entry.date })),
				}),
			},
		},
	});
}
