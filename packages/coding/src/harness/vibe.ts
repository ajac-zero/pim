import type { AssistantMessage, JsonObject, TextContent, ThinkingContent, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { HARNESS_HOME } from "../vault/inject";
import type { CliHarness, HarnessEvent, HarnessFiles, HarnessParser, HarnessTurn, HarnessUsage } from "./types";

/**
 * Mistral Vibe (`mistral-vibe`): Mistral's `vibe` CLI, unmodified, run
 * headless with `--output streaming`, which prints each entry of the
 * session's history as it is completed, one JSON object a line. It signs in
 * with the person's own Mistral API key, which the runner puts in
 * `MISTRAL_API_KEY` (./auth.ts). What a run cost, and its tokens, Vibe
 * writes only to `export.json` in its `--output-dir`, which the parser reads
 * once the CLI has exited (`finish`).
 *
 * The repository is untrusted. Vibe loads a project's `.vibe/` config (its
 * MCP servers, hooks, agents, skills and prompts), its `.agents/` skills and
 * its AGENTS.md only for a trusted folder, and a headless run trusts none it
 * isn't told to (`--trust`), so the checkout is never trusted. What the
 * agent could leave outside the checkout for a later turn is kept out too:
 * every run gets a new `VIBE_HOME`, holding only Pim's instructions, and
 * MCP servers, Mistral's connectors, subagents and skills of the person's
 * own are off, by environment variables that override any config file.
 * Sessions are kept apart from that home (`session_logging.save_dir`), so
 * a later turn resumes them.
 *
 * Permissions: the workspace is a gVisor sandbox of the thread's own, with
 * an egress allowlist and no credential but the API key, and the work is
 * reviewed as a diff before anything is pushed. So every tool call is
 * approved (`--auto-approve`), as Claude Code's and Codex's are; without
 * it, a headless run denies every call that would ask, since nobody can.
 *
 * Checked against Vibe 3.1.0 (../../../docs/coding-vibe.md).
 */

/** Where the repository is checked out, which Vibe works in. */
const REPO = `${HARNESS_HOME}/repo`;

/** Where Vibe keeps its sessions across turns: its home is new each run. */
export const VIBE_SESSIONS = `${HARNESS_HOME}/.vibe-sessions`;

/**
 * A turn's own directory: Vibe's home for the run (`home/`), the prompt, and
 * the output directory (`out/`). Named by the turn's session, so the
 * turn's process is found by it (`signalCommand`).
 */
export const vibeRunDir = (sessionId: string) => `${HARNESS_HOME}/.pim-vibe/${sessionId.replace(/[^\w-]/g, "_")}`;

/**
 * Makes the run's directory anew and starts Vibe in it: `$1` is the
 * directory, `$2` Pim's instructions, which go in the new home's AGENTS.md
 * (Vibe's "user-level instructions", added to its own system prompt), and
 * `$3` the prompt, read from a file so no prompt is ever read as a flag.
 * `exec`, so the process signalled is Vibe's own.
 */
const START = 'd=$1 && rm -rf "$d" && mkdir -p "$d/home" && printf \'%s\\n\' "$2" > "$d/home/AGENTS.md" && printf \'%s\' "$3" > "$d/prompt.md" && shift 3 && VIBE_HOME="$d/home" exec "$@"';

/** What Vibe is told besides Pim's instructions: the checkout isn't trusted, so it hasn't read the repository's AGENTS.md itself. */
const UNTRUSTED =
	"The repository's own AGENTS.md files and .vibe/ configuration aren't loaded for you, since the checkout isn't trusted. Read the AGENTS.md files that apply to your work before you change anything.";

/** The CLI's flags that are the same every turn: streaming JSON, and every tool call approved. */
export const VIBE_FLAGS: readonly string[] = ["--output", "streaming", "--auto-approve"];

export const mistralVibe: CliHarness = {
	id: "mistral-vibe",
	name: "Mistral Vibe",
	buildCommand(turn: HarnessTurn): string[] {
		const dir = vibeRunDir(turn.sessionId);
		return [
			"/bin/sh",
			"-c",
			START,
			"vibe",
			dir,
			`${turn.instructions}\n\n${UNTRUSTED}`,
			turn.prompt,
			"vibe",
			...VIBE_FLAGS,
			"--workdir",
			REPO,
			"--output-dir",
			`${dir}/out`,
			// Vibe refuses `--model` on a resumed session, which keeps the model it started with.
			...(turn.resume ? ["--resume", turn.sessionId] : turn.model ? ["--model", turn.model] : []),
			...(turn.maxBudgetUsd === null ? [] : ["--max-price", (Math.floor(Math.max(0, turn.maxBudgetUsd) * 100) / 100).toFixed(2)]),
			"--prompt-file",
			`${dir}/prompt.md`,
		];
	},
	parser: (turn) => new VibeStreamParser(turn),
	reportsCost: true,
	shellTool: "file_system.bash",
	// Only what a run needs: the model's API. These override any config file, the person's or one the agent wrote.
	env: {
		VIBE_SESSION_LOGGING__SAVE_DIR: VIBE_SESSIONS,
		VIBE_ENABLE_MCP: "false",
		VIBE_ENABLE_CONNECTORS: "false",
		VIBE_ENABLE_SUBAGENTS: "false",
		VIBE_DISABLED_SKILLS: '["*"]',
		VIBE_ENABLE_TELEMETRY: "false",
		VIBE_EXPERIMENTS__ENABLE: "false",
		VIBE_ENABLE_UPDATE_CHECKS: "false",
		VIBE_ENABLE_AUTO_UPDATE: "false",
		VIBE_SHOW_GREETING: "false",
		VIBE_ENABLE_NOTIFICATIONS: "false",
	},
	// The model's API. Vibe also asks chat.mistral.ai for an organization's managed config, which the allowlist refuses; it goes on without.
	egress: ["api.mistral.ai"],
	// Each run's output directory is on Vibe's command line, named by the session the turn started with.
	signalCommand: (sessionId, signal) => ["pkill", `-${signal}`, "-f", `${vibeRunDir(sessionId)}/out`],
	apiKeyEnv: "MISTRAL_API_KEY",
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown) => (typeof value === "string" ? value : null);

/** The effect states a tool call ends in; its call and result are written once it is in one. */
const SETTLED = ["completed", "failed", "cancelled", "skipped"];

/** Approval answers that refused a tool call. */
const REFUSED = ["deny", "cancel_turn"];

/** What a run that couldn't reach the model for its key says, with `config_error`: a key Mistral refused, or none. */
const KEY_FAILURE = /invalid api key|missing mistral_api_key/i;

/**
 * Reads Vibe's `--output streaming`, one history entry a line: `message`
 * (the person's and the assistant's), `reasoning`, `effect` (a tool call,
 * printed once it settled, with its result), `callback` (an approval Vibe
 * asked for, which a headless run answers itself) and `notice`. Each entry
 * carries the session's id. Vibe prints entries whole, not as they are
 * written, so there are no deltas. Entries of any other type are skipped;
 * a line that isn't JSON is `unparsed`.
 *
 * The run's end, its cost and its tokens come from `export.json`
 * (`finish`): they count that run only, so they are added to what the
 * session cost and used before (`sessionBefore`).
 */
export class VibeStreamParser implements HarnessParser {
	readonly #turn: Pick<HarnessTurn, "sessionId" | "model" | "sessionBefore">;
	readonly #model: string;
	#sessionId: string | null = null;
	/** Effects already written, so one printed again isn't written twice. */
	readonly #settled = new Set<string>();

	/** Reads the output of `turn`: the model it asked for, the run's directory, and the session's totals before it. */
	constructor(turn: Pick<HarnessTurn, "sessionId" | "model" | "sessionBefore">) {
		this.#turn = turn;
		this.#model = turn.model ?? "mistral-vibe";
	}

	parseLine(line: string): HarnessEvent[] {
		const text = line.trim();
		if (!text) return [];
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return [{ type: "unparsed", line: text.slice(0, 500) }];
		}
		if (!isObject(value) || typeof value.type !== "string") return [{ type: "unparsed", line: text.slice(0, 500) }];
		const events: HarnessEvent[] = [];
		const sessionId = str(value.sessionId);
		if (sessionId && sessionId !== this.#sessionId) {
			this.#sessionId = sessionId;
			events.push({ type: "session", sessionId, model: null });
		}
		// An entry still being written is printed again once it is complete.
		if (value.generationStatus === "in_progress") return events;
		const id = str(value.id) ?? "";
		switch (value.type) {
			case "message": {
				const discarded = isObject(value.outcome) && value.outcome.type === "discarded";
				if (value.role !== "assistant" || discarded) return events;
				const said = (Array.isArray(value.content) ? value.content : []).flatMap((block) => (isObject(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("\n\n");
				return said ? [...events, this.#assistant(id, [{ type: "text", text: said }])] : events;
			}
			case "reasoning": {
				const thinking = str(value.text);
				return thinking ? [...events, this.#assistant(id, [{ type: "thinking", thinking }])] : events;
			}
			case "effect":
				return [...events, ...this.#effect(id, value)];
			case "callback":
				return [...events, ...this.#callback(value)];
			case "notice": {
				const message = str(value.message);
				return message ? [...events, { type: "notice", message }] : events;
			}
			default:
				return events;
		}
	}

	/** A tool call and its result, once it settled: completed, failed (as when refused), cancelled (as when the run stopped) or skipped. */
	#effect(id: string, value: Json): HarnessEvent[] {
		const detail = isObject(value.detail) ? value.detail : {};
		const state = isObject(value.state) ? value.state : {};
		const status = str(state.status);
		if (!status || !SETTLED.includes(status) || this.#settled.has(id)) return [];
		this.#settled.add(id);
		const name = str(detail.toolName) ?? str(value.title) ?? "tool";
		const input = detail.input === undefined || detail.input === null ? {} : detail.input;
		const call: ToolCall = { type: "toolCall", id, name, arguments: (isObject(input) ? input : { input }) as JsonObject };
		const display = isObject(state.display) ? state.display : {};
		const error = isObject(state.error) ? str(state.error.message) : null;
		const output = str(state.outputText) ?? "";
		// A tool that prints nothing, such as a file written, says what it did.
		const done = [str(display.verb), str(display.message)].filter(Boolean).join(" ");
		const said = status === "completed" ? output || done : status === "failed" ? [output, error].filter(Boolean).join("\n") || done : str(state.reason) || status;
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: said }],
			isError: status !== "completed" || display.success === false,
			timestamp: Date.now(),
		};
		// Vibe says whether a command succeeded, not its exit code.
		return [this.#assistant(id, [call]), { type: "tool_result", message: result }];
	}

	/** An approval Vibe answered with a refusal; a question it asked, which nobody answers. */
	#callback(value: Json): HarnessEvent[] {
		const detail = isObject(value.detail) ? value.detail : {};
		const state = isObject(value.state) ? value.state : {};
		if (detail.kind !== "approval") return detail.kind === "user_input" ? [{ type: "notice", message: str(value.title) ?? "Vibe asked a question" }] : [];
		const output = isObject(state.output) ? state.output : {};
		const decision = isObject(output.decision) ? str(output.decision.type) : null;
		if (state.status !== "answered" || !decision || !REFUSED.includes(decision)) return [];
		const effect = isObject(detail.effect) ? detail.effect : {};
		const display = isObject(effect.display) ? effect.display : {};
		return [{ type: "permission_denied", tool: str(effect.toolName) ?? "tool", message: str(display.summary) ?? str(value.title) ?? "" }];
	}

	#assistant(id: string, content: (TextContent | ThinkingContent | ToolCall)[]): HarnessEvent {
		const message: AssistantMessage = {
			role: "assistant",
			content,
			api: "mistral-conversations",
			provider: "mistral-vibe",
			model: this.#model,
			// Vibe reports tokens only for the whole run, in export.json (`finish`).
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: content.some((part) => part.type === "toolCall") ? "toolUse" : "stop",
			timestamp: Date.now(),
		};
		return { type: "assistant", message, messageId: id };
	}

	/**
	 * Reads the run's `export.json`, which Vibe writes on every exit but a
	 * kill, then removes the run's directory: the model it ran, its tokens,
	 * a lost key, the warnings it went on despite, and how it ended. Without
	 * an export there is no result, and the turn ends as the runner sees it.
	 */
	async finish(files: HarnessFiles): Promise<HarnessEvent[]> {
		const dir = vibeRunDir(this.#turn.sessionId);
		try {
			const text = await files.read(`${dir}/out/export.json`);
			if (text === null) return [];
			const value = json(text);
			if (!isObject(value)) return [{ type: "unparsed", line: text.slice(0, 500) }];
			// The model the session runs, which the export leaves unresolved while the config names none, is in the copy of its journal.
			const journal = str(value.journal_dir);
			const meta = journal && !journal.includes("..") ? json((await files.read(`${dir}/out/${journal}/meta.json`)) ?? "") : null;
			const model = (isObject(meta) && isObject(meta.config) ? str(meta.config.model_name) : null) || modelOf(value.config);
			return this.#export(value, model);
		} finally {
			await files.remove(dir);
		}
	}

	#export(value: Json, model: string | null): HarnessEvent[] {
		const events: HarnessEvent[] = [];
		const sessionId = str(value.session_id) ?? this.#sessionId;
		if (sessionId) events.push({ type: "session", sessionId, model });
		const before = this.#turn.sessionBefore;
		if (isObject(value.usage)) events.push({ type: "usage", usage: add(before.usage, usageOf(value.usage)) });
		for (const warning of Array.isArray(value.warnings) ? value.warnings : []) {
			const message = isObject(warning) ? str(warning.message) : null;
			if (message) events.push({ type: "notice", message });
		}
		const outcome = str(value.outcome) ?? "unknown";
		const error = isObject(value.error) ? value.error : null;
		const message = error ? str(error.message) : null;
		if (outcome === "config_error" && (error?.code === "invalid_api_key" || KEY_FAILURE.test(message ?? ""))) events.push({ type: "auth_failed", message: message ?? "Invalid API key" });
		const ok = outcome === "finished";
		events.push({
			type: "result",
			ok,
			reason: ok ? null : outcome === "price_limit" ? "budget" : outcome === "turn_limit" ? "max_turns" : "error",
			sessionId,
			// What this run cost, on top of the session's earlier turns.
			sessionCostUsd: typeof value.cost_usd === "number" ? before.costUsd + value.cost_usd : null,
			text: null,
			errors: ok ? [] : [message ?? `Mistral Vibe stopped: ${outcome.replaceAll("_", " ")}`],
		});
		return events;
	}
}

function json(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** The provider's name of the model the export's config pinned: the configured model its `active_model` alias names. */
function modelOf(config: unknown): string | null {
	if (!isObject(config)) return null;
	const alias = str(config.active_model);
	if (!alias) return null;
	const model = isObject(config.models) ? config.models[alias] : null;
	return (isObject(model) ? str(model.name) : null) ?? alias;
}

/** A run's tokens as Pim counts them: Vibe's `input_tokens` include the cached ones, which Pim counts apart. */
function usageOf(usage: Json): HarnessUsage {
	const cacheRead = num(usage.cached_input_tokens);
	return { input: Math.max(0, num(usage.input_tokens) - cacheRead), output: num(usage.output_tokens), cacheRead, cacheWrite: 0 };
}

function add(before: HarnessUsage | null, run: HarnessUsage): HarnessUsage {
	if (!before) return run;
	return { input: before.input + run.input, output: before.output + run.output, cacheRead: before.cacheRead + run.cacheRead, cacheWrite: before.cacheWrite + run.cacheWrite };
}
