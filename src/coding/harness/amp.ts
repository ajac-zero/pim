import { HARNESS_HOME } from "../vault/inject";
import { StreamJsonParser } from "./stream-json";
import type { CliHarness, HarnessTurn } from "./types";

/**
 * Amp (`amp`): Amp's CLI (npm `@ampcode/cli`), unmodified, run headless in
 * execute mode with stream-json (https://ampcode.com/docs/cli/execute-mode,
 * https://ampcode.com/docs/cli/streaming-json), which is Claude Code's, so
 * it is read with the same parser (./stream-json.ts). It signs in with the
 * person's own Amp access token in `AMP_API_KEY` (./auth.ts); the session
 * is an Amp thread, `T-…`, which later turns go on with
 * (`amp threads continue`).
 *
 * The repository is untrusted. Amp reads a project's `.amp/settings.json`,
 * which overrides the user's settings (a `--settings-file` included), loads
 * the plugins in its `.amp/plugins/`, and starts the MCP servers its skills
 * bring (an `mcp.json` beside a skill's `SKILL.md`), all without asking. So the
 * workspace image installs Amp's managed settings
 * (workspace-agentd/amp-managed-settings.json, at
 * /etc/ampcode/managed-settings.json), the one file that wins over a
 * project's: no MCP server starts, whoever configured it; no web tools,
 * which would fetch from Amp's servers past the workspace's egress
 * allowlist; no updates. A project's plugins can't be turned off: they run,
 * like the agent's shell commands, inside the workspace, with the token in
 * their environment (../../../docs/coding-amp.md).
 *
 * Permissions: the workspace is a gVisor sandbox of the thread's own with an
 * egress allowlist, and the work is reviewed as a diff before anything is
 * pushed, so the managed settings let every tool run without asking
 * (`amp.dangerouslyAllowAll`), as nobody is there to answer.
 */

/** The CLI's flags that are the same every turn: stream-json, and nothing that reaches past the workspace's own process. */
export const AMP_FLAGS: readonly string[] = ["--stream-json", "--no-ide", "--no-notifications", "--no-color", "--no-remote-control-terminal", "--no-archive-after-execute"];

/** Amp's own modes, which pick its model, prompt and tools; a thread's model names one, otherwise AMP_DEFAULT_MODE applies. */
export const AMP_MODES = ["low", "medium", "high", "ultra"] as const;
/** Default mode to use when a new Amp thread has no mode in its profile. Amp's own default is the last-used mode. */
export const AMP_DEFAULT_MODE = "medium";

/** Where Amp (a Bun binary) may unpack and dlopen its addon: the sandbox's /tmp is noexec, the workspace volume is not. Outside the checkout (`repo/`). */
/** Makes a thread continuable again; its failure (not archived, unknown) is ignored by the `;` that follows it. */
const unarchive = (id: string) => {
	if (!/^[\w-]+$/.test(id)) throw new Error("Amp thread ids are letters, digits and dashes");
	return `amp threads archive ${id} --unarchive >/dev/null 2>&1`;
};
export const AMP_TMPDIR = `${HARNESS_HOME}/.cache/amp-tmp`;

/** The CLI's log, named by the session so the turn's process can be found by it. */
export const ampLogFile = (sessionId: string) => `${HARNESS_HOME}/.cache/amp/logs/pim-${sessionId}.log`;

/** What the CLI says, on its error output or in a failed result, when its token is missing, wrong or revoked. */
const LOGIN_FAILURE = /invalid or missing api key|run 'amp login'/i;

export const amp: CliHarness = {
	id: "amp",
	name: "Amp",
	buildCommand(turn: HarnessTurn): string[] {
		const mode = turn.model?.toLowerCase() ?? null;
		if (mode !== null && !(AMP_MODES as readonly string[]).includes(mode)) throw new Error(`Amp has no mode "${turn.model}": ask for ${AMP_MODES.join(", ")}`);
		return [
			// The `amp` binary is a Bun single-file executable that unpacks a native addon into the temp dir and dlopens
			// it; the sandbox's /tmp is `noexec`, so that fails (ERR_DLOPEN_FAILED). AMP_TMPDIR (below) is an exec-allowed
			// directory on the workspace volume, outside the checkout, created here.
			"sh",
			"-c",
			// A continued thread may be archived (an older run, or Amp's own default after `--execute`): unarchive it
			// first, ignoring failure (it may not be archived), so `continue` never stops at "archived and cannot be continued".
			turn.resume ? `mkdir -p "$TMPDIR" && ${unarchive(turn.sessionId)}; exec "$@"` : 'mkdir -p "$TMPDIR" && exec "$@"',
			"amp",
			"amp",
			...(turn.resume ? ["threads", "continue", turn.sessionId] : []),
			...AMP_FLAGS,
			// Amp names a new thread itself, after it starts; this puts the id Pim gave the turn on its command line, so
			// `signalCommand` finds a first turn's process too.
			"--log-file",
			ampLogFile(turn.sessionId),
			// A new thread is the person's alone on ampcode.com, whatever their workspace shares by default; its mode is
			// fixed with it. When no mode is named, pass medium explicitly so threads stay on predictable modes.
			...(turn.resume ? [] : ["--visibility", "private", ...(mode ? ["--mode", mode] : ["--mode", AMP_DEFAULT_MODE])]),
			// Joined to its flag, so a prompt that starts with a dash is never read as one. Pim's instructions open the
			// thread's first message: Amp has no flag for them, and nothing is written into the checkout.
			`--execute=${turn.resume ? turn.prompt : `<instructions from="Pim">\n${turn.instructions}\n</instructions>\n\n${turn.prompt}`}`,
		];
	},
	parser: (turn) => new StreamJsonParser({ provider: "amp", model: turn.model ?? "amp", loginFailure: LOGIN_FAILURE }),
	reportsCost: false,
	shellTool: "shell_command",
	// The managed settings turn update checks off too; this also stops the check `amp update` would make.
	env: { AMP_SKIP_UPDATE_CHECK: "1", TMPDIR: AMP_TMPDIR, BUN_TMPDIR: AMP_TMPDIR },
	// ampcode.com: the API, its threads and inference; `*.ampcode.com` (subdomains only, as the egress proxy reads it):
	// static.ampcode.com and Amp's other hosts.
	egress: ["ampcode.com", "*.ampcode.com"],
	signalCommand: (sessionId, signal) => ["pkill", `-${signal}`, "-f", sessionId],
	// When Pim's coding thread ends, the Amp thread leaves the person's list on ampcode.com; a later turn unarchives it (above).
	archiveCommand: (sessionId) => ["amp", "threads", "archive", sessionId],
	loginFailure: LOGIN_FAILURE,
	apiKeyEnv: "AMP_API_KEY",
};
