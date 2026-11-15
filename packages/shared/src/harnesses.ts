/**
 * The coding harnesses whose sign-ins the vault keeps (./vault.ts): the
 * unmodified vendor CLIs that run inside a person's own workspace, signed
 * in as that person in one of two ways.
 *
 * - With a subscription, through the CLI's own login flow (Claude Code,
 *   Codex). Pim never reads what the CLI writes; it keeps the files below
 *   as one encrypted, opaque archive per person and harness, and puts them
 *   back only in that person's later workspaces.
 * - With an API key the person gives Pim (Mistral Vibe, Amp). The vault
 *   keeps the key, encrypted the same way, and a run hands it to the CLI in
 *   its environment, only in that person's own workspaces. No route ever
 *   returns it.
 *
 * This file has no imports, so the web app can show the same disclosures.
 */

/** The harnesses, by the id the vault and its API use. */
export const HARNESSES = ["claude-code", "codex", "mistral-vibe", "amp"] as const;

export type Harness = (typeof HARNESSES)[number];

/** Internal vault entry for optional Amp HTTP usage; not a Connect field. */
export type CodingVaultKey = Harness | "amp-http-m2m";

export function isHarness(value: unknown): value is Harness {
	return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/** The harnesses that sign in with an API key the person gives Pim, rather than the CLI's own login. */
export const API_KEY_HARNESSES = ["mistral-vibe", "amp"] as const;

export type ApiKeyHarness = (typeof API_KEY_HARNESSES)[number];

/** The harnesses that sign in through the CLI's own login, whose files the vault keeps. */
export type LoginHarness = Exclude<Harness, ApiKeyHarness>;

export function isApiKeyHarness(value: unknown): value is ApiKeyHarness {
	return typeof value === "string" && (API_KEY_HARNESSES as readonly string[]).includes(value);
}

export function isLoginHarness(value: unknown): value is LoginHarness {
	return isHarness(value) && !isApiKeyHarness(value);
}

/**
 * Where each harness keeps its login, and the only files of it the vault
 * keeps. `dir` is the CLI's config directory, relative to the workspace's
 * home, and `env` the variable that points the CLI at it, which a harness
 * run sets so the CLI finds it wherever the backend puts `HOME`. `files` are
 * paths relative to `dir`: the login and the CLI's own settings, never its
 * caches, session logs, project history or shell snapshots.
 */
export const HARNESS_FILES: { readonly [H in LoginHarness]: { readonly dir: string; readonly env: string; readonly files: readonly string[] } } = {
	// Claude Code keeps its login in `.credentials.json` on Linux; with CLAUDE_CONFIG_DIR set, its
	// global config `.claude.json` (account and onboarding state) lives in the same directory.
	"claude-code": { dir: ".claude", env: "CLAUDE_CONFIG_DIR", files: [".credentials.json", ".claude.json", "settings.json"] },
	// Codex keeps its login in `auth.json` and its settings in `config.toml` under CODEX_HOME.
	codex: { dir: ".codex", env: "CODEX_HOME", files: ["auth.json", "config.toml"] },
};

/**
 * What an API key for each harness looks like: what it starts with, if
 * anything, and the page where the person makes one.
 */
export const HARNESS_API_KEYS: { readonly [H in ApiKeyHarness]: { readonly prefix: string; readonly url: string } } = {
	// Mistral's keys are made in its console, under API Keys; Vibe reads one from MISTRAL_API_KEY.
	"mistral-vibe": { prefix: "", url: "https://console.mistral.ai/api-keys" },
	// Amp's access tokens are made in its settings and start with `sgamp_`; the CLI reads one from AMP_API_KEY.
	amp: { prefix: "sgamp_", url: "https://ampcode.com/settings" },
};

/** The shortest and longest API key the vault takes. */
export const API_KEY_MIN_LENGTH = 16;
export const API_KEY_MAX_LENGTH = 512;

/**
 * The characters an API key may have: letters, digits and `._~+/=-`, which
 * no JSON encoder escapes, so the runner finds the key in what a CLI prints
 * to take it out (../harness/runner.ts). No whitespace or control
 * characters.
 */
const API_KEY_CHARACTERS = /^[A-Za-z0-9._~+/=-]+$/;

/** What is wrong with `apiKey` as a key for `harness`, or null when it looks right. The answer never quotes the key. */
export function apiKeyProblem(harness: ApiKeyHarness, apiKey: unknown): string | null {
	if (typeof apiKey !== "string" || apiKey === "") return "Enter the API key";
	if (apiKey.length < API_KEY_MIN_LENGTH || apiKey.length > API_KEY_MAX_LENGTH) return `An API key is ${API_KEY_MIN_LENGTH} to ${API_KEY_MAX_LENGTH} characters long`;
	if (!API_KEY_CHARACTERS.test(apiKey)) return "An API key has only letters, digits and . _ ~ + / = -, with no spaces";
	const { prefix } = HARNESS_API_KEYS[harness];
	if (!apiKey.startsWith(prefix)) return `This key should start with ${prefix}`;
	return null;
}

/**
 * The vault's API, under `/api`: `GET` lists each harness's status, `GET`
 * and `DELETE` on `/<harness>` read one or disconnect it, and `PUT` on
 * `/<harness>/api-key` stores an API-key harness's key.
 */
export const CODING_VAULT_PATH = "/coding/vault";

/**
 * What the API says of a person's login or API key for a harness; never
 * what it holds. `byteLength` is the size of the login Pim keeps, and null
 * for an API key, whose length isn't said either.
 */
export type HarnessLoginStatus = {
	readonly harness: Harness;
	readonly connected: boolean;
	readonly updatedAt: number | null;
	readonly byteLength: number | null;
};

/** What a person reads and accepts before signing a harness in with their subscription or an API key. */
export type HarnessDisclosure = { readonly title: string; readonly paragraphs: readonly string[] };

export const HARNESS_DISCLOSURES: { readonly [H in Harness]: HarnessDisclosure } = {
	"claude-code": {
		title: "Use your Claude subscription with Claude Code",
		paragraphs: [
			"You sign in to the real Claude Code CLI, with its own login, inside your own sandbox. Pim never sees your password and never uses your login itself.",
			"Pim keeps the CLI's configuration, including its login, as an encrypted file it does not open, and puts it back only into your own coding sessions. Disconnect at any time to delete it.",
			"One person per login: don't share your login with anyone or pool it with other people's.",
			"Anthropic's terms may restrict using a subscription login in a hosted service like this one. You accept that risk by connecting. You can use an Anthropic API key instead.",
		],
	},
	codex: {
		title: "Use your ChatGPT plan with Codex",
		paragraphs: [
			"You sign in to the real Codex CLI, with its own login, inside your own sandbox. Pim never sees your password and never uses your login itself.",
			"Pim keeps the CLI's configuration, including its login (auth.json), as an encrypted file it does not open, and puts it back only into your own coding sessions. Disconnect at any time to delete it.",
			"One person per login: don't share your login with anyone or pool it with other people's.",
			"OpenAI says to treat auth.json like a password, and not to use a ChatGPT login with public or open-source repositories. You can use an OpenAI API key instead.",
		],
	},
	"mistral-vibe": {
		title: "Use your Mistral API key with Mistral Vibe",
		paragraphs: [
			"The real Mistral Vibe CLI runs inside your own sandbox with an API key of yours. What it does is billed to your Mistral account.",
			"Pim keeps the key encrypted and gives it, through the CLI's environment, only to your own coding sessions. It is never shown again, not even to you.",
			"Disconnect at any time to delete it. To stop the key working anywhere, revoke it in the Mistral console too.",
			"One person per key: don't share your key with anyone or pool it with other people's.",
		],
	},
	amp: {
		title: "Use your Amp access token with Amp",
		paragraphs: [
			"The real Amp CLI runs inside your own sandbox with an access token of yours. What it does is billed to your Amp account.",
			"While it runs, code in the repository it works on, such as its tests or an Amp plugin it brings, can read the token and use it on ampcode.com as you could. Use a token you keep for this, and work only on repositories you trust.",
			"Pim keeps the token encrypted and gives it, through the CLI's environment, only to your own coding sessions. It is never shown again, not even to you.",
			"Disconnect at any time to delete it. To stop the token working anywhere, revoke it in your Amp settings too.",
			"One person per token: don't share your token with anyone or pool it with other people's.",
		],
	},
};
