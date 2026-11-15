/**
 * What the API shows of chats and apps: a chat's tasks, forks and ui blocks as the web app reads them, the ids and records it may see, and the
 * bridge an app uses to reach the space's data and tools.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import { type PiModel, PiHarness, ROOT_SESSION } from "agents/harness/pi";
import { ArtifactStore, type DataScope } from "../artifacts";
import type { CustomProvider } from "../providers";
import { ImageStore } from "../images";
import { CHATGPT_PROVIDER } from "../chatgpt";
import { appToolPermission, type McpBridge, toolName, toText } from "../extensions/mcp";
import { SEND_TO_USER, uiSourcesOf } from "../extensions/messaging";
import { PimBrowser } from "../browser";
import type { DeploymentSettings } from "../deployment";
import { HttpError, readJson } from "@pim/shared/http";
import type { PublicApproval } from "../protocol";
import { type Approval, PimStore } from "../store";
import { type Agent, AgentStore } from "../agents";
import { ChatLinkStore } from "../chat-links";
import { ROOM_POST, RoomStore } from "../rooms";
import { type Role, type Task, TaskStore } from "../tasks";
import { projectEntries } from "@pim/shared/transcript";
import { compile, uiBlockIds, type UiProgram } from "@pim/ui-lang";
import { ARTIFACT_ASK, type UtilityTask } from "../utility";
import { VisitStore } from "../visits";
import { ARTIFACT_ID, VERSION, within, describeModel, errorMessage } from "./shared";

/** Where the sweep of what ui blocks held in messages that are gone left off, and when it last ran. */
export const UI_SWEEP_CURSOR_KEY = "ui_state_sweep_cursor";

export const UI_SWEPT_KEY = "ui_state_swept_at";

/** How many messages a sweep looks at, and how long it waits before the next unless a chat was deleted. */
export const UI_SWEEP_MESSAGES = 25;

export const UI_SWEEP_EVERY_MS = 10 * 60_000;

/** What what the API shows of the space needs of the space. `Pim` implements it over its own members, so none of them leave it. */
export interface ViewsHost {
	readonly roleOf: (session: string) => Role;
	readonly store: PimStore;
	readonly tasks: TaskStore;
	readonly rooms: RoomStore;
	readonly harness: PiHarness;
	readonly images: ImageStore;
	readonly chatLinks: ChatLinkStore;
	readonly deployment: () => DeploymentSettings;
	readonly name: string;
	readonly chooseSessionModel: (session: string, model: PiModel | null) => Promise<PiModel>;
	readonly defaultModel: () => PiModel;
	readonly customProviders: () => { catalogId: string; shared: boolean; provider: CustomProvider; }[];
	readonly choice: (provider: string, id: string) => Promise<PiModel>;
	readonly allowedModels: () => readonly string[] | null;
	readonly hasWorkersAi: () => boolean;
	readonly ai: import("agents/models/pi-ai").AI;
	readonly sessionModel: (session: string, agent?: Agent) => PiModel;
	readonly visits: VisitStore;
	readonly agents: AgentStore;
	readonly taskApart: (conversation: string) => Task | undefined;
	readonly browser: PimBrowser;
	readonly artifacts: ArtifactStore;
	readonly apps: McpBridge;
	readonly utility: (task: UtilityTask, input: string) => Promise<string>;
	readonly assertOpen: () => void;
}

export class Views {
	constructor(private readonly host: ViewsHost) {}

	/** A task as the API shows it: who does it for whom, and how it went. */
	publicTask(task: Task) {
		const by = (conversation: string) => {
			const { agent } = this.host.roleOf(conversation);
			return { id: agent.id, name: agent.name };
		};
		return {
			id: task.id,
			parent: task.parent,
			call: task.call,
			// The chat it works in, which the person opens; null for a task from before tasks were chats, read here instead.
			session: task.chat ? this.host.store.publicId(task.conversation) : null,
			agent: by(task.conversation),
			from: by(task.requester!),
			task: task.task,
			state: task.state,
			result: task.result,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
		};
	}

	/** One of the tasks the work begun in a chat led to; 404 for any other. */
	async taskOf(session: string, id: string): Promise<Task> {
		const task = this.host.tasks.get(id);
		if (!task || task.kind === "review" || task.root !== (await this.session(session))) throw new HttpError(404, `No task ${id}`);
		return task;
	}

	/** Conversations that aren't the person's chats: deleted ones, tasks', and those agents talk in in rooms. */
	hiddenSessions(): Set<string> {
		return new Set([...this.host.store.deletedSessions(), ...this.host.tasks.conversations(), ...this.host.rooms.conversations()]);
	}

	/**
	 * A new fork's title: its chat's, numbered after the forks with that title
	 * the person still has, as "Trip (fork #2)"; a fork of a fork counts with
	 * the forks of the chat it came from. None for a chat without one.
	 */
	async forkTitle(session: string): Promise<string | undefined> {
		const title = this.host.store.sessionInfo(session)?.title;
		if (!title) return undefined;
		const base = title.replace(/ \(fork #\d+\)$/, "");
		const hidden = this.hiddenSessions();
		const numbers = (await this.host.harness.sessions.list()).flatMap((info) => {
			const other = hidden.has(info.id) ? null : this.host.store.sessionInfo(info.id)?.title;
			const number = other?.startsWith(`${base} (fork #`) ? /^ \(fork #(\d+)\)$/.exec(other.slice(base.length))?.[1] : undefined;
			return number === undefined ? [] : [Number(number)];
		});
		return `${base} (fork #${Math.max(0, ...numbers) + 1})`;
	}

	/**
	 * Deletes the images sent in a deleted chat, and in the deleted chats it
	 * was forked from, unless a fork still there shows them.
	 */
	async deleteImages(session: string): Promise<void> {
		const parents = new Map((await this.host.harness.sessions.list()).flatMap((info) => (info.parent === undefined ? [] : [[info.id, info.parent] as const])));
		const deleted = this.host.store.deletedSessions();
		const shown = new Set<string>();
		for (const fork of parents.keys()) {
			if (deleted.has(fork)) continue;
			for (let parent = parents.get(fork); parent !== undefined && !shown.has(parent); parent = parents.get(parent)) shown.add(parent);
		}
		for (let chat: string | undefined = session; chat !== undefined; chat = parents.get(chat)) {
			if (deleted.has(chat) && !shown.has(chat)) await this.host.images.deleteSession(chat);
		}
	}

	/** The session a public id names (see `PimStore.publicId`), if it is one of the person's chats. */
	async session(id: string): Promise<string> {
		const session = this.host.store.sessionOf(id);
		// The root stays reachable when deleted: it is where API clients talk by default.
		if (session === ROOT_SESSION) return session;
		if (
			session === undefined ||
			this.hiddenSessions().has(session) ||
			!(await this.host.harness.sessions.list()).some((candidate) => candidate.id === session)
		) {
			throw new HttpError(404, `No session ${id}`);
		}
		return session;
	}

	/** A chat's public link as its owner sees it, with its address; null without one. */
	chatLink(session: string) {
		const link = this.host.chatLinks.of(session);
		return link ? { ...link, url: `${this.host.deployment().publicUrl}/shared/${this.host.name}/${link.id}` } : null;
	}

	/**
	 * The transcript entry a message id names, when it is in one of the person's
	 * chats that is still there. `chats` is what those are, when the caller has
	 * it already, as a sweep that asks about many messages does.
	 */
	async #uiMessage(id: string, chats?: { hidden: Set<string>; ids: Set<string> }) {
		const found = /^[1-9]\d*$/.test(id) ? await (await this.host.harness.storage()).entry(Number(id) as EntryId, BACKGROUND_CONTEXT) : undefined;
		if (!found) return undefined;
		const conversation = String(found.entry.conversationId);
		const hidden = chats?.hidden ?? this.hiddenSessions();
		const ids = chats?.ids ?? new Set((await this.host.harness.sessions.list()).map((candidate) => candidate.id));
		return hidden.has(conversation) || !ids.has(conversation) ? undefined : found;
	}

	/**
	 * Forgets what ```ui blocks held in messages that are gone, such as those of
	 * a deleted chat: the state is kept by message id, and nothing else says
	 * when a message goes. It looks at a bounded number of messages each time,
	 * where it left off, so any amount of leftover state is cleared over a few
	 * runs and none takes long; and at most once in `UI_SWEEP_EVERY_MS` unless
	 * `now` says a chat was just deleted. Returns how many messages' state it
	 * forgot.
	 */
	async sweepUiState({ now = false } = {}): Promise<number> {
		const at = Date.now();
		if (!now && at - Number(this.host.store.meta(UI_SWEPT_KEY) ?? 0) < UI_SWEEP_EVERY_MS) return 0;
		this.host.store.setMeta(UI_SWEPT_KEY, String(at));
		const after = this.host.store.meta(UI_SWEEP_CURSOR_KEY) ?? "";
		let messages = this.host.store.uiStateMessages(after, UI_SWEEP_MESSAGES);
		// At the end of what is kept, the next run starts again from the first.
		this.host.store.setMeta(UI_SWEEP_CURSOR_KEY, messages.length < UI_SWEEP_MESSAGES ? "" : (messages[messages.length - 1] as string));
		if (messages.length === 0) return 0;
		const chats = { hidden: this.hiddenSessions(), ids: new Set((await this.host.harness.sessions.list()).map((candidate) => candidate.id)) };
		messages = (await Promise.all(messages.map(async (message) => ((await this.#uiMessage(message, chats)) === undefined ? message : null)))).filter((message) => message !== null);
		for (const message of messages) this.host.store.deleteUiStates(message);
		return messages.length;
	}

	/**
	 * The ```ui blocks of an agent's message, compiled, by their ids (see
	 * `uiBlockId`), when it is a message of one of the person's chats: what
	 * an agent sent with send_to_user, or its text, or another agent's post in
	 * a group chat. The person's own messages draw nothing, and a message of
	 * a chat that isn't theirs, or is gone, is not found.
	 */
	async uiBlocks(id: string, within?: string): Promise<Map<string, UiProgram>> {
		const found = await this.#uiMessage(id);
		const conversation = found ? String(found.entry.conversationId) : undefined;
		if (
			!found ||
			conversation === undefined ||
			// An agent reads only its own chat, or the room it speaks in.
			(within !== undefined && conversation !== within && conversation !== this.host.rooms.of(within)?.room)
		) {
			throw new HttpError(404, `No message ${id}`);
		}
		const blocks = new Map<string, UiProgram>();
		for (const message of projectEntries([found.entry])) {
			// Each text is drawn by itself, so its blocks are told apart within it; consecutive text parts are one text, as the app joins them.
			const texts: string[] = [];
			let run = "";
			const flush = () => {
				if (run !== "") texts.push(run);
				run = "";
			};
			for (const part of message.parts) {
				if (message.role === "assistant" && part.type === "text") run += part.text;
				if (message.role === "assistant" && part.type === "tool-call" && part.name === SEND_TO_USER) {
					flush();
					const sent = (part.arguments as { message?: unknown } | null)?.message;
					if (typeof sent === "string") texts.push(sent);
				}
				if (message.role === "user" && part.type === "text" && ROOM_POST.test(part.text)) texts.push(part.text.replace(ROOM_POST, ""));
			}
			flush();
			for (const text of texts) {
				const sources = uiSourcesOf(text);
				uiBlockIds(sources).forEach((block, index) => {
					if (!blocks.has(block)) blocks.set(block, compile(sources[index]!));
				});
			}
		}
		return blocks;
	}

	/** Chooses, or with null clears, the model of one conversation from a request's {provider, id} or {model}. */
	async changeSessionModel(id: string, request: Request) {
		const body = (await readJson<{ provider?: unknown; id?: unknown; model?: unknown }>(request)) ?? {};
		// Null, or an empty model, clears the chat's own choice: it follows its agent's again.
		if (body.model === null || body.model === "" || (body.provider === null && body.id === null)) {
			return { model: describeModel(await this.host.chooseSessionModel(id, null)), override: null };
		}
		const hint = `Send {provider, id} of one of GET /model's choices (for example {"provider":"own:ai-gateway","id":"claude-sonnet-5-5"}), or {model:"<provider>/<id>"}.`;
		let provider: string | undefined;
		let modelId: string | undefined;
		if (typeof body.provider === "string" && typeof body.id === "string") {
			provider = body.provider;
			modelId = body.id;
		} else if (typeof body.model === "string") {
			// The longest provider id the string starts with, since a model id may hold "/" too.
			const text = body.model;
			const known = [this.host.defaultModel().provider, CHATGPT_PROVIDER, ...this.host.customProviders().map(({ catalogId }) => catalogId)];
			provider = known.filter((candidate) => text.startsWith(`${candidate}/`)).sort((a, b) => b.length - a.length)[0];
			if (provider) modelId = text.slice(provider.length + 1);
		} else {
			throw new HttpError(400, hint);
		}
		let resolved: PiModel;
		if (provider && modelId !== undefined) {
			try {
				resolved = await this.host.choice(provider, modelId);
			} catch (error) {
				if (error instanceof HttpError && error.status === 400) throw new HttpError(400, `${error.message}. ${hint}`);
				throw error;
			}
		} else {
			// A bare Workers AI id, as sessions have always taken.
			const bare = body.model as string;
			const allowed = this.host.allowedModels();
			if (allowed && bare !== this.host.defaultModel().id && !allowed.includes(bare)) {
				throw new HttpError(403, `${bare} is not available here. ${hint}`);
			}
			try {
				if (!this.host.hasWorkersAi()) throw new Error("This Pim has no Workers AI");
				resolved = this.host.ai(bare);
			} catch (error) {
				throw new HttpError(400, `${errorMessage(error)}. ${hint}`);
			}
		}
		await this.host.chooseSessionModel(id, resolved);
		return { model: describeModel(resolved), override: describeModel(resolved) };
	}

	/** What model a chat runs on, and whether it was chosen for the chat alone. */
	sessionModelInfo(session: string): { model: ReturnType<typeof describeModel>; override: boolean } {
		const chosen = this.host.store.sessionInfo(session)?.model;
		const model = this.host.sessionModel(session);
		return { model: describeModel(model), override: Boolean(chosen && chosen.provider === model.provider && chosen.id === model.id) };
	}

	/** A session's name and activity, under its public id. */
	sessionInfo(session: string) {
		const info = this.host.store.sessionInfo(session);
		return info && { ...info, id: this.host.store.publicId(session) };
	}

	/** A record as it leaves the space: with its session's public id. */
	publicSession<T extends { readonly session: string | null }>(record: T): T {
		return record.session === null ? record : { ...record, session: this.host.store.publicId(record.session) };
	}

	/** Notifications carry the look of their chat's agent, but no private instructions or settings. */
	publicNotification<T extends { readonly session: string | null }>(notification: T) {
		const agent = notification.session !== null && !this.host.visits.bySession(notification.session) && this.host.store.sessionInfo(notification.session)
			? this.host.agents.ofSession(notification.session)
			: null;
		return { ...this.publicSession(notification), agent: agent ? { id: agent.id, icon: agent.icon, symbol: agent.symbol, color: agent.color } : null };
	}

	/** An app as it leaves the space. One made in a task's conversation that isn't a chat belongs to the chat the task began in, where the person can open it beside the chat. */
	publicArtifact<T extends { readonly session: string | null }>(artifact: T): T {
		const session = artifact.session === null ? null : (this.host.taskApart(artifact.session)?.root ?? artifact.session);
		return this.publicSession({ ...artifact, session });
	}

	/** An approval as it leaves the space. A guest's conversation is in the guest's own space, so it has none here. */
	publicApproval(approval: Approval): PublicApproval {
		return {
			...approval,
			session: approval.requestedBy ? null : this.host.store.publicId(approval.session),
			member: approval.member && { ...approval.member, session: this.host.store.publicId(approval.member.session) },
		};
	}

	/**
	 * Answers an app request. A token in the address is refused: the API
	 * takes one there only for WebSockets, and an address with a token in it
	 * can be passed on, logged or kept in history.
	 */
	/** An app with a backend, or 404. */
	hostedApp(id: string) {
		const app = this.artifact(id);
		if (app.kind !== "hosted") throw new HttpError(404, `${id} is not an app with a backend`);
		return app;
	}

	artifactRequest(url: URL, answer: () => Response | Promise<Response>): Response | Promise<Response> {
		if (url.searchParams.has("token")) throw new HttpError(400, "Send the API token in the Authorization header, not the address");
		return answer();
	}

	/**
	 * The window a chat (`?session=`, the root chat without one) shows in
	 * the browser: its own, that of a task it handed out, or that of an agent
	 * in it when it is a group chat, whichever was used last, so the person
	 * sees, and takes over, where work is going on. Each conversation has a
	 * browser of its own, on the display of its own that its desktop tools use.
	 */
	async browserWindow(url: URL): Promise<string> {
		const requested = url.searchParams.get("session");
		const chat = requested ? await this.session(requested) : ROOT_SESSION;
		return this.host.browser.lastUsed([...this.host.rooms.everyConversation(chat), ...this.host.tasks.ofRoot(chat).map((task) => task.conversation)]);
	}

	/** The browser, or 404 while the person has no computer for it to run on. */
	browserIn(): PimBrowser {
		if (!this.host.browser.available) throw new HttpError(404, "This space has no browser: connect a computer in Settings → Computer");
		return this.host.browser;
	}

	artifact(id: string) {
		const artifact = ARTIFACT_ID.test(id) ? this.host.artifacts.get(id) : undefined;
		if (!artifact) throw new HttpError(404, `No app ${id}`);
		return artifact;
	}

	/**
	 * A connector tool an app may call, by its pi name: one the owner lets
	 * run without asking. A tool that asks first can't be used from an
	 * app, since nothing there could show the person what it's about to do.
	 */
	#artifactTool(name: unknown) {
		const servers = new Map(this.host.apps.servers().map((server) => [server.id, server]));
		for (const tool of this.host.apps.tools()) {
			const server = servers.get(tool.serverId);
			if (!server || toolName(server.id, tool.name) !== name) continue;
			if (server.state !== "ready") throw new HttpError(503, `${server.name} isn't connected right now.`);
			if (appToolPermission(this.host.store, server, tool).permission !== "on") {
				throw new HttpError(403, `${server.name}'s ${tool.name} asks you before it runs, or is off, so an app can't use it.`);
			}
			return { server, tool, label: `${server.name}: ${tool.annotations?.title ?? tool.name}` };
		}
		throw new HttpError(404, `No connector tool ${String(name)}`);
	}

	/**
	 * One call an app made through the bridge, as the web app relays it,
	 * for the person this space is: on their own app, or one shared with
	 * them, which this space knows by `key` (its own app's id, or
	 * `<host>/<id>`). What it keeps for them (`storage`) and needs no
	 * permission is kept here; the model and connector tools are theirs too, and
	 * need their permission, given to this version (`needs` asks for it).
	 * What everyone using it sees (`shared`) is the app owner's,
	 * reached through `shared`.
	 */
	async artifactBridge(
		key: string,
		sha: string,
		op: unknown,
		args: Record<string, unknown>,
		shared: (op: string, args: Record<string, unknown>) => Promise<unknown>,
	): Promise<{ value: unknown } | { needs: { capability: string; label: string } }> {
		if (typeof op === "string" && op.startsWith("shared.")) return { value: await shared(op, args) };
		switch (op) {
			case "storage.get":
			case "storage.list":
			case "storage.set":
			case "storage.delete":
				return { value: this.artifactData(key, "own", op, args) };
			case "model.ask": {
				const prompt = args.prompt;
				if (typeof prompt !== "string" || prompt.trim() === "") throw new HttpError(400, "pim.ask needs a prompt");
				if (prompt.length > 20_000) throw new HttpError(413, "A prompt can be at most 20,000 characters");
				if (!this.host.artifacts.granted(key, sha, "model")) return { needs: { capability: "model", label: "model" } };
				return { value: await this.host.utility(ARTIFACT_ASK, prompt) };
			}
			case "tools.call": {
				const { server, tool, label } = this.#artifactTool(args.name);
				const capability = `tool:${toolName(server.id, tool.name)}`;
				if (!this.host.artifacts.granted(key, sha, capability)) return { needs: { capability, label } };
				const input = args.input ?? {};
				if (typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "A tool's input must be an object");
				this.host.assertOpen();
				const result = await this.host.apps.call(server.id, tool.name, input as Record<string, unknown>);
				if (result.isError) throw new HttpError(502, toText(result));
				return { value: toText(result) };
			}
			default:
				throw new HttpError(400, `There is no pim.${String(op)}`);
		}
	}

	/** A storage call (`storage.get`, `shared.set`, ...) on what an app keeps here, in a scope. */
	artifactData(key: string, scope: DataScope, op: string, args: Record<string, unknown>): unknown {
		switch (op.slice(op.indexOf(".") + 1)) {
			case "get":
				return this.host.artifacts.dataGet(key, scope, args.key as string);
			case "list":
				return this.host.artifacts.dataKeys(key, scope, typeof args.prefix === "string" ? args.prefix : "");
			case "set":
				this.host.assertOpen();
				this.host.artifacts.dataSet(key, scope, args.key as string, args.value as string);
				return null;
			case "delete":
				this.host.assertOpen();
				this.host.artifacts.dataDelete(key, scope, args.key as string);
				return null;
			default:
				throw new HttpError(400, `There is no pim.${op}`);
		}
	}

	/** Lets the person use `capability` from a version of an app, by the key this space knows it by. */
	grantArtifact(key: string, sha: string, capability: unknown): string {
		if (capability !== "model") {
			if (typeof capability !== "string" || !capability.startsWith("tool:")) throw new HttpError(400, "capability must be model or tool:<name>");
			this.#artifactTool(capability.slice("tool:".length));
		}
		this.host.assertOpen();
		this.host.artifacts.grant(key, sha, capability);
		return capability;
	}

	artifactVersion(id: string, version: string) {
		const artifact = this.artifact(id);
		const found = VERSION.test(version) ? this.host.artifacts.version(artifact.id, Number(version)) : undefined;
		if (!found) throw new HttpError(404, `No version ${version} of app ${id}`);
		return { artifact, found };
	}
}
