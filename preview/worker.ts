import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { PiModel } from "agents/harness/pi";
import { ownedCode } from "../src/auth";
import { deploymentSettings } from "../src/deployment";
import type { ImageModel } from "../src/extensions/image-generation";
import { serve } from "../src/gateway";
import { Pim as RealPim } from "../src/pim";
import { INTRODUCTION } from "../src/transcript";
import { Authenticator } from "../test/webauthn";

export { Auth, Directory, Gallery } from "../src/index";

/**
 * The Worker `pnpm preview` runs (wrangler.preview.jsonc): the real Pim, with
 * no Cloudflare account. Never deploy it. It differs from a deployment in two ways:
 *
 * - A stand-in model, so chats answer. It echoes what you say through
 *   `send_to_user`, and calls a tool when told to: `/tool create_goal {"title": "Run a 5k"}`.
 *   After a tool runs, it sends the tool's result. Memory compression gets a short summary.
 *   An agent at work on a task answers in plain text, the majordomo introduces itself with a stock greeting,
 *   and it asks the person about every approval it reviews.
 *   The utility model titles a chat with the first words of its last message, appends a
 *   line to a prompt it improves, and writes a placeholder summary. `generate_image` draws Pim's icon.
 * - `GET /__dev/sign-in/<username>?returnTo=/path` signs the browser in as
 *   that person, making the account if it's new, with a passkey made here.
 */

const PREVIEW_MODEL = "preview-model";
const MEMORY_MODEL = "preview-memory";
const UTILITY_MODEL = "preview-utility";

const textOf = (message: Message | undefined): string => {
	if (!message || message.role === "assistant") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
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
	const directive = /^\/tool\s+(\S+)\s*([\s\S]*)$/.exec(text);
	if (directive) {
		const [, name, json] = directive;
		try {
			const args = json!.trim() === "" ? {} : JSON.parse(json!);
			return fauxAssistantMessage(fauxToolCall(name!, args), { stopReason: "toolUse" });
		} catch (error) {
			return send(`That isn't JSON: ${String(error)}`);
		}
	}
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

export class Pim extends RealPim {
	/** The stand-in model, and the real ChatGPT plan, for chatting with a real model. */
	protected override models(): Models {
		const models = createModels({ credentials: this.credentials });
		models.setProvider(preview.provider);
		models.setProvider(this.chatgpt.provider());
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
	fetch(request, env, ctx): Promise<Response> {
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
		return serve(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
