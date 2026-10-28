import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { PiModel } from "agents/harness/pi";
import { ownedCode } from "../src/auth";
import { bridgeFor } from "../src/cua";
import { OBSERVATION_PATH_PREFIX, observationResponse } from "../src/cua-observation";
import { OBSERVATION_KEY, ObservationDesk } from "../src/cua-observation-runtime";
import { appOrigin, CuaViewerClient } from "../src/cua-viewer";
import { deploymentSettings } from "../src/deployment";
import type { ImageModel } from "../src/extensions/image-generation";
import { serve } from "../src/gateway";
import { OWNER_HEADER, Pim as RealPim, SIGNED_IN_HEADER } from "../src/pim";
import { INTRODUCTION } from "../src/transcript";
import { Authenticator } from "../test/webauthn";
import { previewAutomation } from "./automation";
import { evaluatorAdmission, type EvaluatorSpace, launchEvaluatorGrant, previewLaunchEvaluator, type SpaceEnd, type SpaceLaunch } from "./launch-evaluator";
import { closedInEvaluation, EVAL_MODE, evaluating, previewMode, throughIngress } from "./cua-eval";
import { type FixtureResult, seedCuaFixture, starts } from "./cua-fixture";
import { agentMode, VIEWER_FIRST } from "./cua-viewer-first";

export { Auth, Gallery } from "../src/index";
export { EvalDirectory as Directory } from "./cua-eval";

/**
 * The Worker `pnpm preview` runs (wrangler.preview.jsonc): the real Pim, with
 * no Cloudflare account. Never deploy it. It differs from a deployment in two ways:
 *
 * - A stand-in model, so chats answer. It echoes what you say through
 *   `send_to_user`, and calls a tool when told to: `/tool create_goal {"title": "Run a 5k"}`.
 *   After a tool runs, it calls the next one if the message has more `/tool` lines, and
 *   otherwise sends the last tool's result. Memory compression gets a short summary.
 *   An agent at work on a task answers in plain text, the majordomo introduces itself with a stock greeting,
 *   and it asks the person about every approval it reviews.
 *   The utility model titles a chat with the first words of its last message, appends a
 *   line to a prompt it improves, writes a placeholder summary, and names the tools an
 *   agent is calling as what it is doing, and suggests three prompts from the last thing you said. `generate_image` draws Pim's icon.
 * - `GET /__dev/sign-in/<username>?returnTo=/path` signs the browser in as
 *   that person, making the account if it's new, with a passkey made here.
 *
 * Opted into by its private environment only, it also seeds one space with an
 * operator's Cua computer, once (./cua-fixture.ts, docs/cua-bridge.md), and
 * lets that space's owner watch its desktop, view only, from their browser's
 * session (`/api/observations`, docs/cua-viewer-first-preview.md). A
 * deployment mounts neither.
 *
 * With `PREVIEW_MODE=cua-eval` it is the Cua evaluation's preview instead
 * (./cua-eval.ts, docs/cua-viewer-first-vm-plan.md): no `/__dev` route,
 * closed registration, one owner set up once with the operator's claim code,
 * and only requests at Pim's own address, through the operator's ingress
 * (`PIM_RUNTIME=celld`) or Cloudflare's (`PIM_RUNTIME=cloudflare`, a Worker
 * of its own, wrangler.cua-eval.jsonc). The stand-in model, the fixture and
 * watching are as above: a real model is a separate step. Only this mode
 * mounts automation sign-in, off unless its private environment grants it
 * (./automation.ts, docs/preview-automation.md).
 */

const PREVIEW_MODEL = "preview-model";
const MEMORY_MODEL = "preview-memory";
const UTILITY_MODEL = "preview-utility";

const textOf = (message: Message | undefined): string => {
	if (!message || message.role === "assistant") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

/** The tool calls a message asks for: one `/tool <name> {json}` per line, run one after another; a single one may span lines. */
const directives = (text: string) => (/^\/tool\s/.test(text) ? text.split(/\n(?=\/tool\s)/).map((part) => /^\/tool\s+(\S+)\s*([\s\S]*)$/.exec(part.trim())) : []);

/** A call to the tool `directive` asks for, or a message saying its JSON is wrong. */
const call = (directive: RegExpExecArray | null) => {
	const [, name, json] = directive ?? [];
	try {
		const args = json!.trim() === "" ? {} : JSON.parse(json!);
		return fauxAssistantMessage(fauxToolCall(name!, args), { stopReason: "toolUse" });
	} catch (error) {
		return send(`That isn't JSON: ${String(error)}`);
	}
};

const send = (message: string) =>
	fauxAssistantMessage(fauxToolCall("send_to_user", { message }), { stopReason: "toolUse" });

/** One answer to the conversation so far. */
const answer: FauxResponseFactory = (context, _options, _state, model) => {
	const messages = context.messages.filter((message) => message.role !== "system");
	const last = messages.at(-1);

	if (model.id === MEMORY_MODEL) {
		const block = /Compress memories #(\d+-\d+)/.exec(textOf(last))?.[1] ?? "";
		return fauxAssistantMessage(`Memories ${block}, summarized by the preview model.`);
	}

	if (model.id === UTILITY_MODEL) {
		// Stand-ins for what a real model would write, one per job in src/utility.ts.
		const input = textOf(last).trim();
		const job = textOf(context.messages.find((message) => message.role === "system"));
		if (job.startsWith("You name chats")) {
			const said = input.split("\n\n").findLast((turn) => turn.startsWith("Person: ")) ?? input;
			return fauxAssistantMessage(said.replace(/^Person: /, "").split(/\s+/).slice(0, 4).join(" "));
		}
		if (job.startsWith("You improve")) {
			return fauxAssistantMessage(`${input}\n\nPlease be specific, and tell me what you need from me to get it right.`);
		}
		if (job.startsWith("You tell a person what their AI assistant is doing")) {
			const tools = [...input.matchAll(/^- ([^\s:]+) \{/gm)].map((match) => match[1]!.replaceAll("_", " "));
			return fauxAssistantMessage(`Working on it with ${tools.join(" and ") || "a tool"}`);
		}
		if (job.startsWith("You suggest what a person might say next")) {
			const said = input.split("\n").find((turn) => turn.startsWith("Person: "))?.replace(/^Person: /, "") ?? "this";
			const messages = [`Tell me more about ${said.split(/\s+/).slice(0, 4).join(" ")}`, "What should I do next?", "Summarize what we covered"];
			return fauxAssistantMessage(JSON.stringify({ messages }));
		}
		if (job.startsWith("You answer requests from a small app")) {
			return fauxAssistantMessage(`The preview model got your request: ${input}`);
		}
		const turns = input.split("\n\n").length;
		return fauxAssistantMessage(
			`- A preview conversation of ${turns} turns.\n- The preview model can't read it.\n\n## Next steps\n\n- Choose a real utility model to get a real summary.`,
		);
	}

	const system = JSON.stringify(context.messages.filter((message) => message.role === "system"));
	if (system.includes('"name":"decide_approval"')) {
		return last?.role === "toolResult"
			? fauxAssistantMessage("Asked the person.")
			: fauxAssistantMessage(fauxToolCall("decide_approval", { decision: "escalate", note: "The preview model can't judge this: you decide." }), { stopReason: "toolUse" });
	}
	// An agent at work for another has no `send_to_user`: it answers in plain text, after a tool when told to call one.
	if (!system.includes('"name":"send_to_user"')) {
		if (last?.role === "toolResult") return fauxAssistantMessage(`\`${last.toolName}\` returned:\n\n${textOf(last).slice(0, 1_000) || "(nothing)"}`);
		if (!/^\/tool\s/.test(textOf(last).trim())) return fauxAssistantMessage(`Done: ${textOf(last).trim()}`);
	}

	if (last?.role === "toolResult") {
		const result = textOf(last).slice(0, 1_000);
		if (last.toolName === "send_to_user") {
			// A failed send would fail again: end the turn and let the harness report it. After a progress update, finish.
			return last.isError ? fauxAssistantMessage(result) : send("Done.");
		}
		// The next tool the message asked for, if any is left.
		const asked = messages.findLastIndex((message) => message.role === "user");
		const calls = directives(textOf(messages[asked]).trim());
		const done = messages.slice(asked).filter((message) => message.role === "toolResult").length;
		if (done < calls.length) return call(calls[done]!);
		return send(`\`${last.toolName}\` ${last.isError ? "failed" : "returned"}:\n\n${result || "(nothing)"}`);
	}

	const text = textOf(messages.findLast((message) => message.role === "user")).trim();
	if (text.startsWith(INTRODUCTION)) {
		const name = /named you (.+?)\.(?: |$)/m.exec(text)?.[1] ?? "your majordomo";
		const them = /Their name is (.+?)\.(?: |$)/m.exec(text)?.[1];
		return send(
			`Hello${them ? `, ${them}` : ""}! I'm ${name}, your majordomo. Come to me for almost anything: I'll get to know you, set up agents for the bigger jobs, and look after what they need your approval for.\n\nTell me about yourself, as much or as little as you like. What keeps you busy these days?`,
		);
	}
	const [first] = directives(text);
	if (first !== undefined) return call(first);
	return send(`You said: ${text}\n\n_Preview model. Send \`/tool <name> {json}\` to call a tool._`);
};

/** The stand-in model's provider: every request gets `answer`, streamed a little at a time. */
function previewProvider() {
	const core = createFauxCore({
		provider: "preview",
		models: [
			{ id: PREVIEW_MODEL, name: "Preview model", contextWindow: 200_000 },
			{ id: MEMORY_MODEL, name: "Preview memory model" },
			{ id: UTILITY_MODEL, name: "Preview utility model" },
		],
		tokensPerSecond: 200,
	});
	const respond = <A extends unknown[], R>(stream: (...args: A) => R) => (...args: A): R => {
		core.setResponses([answer]);
		return stream(...args);
	};
	const provider = createProvider({
		id: core.provider,
		auth: { apiKey: { name: "Preview", resolve: async () => ({ auth: {} }) } },
		models: core.models,
		api: {
			stream: respond(core.stream),
			streamSimple: respond(core.streamSimple),
			fetchDeferred: core.fetchDeferred,
			cancelDeferred: core.cancelDeferred,
		},
	});
	return { provider, getModel: core.getModel };
}

const preview = previewProvider();

/** Whether the preview's private environment opts into its Cua fixture, and with it the observation routes, for one owner. */
function watching(env: Env): boolean {
	const settings = env as unknown as Record<string, unknown>;
	return settings.PREVIEW_CUA_FIXTURE === "seed" && typeof settings.PREVIEW_CUA_FIXTURE_OWNER === "string" && /^o_[0-9a-z]{26}$/.test(settings.PREVIEW_CUA_FIXTURE_OWNER);
}

/** Whether `name` is the space the fixture seeded, and the environment still names it: the one space that may watch. */
function watches(fixture: FixtureResult, name: string | undefined, env: Env): name is string {
	const seeded = fixture.outcome === "seeded" || fixture.outcome === "already-seeded";
	return seeded && watching(env) && name !== undefined && (env as unknown as Record<string, unknown>).PREVIEW_CUA_FIXTURE_OWNER === name;
}

export class Pim extends RealPim implements EvaluatorSpace {
	/** The space's observations of its Cua desktop: only in the one space the fixture seeded; null in every other. */
	readonly #desk: ObservationDesk | null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// The one space the preview's private environment names gets its operator's Cua computer, once (./cua-fixture.ts),
		// before the space answers anything or sets up its agents' tools. A space it was asked to seed and didn't, or that it
		// began on and didn't finish, isn't constructed: every request, call, alarm and socket event to it fails, so it reaches
		// no computer, default or not, and takes no one's input.
		const fixture = seedCuaFixture({ name: ctx.id.name, meta: this.store, transaction: (fn) => ctx.storage.transactionSync(fn) }, env as unknown as Record<string, unknown>);
		if (!starts(fixture)) throw new Error("This preview space's Cua fixture didn't seed it, so it doesn't start (see docs/cua-bridge.md).");
		const owner = ctx.id.name;
		// Pim's own address, which keeps the viewer's host apart from it. A local preview may be at loopback HTTP, which the host
		// can never let frame the viewer, and is then said to be so, never taken for an embeddable one (src/cua-viewer.ts).
		// The evaluation mode is never at one (./cua-eval.ts).
		const app = () => appOrigin(deploymentSettings(env).publicUrl ?? "", !evaluating(env));
		const frame = () => {
			try {
				return app().embeddable ? "embeddable" : "local_http";
			} catch {
				return "refused";
			}
		};
		// The ledger is read here, and only the fixture's seed ever wrote one: a space without it can't watch (src/cua-observation-runtime.ts).
		this.#desk = watches(fixture, owner, env)
			? new ObservationDesk({
					owner,
					storage: {
						read: () => this.store.meta(OBSERVATION_KEY),
						write: (value) => this.store.setMeta(OBSERVATION_KEY, value),
						flush: () => ctx.storage.sync(),
					},
					client: () => new CuaViewerClient(bridgeFor((env as unknown as { CUA_BRIDGES?: unknown }).CUA_BRIDGES, owner), owner, app()),
					observationMs: VIEWER_FIRST.observationMs,
					openObservations: VIEWER_FIRST.openObservations,
					listing: () => ({ agent: agentMode(this.chosenModel().provider), frame: frame() }),
				})
			: null;
	}

	/**
	 * `/api/observations/…`, which only the preview's Worker forwards, from the
	 * owner's browser session (`serve`'s `observations` mount): checked as the
	 * real space checks every request, then answered by the desk, or `404`
	 * in a space that has none. Everything else is the real space's.
	 */
	override async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname !== OBSERVATION_PATH_PREFIX.slice(0, -1) && !pathname.startsWith(OBSERVATION_PATH_PREFIX)) return super.fetch(request);
		const refuse = (status: number, error: string) => observationResponse(Response.json({ error }, { status }));
		if (request.headers.get(OWNER_HEADER) !== this.name) return refuse(421, "This request is not for this space");
		if (this.store.erasedAt() !== null) return refuse(410, "This space was erased");
		if (this.status() !== "active") return refuse(403, "This space is suspended");
		const publicUrl = deploymentSettings(this.env).publicUrl;
		if (!this.#desk || !publicUrl) return refuse(404, "Not found");
		return this.#desk.serve(request, { viaSession: request.headers.get(SIGNED_IN_HEADER) === "1" }, publicUrl);
	}

	/**
	 * The desk the launch evaluator (./launch-evaluator.ts) may use, with its
	 * grant as this space's own environment holds it, or why not: only in the
	 * evaluation, while its evaluator is on, in the one space the fixture
	 * seeded, active, not erased, with Pim's address set.
	 */
	#evaluated(): { desk: ObservationDesk; existingUnconfirmed: string | null } | string {
		const grant = launchEvaluatorGrant(this.env, Date.now());
		if (!evaluating(this.env) || "off" in grant) return "off";
		if (!this.#desk) return "no-desk";
		if (this.store.erasedAt() !== null) return "erased";
		if (this.status() !== "active") return "suspended";
		if (!deploymentSettings(this.env).publicUrl) return "address";
		return { desk: this.#desk, existingUnconfirmed: grant.existingUnconfirmed };
	}

	/**
	 * The launch evaluator's one Watch, over RPC only (never a route): a
	 * fresh observation, or nothing. It starts only with nothing unresolved,
	 * or, as the isolated preview's one exception, beside exactly the
	 * `unconfirmed` record the grant names (`evaluatorAdmission`), which the
	 * desk checks again and leaves as it is; otherwise nothing is recorded or
	 * asked, so the desk never replays an open record or touches any earlier
	 * one. Nothing waits between the check and the desk recording its intent.
	 * The answer names the one record the launch added, and its viewer only
	 * when the desk handed one out for exactly that record and every earlier
	 * record is exactly as it was.
	 */
	async launchForEvaluator(): Promise<SpaceLaunch> {
		const evaluated = this.#evaluated();
		if (typeof evaluated === "string") return { outcome: "refused", reason: evaluated };
		const { desk, existingUnconfirmed } = evaluated;
		const before = desk.state;
		if (!before) return { outcome: "refused", reason: "blocked" };
		const admitted = evaluatorAdmission(before, existingUnconfirmed);
		if (!admitted.ok) return { outcome: "refused", reason: admitted.reason };
		const earlier = JSON.stringify(before.records);
		const known = new Set(before.records.map((record) => record.observationId));
		const answer = await desk.launch(admitted.alongside ?? undefined);
		const after = desk.state?.records ?? [];
		const added = after.filter((record) => !known.has(record.observationId));
		if (added.length === 0) return desk.blocked ? { outcome: "uncertain", observation: null } : { outcome: "refused", reason: "not-recorded" };
		if (added.length > 1) return { outcome: "uncertain", observation: null };
		const [fresh] = added;
		const unchanged = JSON.stringify(after.filter((record) => known.has(record.observationId))) === earlier;
		if (answer.status === 200 && fresh!.status === "open" && unchanged) {
			const body = (await answer.json().catch(() => null)) as { observation?: { id?: unknown }; viewer?: unknown } | null;
			if (body?.observation?.id === fresh!.observationId && typeof body.viewer === "string") {
				return { outcome: "open", observation: { id: fresh!.observationId, notAfter: fresh!.notAfter }, viewer: body.viewer, alongside: admitted.alongside };
			}
		}
		if (fresh!.status === "not_opened" && unchanged) return { outcome: "refused", reason: "not-opened" };
		return { outcome: "uncertain", observation: fresh!.observationId };
	}

	/**
	 * The launch evaluator's one End, over RPC only, of the observation its
	 * Directory recorded for the run (never one the caller names): asked only
	 * while that record is open.
	 */
	async endForEvaluator(observation: string): Promise<SpaceEnd> {
		const evaluated = this.#evaluated();
		if (typeof evaluated === "string") return { outcome: "refused", status: null };
		const { desk, existingUnconfirmed } = evaluated;
		// The earlier record the exception started beside is never ended from here.
		if (observation === existingUnconfirmed) return { outcome: "refused", status: null };
		const record = desk.state?.records.find((one) => one.observationId === observation);
		if (record?.status !== "open") return { outcome: "refused", status: record?.status ?? null };
		const answer = await desk.end(observation);
		const status = desk.state?.records.find((one) => one.observationId === observation)?.status ?? null;
		if (answer.status === 202) return { outcome: "requested", status };
		if (answer.status === 200) return { outcome: "final", status };
		return { outcome: desk.blocked || status === "unconfirmed" ? "uncertain" : "refused", status };
	}

	/** The stand-in model, besides the real providers: the ChatGPT plan, and those people add, such as a model on this machine. */
	protected override models(): MutableModels {
		const models = super.models();
		models.setProvider(preview.provider);
		return models;
	}

	protected override defaultModel(): PiModel {
		return preview.getModel(PREVIEW_MODEL)!;
	}

	protected override memoryModel(): ModelRef {
		return { provider: "preview", modelId: MEMORY_MODEL };
	}

	protected override defaultUtilityModel(): Model<Api> {
		return preview.getModel(UTILITY_MODEL)!;
	}

	/** A stand-in image model, which draws Pim's icon whatever it's asked for. */
	protected override imageModel(): ImageModel {
		return {
			id: "preview-image",
			generate: async () => new Uint8Array(await (await this.env.ASSETS.fetch("http://assets/icon-512.png")).arrayBuffer()),
		};
	}
}

const DEV_SIGN_IN = /^\/__dev\/sign-in\/([^/]+)$/;

/** Signs the browser in as `username`, with a new software passkey, and sends it to `returnTo`. */
async function devSignIn(request: Request, env: Env, ctx: ExecutionContext, username: string): Promise<Response> {
	const url = new URL(request.url);
	const call = (path: string, body: unknown, cookie?: string) =>
		serve(
			new Request(`${url.origin}/auth${path}`, {
				method: "POST",
				headers: {
					origin: url.origin,
					"content-type": "application/json",
					"CF-Connecting-IP": request.headers.get("CF-Connecting-IP") ?? "127.0.0.1",
					...(cookie ? { cookie } : {}),
				},
				body: JSON.stringify(body),
			}),
			env,
			ctx,
		);

	const account = await env.Directory.getByName("directory").resolve(username);
	let setup: string;
	if (account) {
		const { code } = await env.Auth.getByName(account.ownerId).issueSetupCode(Date.now(), 60_000);
		setup = ownedCode(account.ownerId, code);
	} else {
		const registered = await call("/register", { username });
		if (!registered.ok) return registered;
		setup = ((await registered.json()) as { setup: string }).setup;
	}

	const options = await call("/passkeys/options", { setup });
	if (!options.ok) return options;
	const challenge = options.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
	const authenticator = await Authenticator.make("ES256", { rpId: url.hostname, origin: url.origin });
	const registration = await authenticator.register((await options.json()) as { challenge: string; user: { id: string } });
	const created = await call("/passkeys", { ...registration, name: "Preview sign-in" }, challenge);
	if (!created.ok) return created;

	const returnTo = url.searchParams.get("returnTo") ?? "/";
	const headers = new Headers({ location: /^\/(?![/\\])/.test(returnTo) ? returnTo : "/" });
	for (const cookie of created.headers.getSetCookie()) headers.append("set-cookie", cookie);
	return new Response(null, { status: 302, headers });
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const mode = previewMode(env);
		if ("refused" in mode) {
			console.error(JSON.stringify({ event: "preview.refused", reason: mode.refused }));
			return Response.json({ error: "This preview isn't set up to answer requests." }, { status: 503, headers: { "cache-control": "no-store" } });
		}
		if (mode.mode === EVAL_MODE) return evaluation(request, mode.env, ctx);
		// Only the evaluation mode may be reached through an ingress: a local preview there would let anyone sign in as anyone.
		if (throughIngress(request)) {
			console.error(JSON.stringify({ event: "preview.refused", reason: "ingress-without-mode" }));
			return Response.json({ error: "This preview isn't set up to answer requests." }, { status: 503, headers: { "cache-control": "no-store" } });
		}
		// The preview is reached under other names too, such as an orb's portal: it is the same Pim at each.
		const url = new URL(request.url);
		const home = deploymentSettings(env).publicUrl;
		if (home && url.origin !== home) {
			const sameSite = request.headers.get("origin") === url.origin;
			request = new Request(new URL(url.pathname + url.search, home), request);
			if (sameSite) request.headers.set("origin", home);
		}
		const signIn = request.method === "GET" ? DEV_SIGN_IN.exec(new URL(request.url).pathname) : null;
		if (signIn) return devSignIn(request, env, ctx, decodeURIComponent(signIn[1]!).toLowerCase());
		return serve(request, env, ctx, { observations: watching(env) });
	},
} satisfies ExportedHandler<Env>;

/**
 * The evaluation mode's requests (./cua-eval.ts): none under `/__dev` and no
 * setup link, by any method; then only a request whose URL is at Pim's own
 * address: on Cloudflare, the custom domain it was reached at, and locally what
 * Wrangler hands the Worker when it runs with `--host <Pim's host>
 * --upstream-protocol https` (docs/cua-viewer-first-vm-plan.md).
 * Nothing is rewritten: a request at any other authority, loopback included,
 * is misdirected, and no header (`Host`, `X-Forwarded-*`, `Forwarded`) is
 * taken as the authority. The request's `Origin` is left as it came.
 */
function evaluation(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const refuse = (status: number, error: string) => Promise.resolve(Response.json({ error }, { status, headers: { "cache-control": "no-store" } }));
	if (closedInEvaluation(url.pathname)) return refuse(404, "Not found");
	if (url.origin !== deploymentSettings(env).publicUrl) return refuse(421, "This preview answers only at its own address.");
	return serve(request, env, ctx, { observations: watching(env), automation: previewAutomation, launchEvaluator: previewLaunchEvaluator });
}
