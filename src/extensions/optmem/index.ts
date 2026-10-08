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
} from "@earendil-works/pi-durable";
import { text } from "../services";
import { type Block, blockName, cover, halves, parseBlock, RAW_MAX } from "./cover";
import { byteLength, ENTRY_BYTES, entryLine, OptMemStore } from "./store";

export { OptMemStore } from "./store";

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
 *   over it are dropped and rebuilt without it.
 */
export type OptMemOptions = {
	readonly sql: SqlStorage;
	/** IANA time zone memories are dated in. */
	readonly timeZone: string;
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
};

type NapCheckpoint =
	| { readonly phase: "next" }
	| { readonly phase: "summarize"; readonly lo: number; readonly hi: number; readonly attempt: number }
	| { readonly phase: "retry"; readonly lo: number; readonly hi: number; readonly attempt: number; readonly until: number };

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

export function createOptMem(options: OptMemOptions) {
	const store = new OptMemStore(options.sql);
	const viewLines = options.viewLines ?? DEFAULT_VIEW_LINES;
	const sinceLines = options.sinceLines ?? Math.max(4, Math.floor(viewLines / 8));

	/** The memory as the model sees it. */
	function view(): string[] {
		const total = store.count();
		if (total === 0) return [];
		const describe = (block: Block): string[] => {
			const [lo, hi] = block;
			if (hi - lo === 1) return [entryLine(store.entry(lo)!)];
			const summary = store.summary(block);
			// Not compressed yet: show its halves until the nap catches up.
			return summary === undefined ? halves(block).flatMap(describe) : [`#${blockName(block)} ${summary}`];
		};
		const lines = cover(total, viewLines).flatMap(describe);
		const limit = viewLines * 2;
		if (lines.length <= limit) return lines;
		return [
			"(Older memories are still being compressed; use recall or zoom for them.)",
			...lines.slice(lines.length - limit),
		];
	}

	/**
	 * The memory view's section text. Its first line records the memory count
	 * and forget epoch it was rendered at, which `plan` reads back.
	 */
	function renderView(): string {
		const total = store.count();
		const header = `<memory count="${total}" epoch="${store.epoch()}">`;
		const lines = view();
		const body =
			lines.length === 0
				? "You have no memories yet. Record the first with `note`."
				: `Your long-term memory, oldest first. Recent memories are verbatim; a line "#a-b" summarizes memories a through b, and zoom opens it. Later memories override earlier ones. Memories recorded after this view are in the conversation, or in <memory_since>.\n${lines.join("\n")}`;
		return `${header}\n${body}\n</memory>`;
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
	 * - a memory was forgotten since, which the old view may still show;
	 * - a whole view's worth of memories arrived since, as an upper bound;
	 * - too many memories from outside the conversation piled up in `since`.
	 * Memories the conversation noted itself are in its transcript already;
	 * the others are listed in the small `memory_since` section.
	 */
	function plan(input: PromptInput): { view: string; since: readonly string[] } {
		const conversation = String(input.conversationId);
		const shown = input.shown.memory;
		const match = shown === undefined ? null : /^<memory count="(\d+)" epoch="(\d+)">/.exec(shown);
		if (shown !== undefined && match && Number(match[2]) === store.epoch()) {
			const count = Number(match[1]);
			const since = store.since(count, conversation);
			if (store.count() - count < viewLines && since.length <= sinceLines) {
				return { view: shown, since: since.map(entryLine) };
			}
		}
		return { view: renderView(), since: [] };
	}

	const NapTask = defineTask<Record<string, never>, NapCheckpoint, Record<string, never>>({
		name: "optmem.nap",
		version: 1,
		initial: () => ({ phase: "next" }),
		phases: {
			next: async (_task, runtime, context) => {
				await runtime.commit(() => {
					// Read at commit time, so a memory noted while this task was finishing is not left behind.
					const [block] = store.pending(1);
					return block
						? { status: "running", checkpoint: { phase: "summarize", lo: block[0], hi: block[1], attempt: 0 } }
						: { status: "terminal", outcome: { status: "completed", result: {} } };
				}, context);
			},
			summarize: async (task, runtime, context) => {
				const { lo, hi, attempt } = task.state.checkpoint;
				const input = store.napInput([lo, hi], RAW_MAX);
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
								content: `Compress memories #${blockName([lo, hi])} into one line:\n${input.lines.join("\n")}`,
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
										checkpoint: { phase: "retry", lo, hi, attempt, until: Date.now() + 2 ** attempt * 2000 },
									}
								: { status: "terminal", outcome: { status: "failed", error: { message: error } } },
						context,
					);
					return;
				}
				// Stale lines (a memory was forgotten meanwhile) are discarded, and the block is picked again.
				store.putSummary(input.block, line, input.epoch);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "next" } }), context);
			},
			retry: async (task, runtime, context) => {
				const { lo, hi, attempt, until } = task.state.checkpoint;
				await runtime.sleep(until, context);
				await runtime.commit(
					() => ({ status: "running", checkpoint: { phase: "summarize", lo, hi, attempt: attempt + 1 } }),
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

	const note = defineTool({
		name: "note",
		description: `Record one memory: one line, at most ${ENTRY_BYTES} bytes. Call it whenever you learn something new or something worth keeping happens: a task worth real effort, a fact or insight the user teaches you, anything you learn about their life (even indirectly), any event of lasting effect. Do not record what your memory already holds.`,
		parameters: Type.Object({ text: Type.String({ minLength: 1 }) }),
		replay: "safe",
		async execute({ text: raw }, api, context) {
			const line = raw.trim();
			if (/[\r\n]/.test(line)) return text("A memory is one line: merge it, or note each part separately.", true);
			if (byteLength(line) > ENTRY_BYTES) {
				return text(`Too long: ${byteLength(line)} bytes, the limit is ${ENTRY_BYTES}. Compress it.`, true);
			}
			// The key is memoized, so a call replayed after an eviction saves the memory once.
			const key = await api.memo("note", crypto.randomUUID(), context);
			const entry = store.append(line, today(options.timeZone), { key, source: String(api.conversationId) });
			await startNap({
				getTask: (id) => api.getTask(id, context),
				createTask: () =>
					api.createTask(NapTask, {}, { ownership: { kind: "conversation" }, background: true }, context),
			});
			return text(`Saved as #${entry.id}.`);
		},
	});

	const recall = defineTool({
		name: "recall",
		description:
			"Search every memory ever recorded, word for word, with a case-insensitive regular expression. Returns the newest matches.",
		parameters: Type.Object({ pattern: Type.String({ minLength: 1 }) }),
		replay: "safe",
		async execute({ pattern }) {
			let regex: RegExp;
			try {
				regex = new RegExp(pattern, "i");
			} catch (error) {
				return text(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			const { matches, total } = store.search(regex, RECALL_LIMIT);
			if (total === 0) return text("No match.");
			const lines = matches.map(entryLine).reverse();
			const footer = total > matches.length ? `Newest ${matches.length} of ${total} matches. Narrow the pattern.` : `${total} matches.`;
			return text([...lines, footer].join("\n"));
		},
	});

	const zoom = defineTool({
		name: "zoom",
		description:
			'Open a memory summary into its two halves, given its block as shown in your memory, like "16-31". Repeat to reach the raw memories.',
		parameters: Type.Object({ block: Type.String() }),
		replay: "safe",
		async execute({ block: name }) {
			const block = parseBlock(name);
			if (!block) return text(`${name} is not a block. Use one shown in your memory, like 16-31.`, true);
			const total = store.count();
			if (block[0] >= total) return text(`#${name} is beyond your memory: it holds ${total} memories.`, true);
			const lines = halves(block)
				.filter(([lo]) => lo < total)
				.map((half) =>
					half[1] - half[0] === 1
						? entryLine(store.entry(half[0])!)
						: `#${blockName(half)} ${store.summary(half) ?? "(not compressed yet; zoom further)"}`,
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
			if (!store.forget(id)) return text(`There is no memory #${id}.`, true);
			await startNap({
				getTask: (task) => api.getTask(task, context),
				createTask: () =>
					api.createTask(NapTask, {}, { ownership: { kind: "conversation" }, background: true }, context),
			});
			return text(`Forgot #${id}.`);
		},
	});

	const extension = defineExtension({
		name: "optmem",
		tools: [note, recall, zoom, forget],
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

	return { store, extension, NapTask, view, startNap, today: () => today(options.timeZone) };
}

export type OptMem = ReturnType<typeof createOptMem>;
