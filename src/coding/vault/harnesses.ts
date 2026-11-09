/**
 * The coding harnesses whose logins the vault keeps (./vault.ts): the
 * unmodified vendor CLIs that run inside a person's own workspace, signed
 * in with that person's own subscription through the CLI's own login flow.
 * Pim never reads what the CLI writes; it keeps the files below as one
 * encrypted, opaque archive per person and harness, and puts them back
 * only in that person's later workspaces.
 *
 * This file has no imports, so the web app can show the same disclosures.
 */

/** The harnesses, by the id the vault and its API use. */
export const HARNESSES = ["claude-code", "codex"] as const;

export type Harness = (typeof HARNESSES)[number];

export function isHarness(value: unknown): value is Harness {
	return typeof value === "string" && (HARNESSES as readonly string[]).includes(value);
}

/**
 * Where each harness keeps its login, and the only files of it the vault
 * keeps. `dir` is the CLI's config directory, relative to the workspace's
 * home, and `env` the variable that points the CLI at it, which a harness
 * run sets so the CLI finds it wherever the backend puts `HOME`. `files` are
 * paths relative to `dir`: the login and the CLI's own settings, never its
 * caches, session logs, project history or shell snapshots.
 */
export const HARNESS_FILES: { readonly [H in Harness]: { readonly dir: string; readonly env: string; readonly files: readonly string[] } } = {
	// Claude Code keeps its login in `.credentials.json` on Linux; with CLAUDE_CONFIG_DIR set, its
	// global config `.claude.json` (account and onboarding state) lives in the same directory.
	"claude-code": { dir: ".claude", env: "CLAUDE_CONFIG_DIR", files: [".credentials.json", ".claude.json", "settings.json"] },
	// Codex keeps its login in `auth.json` and its settings in `config.toml` under CODEX_HOME.
	codex: { dir: ".codex", env: "CODEX_HOME", files: ["auth.json", "config.toml"] },
};

/** The vault's API, under `/api`: `GET` lists each harness's status, `GET` and `DELETE` on `/<harness>` read one or disconnect it. */
export const CODING_VAULT_PATH = "/coding/vault";

/** What the API says of a person's login for a harness; never what it holds. `byteLength` is the size Pim keeps. */
export type HarnessLoginStatus = {
	readonly harness: Harness;
	readonly connected: boolean;
	readonly updatedAt: number | null;
	readonly byteLength: number | null;
};

/** What a person reads and accepts before signing a harness in with their subscription. */
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
};
