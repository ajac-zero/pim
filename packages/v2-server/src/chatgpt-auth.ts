/**
 * The Runner's use of an owner's ChatGPT plan: a pi-ai credential store for the `openai` provider that reads the owner's sealed credential through the definer functions
 * of migration 0610, and refreshes it under the row's lock. pi-ai calls `modify` when a token is within minutes of expiry and double-checks inside it, so of several Runners
 * only the first refreshes; the others read what it wrote, and a rotated refresh token is never spent twice or lost.
 */
import type { Provider } from "@earendil-works/pi-ai";
import { type ChatGPTCredential, type ChatGPTOptions, chatgptContext, refreshChatGPT } from "@pim/v2-app/chatgpt";
import { type KeyringCrypto, openString, sealString } from "@pim/v2-app/crypto";
import type { Db } from "@pim/v2-runtime/db";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

export type ChatGPTRunnerOptions = ChatGPTOptions & {
	/** Where the plan's models are called, when not OpenAI's own API (a proxy; tests' fake endpoint). */
	baseUrl?: string | undefined;
};

export function chatgptCredentialStore(db: Db, crypto: KeyringCrypto, ownerId: string, options: ChatGPTRunnerOptions = {}) {
	const open = async (sealed: string | null | undefined) => (sealed ? (JSON.parse(await openString(crypto, sealed, chatgptContext(ownerId))) as ChatGPTCredential) : undefined);
	return {
		async read(): Promise<ChatGPTCredential | undefined> {
			return open((await db.read<{ s: string | null }>(ownerId, "SELECT pim_app.runner_chatgpt($1) AS s", [ownerId])).rows[0]?.s);
		},
		async modify(fn: (current: ChatGPTCredential | undefined) => Promise<ChatGPTCredential | undefined>): Promise<ChatGPTCredential | undefined> {
			return db.transaction(ownerId, async (client) => {
				const current = await open((await client.query("SELECT pim_app.runner_chatgpt_lock($1) AS s", [ownerId])).rows[0]?.s);
				const next = await fn(current);
				if (!next) return current;
				const written = (await client.query("SELECT pim_app.runner_chatgpt_put($1, $2) AS ok", [ownerId, await sealString(crypto, JSON.stringify(next), chatgptContext(ownerId))])).rows[0]?.ok;
				return written ? next : current;
			});
		},
	};
}

/** pi-ai's OpenAI provider, authenticated only by the plan. */
export function chatgptProvider(options: ChatGPTRunnerOptions = {}): Provider {
	const base = openaiProvider() as unknown as Provider;
	const oauth = {
		name: "OpenAI (ChatGPT plan)",
		isSubscription: true,
		loginLabel: "Continue with ChatGPT",
		login: async () => {
			throw new Error("Sign in to ChatGPT through Pim: POST /api/chatgpt/login");
		},
		refresh: async (credential: unknown) => refreshChatGPT(credential as ChatGPTCredential, { fetch: options.fetch, endpoints: options.endpoints, now: options.now?.() }),
		toAuth: async (credential: { access: string }) => ({ apiKey: credential.access }),
	};
	const provider = { ...base, auth: { oauth } } as unknown as Provider;
	if (!options.baseUrl) return provider;
	const baseUrl = options.baseUrl;
	const moved = (list: readonly any[]) => list.map((m) => ({ ...m, baseUrl }));
	return { ...provider, baseUrl, getModels: () => moved(base.getModels()), ...(base.getAllModels ? { getAllModels: () => moved(base.getAllModels!()) } : {}) } as unknown as Provider;
}
