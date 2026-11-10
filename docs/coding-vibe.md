# Mistral Vibe threads

A coding thread started with `harness: "mistral-vibe"` is run by Mistral's `vibe` CLI, unmodified, inside the thread's own workspace, signed in with the person's own Mistral API key. It is the third CLI harness, after Claude Code and Codex, and goes through the same framework: [coding-claude-code.md](coding-claude-code.md) explains the runner, steering, aborts, restarts and the vault. This page covers what is Vibe's own: its command, its output, what it costs, and the image.

Everything below was checked against Vibe 3.1.0 (`mistral-vibe` on PyPI, Apache-2.0), by reading the installed package, and by running it in the workspace image built from this repository, through Pim's own runner and adapter, against a mock of Mistral's chat completions API. No real Mistral key was used: a key Mistral refused was tried against the real `api.mistral.ai`.

## The command

```sh
/bin/sh -c '<make the run directory, write AGENTS.md and prompt.md, exec "$@">' vibe \
  /workspace/.pim-vibe/<session> '<Pim's instructions>' '<prompt>' \
  vibe --output streaming --auto-approve --workdir /workspace/repo \
  --output-dir /workspace/.pim-vibe/<session>/out \
  [--resume <session> | --model <alias>] --max-price <left> \
  --prompt-file /workspace/.pim-vibe/<session>/prompt.md
```

`vibe --help` of 3.1.0 lists every one of these flags. Why each:

- **A run directory of its own.** The shell removes `/workspace/.pim-vibe/<session>/` and makes it again, writes Pim's instructions to `home/AGENTS.md` and the prompt to `prompt.md`, and `exec`s Vibe with `VIBE_HOME` set to `home/`. So every run starts from a new Vibe home holding nothing but Pim's instructions (below), and `exec` makes the process Pim signals Vibe's own. The directory is outside the checkout, so it never shows in the diff, and the parser removes it once the run has ended. `<session>` is the id the turn started with: one Pim made for a first turn, Vibe's own afterwards.
- **`--output streaming`**: one JSON object a line on stdout, each an entry of the session's history (below). Vibe's warnings go to stderr.
- **`--output-dir`**: Vibe writes `export.json` there on every exit but a kill: how the run ended, its tokens and its cost, which stdout doesn't carry. It also copies the session's journal there.
- **`--auto-approve`** approves every tool call. Without it, a headless run denies every call that would ask, since nobody can answer (the `denied` fixture). The workspace is a gVisor sandbox of the thread's own with an egress allowlist, holding no credential but the API key, and every change is reviewed as a diff before it is pushed, as for Claude Code's `Bash` and Codex's `danger-full-access`.
- **`--resume <session>`** on every turn after the first, with the session id Vibe printed. Vibe refuses `--model` on a resumed session ("--model only applies to a new session"), so the model is asked for only on a new session: `--model <alias>` when the thread's profile names one (`{ providerId: "mistral-vibe", model }`). It is an alias of Vibe's config; the default config has only `mistral-medium-3.5`, and an unknown one fails the turn ("Unknown model: … Available: …").
- **`--max-price`**: the budget left, rounded down to the cent. Vibe checks it after each model answer, so a run can go past it by one answer; it then ends `price_limit`, cancelling the tool call it hadn't run, and the turn ends with `stateReason: "budget"`. `--max-price 0` stops after the first answer; it doesn't mean no limit.
- **`--prompt-file`**: the prompt is read from a file, so a prompt that starts with a dash is never read as a flag, and the prompt isn't on Vibe's command line.
- **No `--trust`** (below).

**Pim's instructions** go in the new home's `AGENTS.md`, which Vibe adds to its system prompt as the user's own instructions, after its own. `--system-prompt-file` isn't used: it replaces Vibe's own instructions for coding (its instruction hierarchy, its rules for git, its working and communication defaults), keeping only its tool sections, as the system prompt the mock received showed. The instructions also say that the repository's AGENTS.md files weren't loaded, since the checkout isn't trusted, and to read the ones that apply.

**Environment** (`mistralVibe.env`), Vibe's `VIBE_*` settings, which override its config files, the person's or the project's:

| Variable | Why |
| --- | --- |
| `VIBE_SESSION_LOGGING__SAVE_DIR=/workspace/.vibe-sessions` | Sessions are kept apart from the new home each run gets, on the workspace's volume, so `--resume` finds them. |
| `VIBE_ENABLE_MCP=false`, `VIBE_ENABLE_CONNECTORS=false` | No MCP servers and none of Mistral's connectors (Vibe asked `/v1/connectors/bootstrap` without it). |
| `VIBE_ENABLE_SUBAGENTS=false` | No subagents: the export doesn't count their cost in the run's (below). |
| `VIBE_DISABLED_SKILLS=["*"]` | No skills of the person's own, such as `~/.agents/skills` (`/workspace/.agents`), which the agent could have written in an earlier turn. Vibe's built-in skills stay. |
| `VIBE_ENABLE_TELEMETRY=false`, `VIBE_EXPERIMENTS__ENABLE=false`, `VIBE_ENABLE_UPDATE_CHECKS=false`, `VIBE_ENABLE_AUTO_UPDATE=false`, `VIBE_SHOW_GREETING=false`, `VIBE_ENABLE_NOTIFICATIONS=false` | No telemetry, experiments, update checks or greeting, so the workspace needs no host for them. |

## An untrusted repository

Vibe reads a project's `.vibe/config.toml` (MCP servers, the default agent, any setting), `.vibe/hooks.toml` (commands run before and after tools and turns), `.vibe/agents/`, `.vibe/prompts/`, `.vibe/skills/` and `.agents/skills/`, and its AGENTS.md files, only for a trusted folder. A headless run trusts none it isn't told to: it prints "Warning: /workspace/repo is not trusted; project configuration (.agents/, .vibe/, AGENTS.md) will be ignored" (which Pim records as a notice) and goes on. Vibe has no setting that turns hooks off, so not trusting the checkout is what keeps a repository's hooks from running; Pim never passes `--trust`.

Checked in the image, with Pim's command, on a checkout holding all of the above, each of which would touch a file when it ran, and `.mcp.json` too: none ran, and the system prompt had none of its skills or its AGENTS.md. The same command with `--trust` added ran the repository's hooks and loaded its AGENTS.md, which shows the check would have seen them. Its MCP server didn't start even then, as `VIBE_ENABLE_MCP=false` overrides the project's config.

What the agent can write outside the checkout for a later turn is kept out the same way: a `config.toml`, `hooks.toml` or MCP server in `/workspace/.vibe` (Vibe's default home), and a skill in `/workspace/.agents/skills`, were each left in the workspace in the same check, and none was used, as every run gets a new home and the environment above.

Two things are left as they are. Vibe asks `chat.mistral.ai` for the managed config of the key's organization, which the egress allowlist refuses; Vibe goes on without it (checked with a proxy that refuses every host). And the session store in `/workspace/.vibe-sessions` is writable by the agent, as everything in the workspace is: it holds the conversation, not configuration.

## Its output

`VibeStreamParser` in `src/coding/harness/vibe.ts` reads one history entry a line. Each carries the session's id (`sessionId`). Vibe prints an entry when it is complete, not as it is written, so the web app shows a Vibe message when it is done, and a tool call once it has finished, with its result; there are no deltas.

| Vibe prints | Pim makes of it |
| --- | --- |
| any entry's `sessionId`, the first time | the session, kept for `--resume` |
| `message`, `role: "assistant"` | assistant text; one whose `outcome` is `discarded` is skipped |
| `message`, `role: "user"` | nothing: the thread wrote the person's message itself |
| `reasoning` | thinking |
| `effect` (a tool call), once `completed`, `failed`, `cancelled` or `skipped` | a tool call named as Vibe names it (`file_system.bash`, `file_system.edit`, `grep`, …) with its input, and its result: the output, or what it did when it printed nothing ("Edited greet.js"), the error, or why it was cancelled ("client interrupt") |
| `callback` with an approval answered `deny` or `cancel_turn` | a refused tool (`harness.permission_denied`) |
| `callback` asking the person a question | a notice |
| `notice` | a notice (`harness.notice`) |
| anything else, such as `checkpoint` | nothing |

`file_system.bash` is the shell tool: a call of it that runs tests is a test run. Vibe says whether a command succeeded, not its exit code, so a failing test run is recorded with exit code 1. A `grep` run through bash is shown by Vibe as a search (`grep`, with its pattern), not a command.

## What a run cost

Vibe prints no tokens or cost on stdout. Its `export.json` has the run's outcome, its `usage` (`input_tokens`, which include `cached_input_tokens`, and `output_tokens`), `cost_usd`, as Vibe estimates it from the model's prices in its config, and `session_id`. Both count that run alone, also when it resumed a session. The parser reads the export once the CLI has exited (`HarnessParser.finish`, which the runner calls with the workspace's files, read with the key taken out as Vibe's output is), and the model the session ran from the copy of its journal there, since the export's config leaves it unresolved unless it was pinned.

The thread counts every CLI's cost as how much the session's grew since the turn started (`coding_harness_session`), so the parser adds the run's cost and tokens to what the thread recorded before the turn (`HarnessTurn.sessionBefore`): its `result` has the session's whole cost, and a `usage` event the session's whole tokens, cached input apart. A turn's `model_call` is then that run's cost and tokens, and the thread's spend and budget grow by it, as the `a Mistral Vibe thread` test checks across a resume.

The export's outcome is how the turn ends:

| `outcome` | The turn |
| --- | --- |
| `finished` | completed |
| `price_limit` | `budget` |
| `turn_limit` | `max_turns` (Pim sets no `--max-turns`) |
| `config_error` with `invalid_api_key`, or "Missing MISTRAL_API_KEY" | `login_required`: the thread waits for the person to connect Vibe again |
| `usage_error` "Session not found" | `harness_error` with no session, so the thread lets the session go and the next turn starts a new one |
| `infrastructure_failure`, `terminated`, any other | `harness_error`, with Vibe's error, or "Mistral Vibe stopped: terminated" |

An abort or a timeout ends the turn `aborted` or `timeout` whatever the export says, but what the run cost until then is still counted. A run that was killed leaves no export: its cost isn't known and isn't counted. Subagents are off, since the export counts their tokens and cost apart from the run's, over the child's whole life.

## Stopping a turn

Abort, a time limit and a stall send SIGINT with `pkill -INT -f /workspace/.pim-vibe/<session>/out`: the output directory is on Vibe's command line, and only there, once the shell has `exec`ed Vibe. Its Python app server, which Vibe starts, names itself `vibe-app-server`. SIGINT during a long shell command stopped Vibe in under half a second on the orb, and in the image well within the runner's 15 s grace: it cancelled the command, killed it, wrote its export (`terminated`, with what the run had cost) and exited 3.

**Steering** is the next turn, as for the other CLIs: one process per turn, resuming the session.

## Signing in

With the person's Mistral API key only: `apiKeyEnv: "MISTRAL_API_KEY"`, from the coding vault, in Vibe's environment, never on its command line; the runner takes it out of everything Vibe prints and every file the parser reads ([coding-api.md](coding-api.md)). Vibe reads the variable before `~/.vibe/.env`, which the new home doesn't have. Its experimental browser sign-in isn't used. A key Mistral refuses ends the run `config_error`, `invalid_api_key` ("Invalid API key (from env var MISTRAL_API_KEY). Please check your API key and try again."), as the real `api.mistral.ai` answered a made-up key.

## Egress

A `mistral-vibe` thread's workspace may reach what every coding thread may, plus `api.mistral.ai`: the model, and Vibe's check of the model (`GET /v1/models/<name>`). With the environment above, the only other host Vibe tried, through a proxy that logged and refused every host, was `chat.mistral.ai` (the organization's managed config, above). Without it, Vibe also tried `experiments.mistral.services` (its experiments), `console.mistral.ai`, and `api.mistral.ai` for telemetry (`/v1/datalake/events`), connectors and `/v1/users/me`.

## Files

- `/workspace/.pim-vibe/<session>/`: the run's home, prompt and output directory, made anew by each run and removed after it.
- `/workspace/.vibe-sessions/`: Vibe's sessions, kept on the workspace's volume for `--resume`.

Nothing is written to the checkout.

## The workspace image

`workspace-agentd/Dockerfile` installs Vibe, pinned by `ARG VIBE_VERSION=3.1.0`, with uv, pinned by `ARG UV_VERSION=0.12.9` (from its image, `ghcr.io/astral-sh/uv`). Vibe needs Python 3.12 or later and the image's Debian bookworm has 3.11, so uv installs Vibe with a Python of its own (3.12) in a stage of its own, under `/opt/vibe`; the image copies `/opt/vibe` and links `/usr/local/bin/vibe` into it, and keeps no uv and no caches. The build runs `vibe --version`. The stage works with Docker's legacy builder as well as BuildKit.

`/opt/vibe` is about 485 MB: Vibe's Rust front end (`vibe-rs`, 162 MB, which the `vibe` command `exec`s), its native harness (67 MB), the Python (104 MB), and the bytecode compiled at install (40 MB): `/opt` isn't writable by the workspace's user, so without it Python would compile Vibe's modules again on every turn.

It was built on an orb with Docker: `docker build -t pim-workspace:local workspace-agentd` succeeded and printed `vibe 3.1.0`.

To roll it out on the sandbox host, from the repository's checkout there (here `~/pim-src`) with this change in it, in the same environment the stack was first started with (`MANAGER_TOKEN`, `PROXY_ADMIN_TOKEN` and `AGENTD_TOKEN_SECRET` exported or in `sandbox-manager/.env`):

```sh
cd ~/pim-src && git pull && cd sandbox-manager && docker compose up -d --build
docker run --rm --entrypoint vibe pim-workspace:local --version     # vibe 3.1.0
docker run --rm --entrypoint codex pim-workspace:local --version    # codex-cli 0.167.0
```

`up -d --build` rebuilds `pim-workspace:local` from `../workspace-agentd` (the `workspace-image` service) and recreates the containers whose image changed. `git pull` brings the change once it is on the branch the checkout follows; before that, `git fetch origin && git checkout review/coding-h2-vibe`. Workspaces that already exist keep the image they were made with; a thread gets the new one with its next workspace. If `ALLOWED_IMAGES` pins the image by digest, put the new digest there.

To move to a newer Vibe, change `VIBE_VERSION`, rebuild, and check `vibe --help` for the flags above, the untrusted checkout (a repository's hooks must not run), the `VIBE_*` settings (`vibe config schema`), and a run's output and export against `src/coding/harness/vibe.ts` and `test/fixtures/vibe/`.

## How it was checked

The fixtures in `test/fixtures/vibe/` are real: the real `vibe` in the image, run by Pim's `HarnessRunner` with this adapter's command and environment, through a workspace that was `docker exec` in a container of the image, against a small mock of Mistral's chat completions API (streamed and not) on the host, with only `VIBE_PROVIDERS` added to point the `mistral` provider at it. The mock answered with thinking, text and tool calls (bash, a grep, an edit), and with an API error, a price large enough to pass the budget, and a slow command to interrupt. The turn's tests really ran in the checkout: `npm test` failed, the edit fixed it, and it passed. `auth` is the real `api.mistral.ai` refusing a made-up key. Each fixture went through the runner to the result the thread would see: completed, `budget`, `harness_error`, `aborted` (by the runner's own SIGINT), `login_required`, and a session Vibe doesn't have. The Worker tests read those fixtures (`test/coding-harness.test.ts`), and run a thread on them through two turns, the second resuming the first's session (`test/coding-thread-do.test.ts`).

## Not yet verified

- A real turn with a real key: what Mistral's own model streams (its thinking, its tool call ids, a refusal), the real cost of a turn, and how close `--max-price` stops with real prices.
- Whether `cost_usd` counts compaction, which Vibe does on long sessions; the export says that `steps` doesn't.
- Vibe under gVisor with the workspace's limits (`/tmp` is a 64 MiB `noexec` tmpfs there), and the egress proxy refusing `chat.mistral.ai` (checked only with a local proxy that refuses).
- Tools reached through `run_typescript`, and their entries.
- `docker compose up -d --build` on the sandbox host.
