# Amp threads

A coding thread started with `harness: "amp"` is run by Amp's `amp` CLI, unmodified, inside the thread's own workspace, signed in with the person's own Amp access token. It is the third CLI harness, after Claude Code and Codex, and goes through the same framework: [coding-claude-code.md](coding-claude-code.md) explains the runner, steering, aborts, restarts and the vault. This page covers what is Amp's own: its command, how an untrusted repository is kept from configuring it, its events, its token, what it costs, and the image.

Everything below was checked against `@ampcode/cli` 0.0.1794240032-ga42e06 (npm's `latest` on 2026-11-09; the old `@sourcegraph/amp` package is now an alias of it), its `--help`, Amp's docs (execute mode, streaming JSON, configuration, plugins, MCP), and by running the CLI in the workspace image built from this repository with a fake token against a local stand-in for ampcode.com. No run has been made with a real token: see [What is verified](#what-is-verified).

## The command

```sh
amp [threads continue <T-thread>] --stream-json --no-ide --no-notifications --no-color \
  --no-remote-control-terminal --log-file /workspace/.cache/amp/logs/pim-<session>.log \
  [--visibility private [--mode low|medium|high|ultra]] --execute=<prompt>
```

with `AMP_API_KEY` (the person's token) and `AMP_SKIP_UPDATE_CHECK=1` in its environment, run in `/workspace/repo` with `HOME=/workspace`. Why each part:

- **`--execute=<prompt>` with `--stream-json`**: execute mode runs one turn and exits; stream-json prints each message as a JSON line. The prompt is joined to its flag, so one that starts with a dash is still the prompt: `-x "-rf …"` fails with "unknown option", while `--execute=-rf …` is read as the message (checked in the CLI's log). `--` doesn't end Amp's options. agentd closes the command's stdin at once, so nothing is added from it.
- **`threads continue <T-thread>`** on every turn after the first: the session is the Amp thread (`T-…`) the first turn's `init` named. A new thread is made by execute mode itself, archived when the command ends (Amp's default), and continued like any other; continuing an archived thread is documented but not yet run here.
- **`--visibility private`** on a new thread: it is the person's alone on ampcode.com, whatever their Amp workspace shares by default.
- **`--mode`** when the thread's profile names one of Amp's modes (`{ providerId: "amp", model: "high" }`); any other name fails the turn before it starts, as the shell tool's name below holds for these modes only. Without one, Amp's default. The mode is fixed when the thread is made, so a continued thread isn't given one again.
- **`--log-file …/pim-<session>.log`**: Amp names a new thread itself, after it starts, so this puts the id Pim gave the turn on its command line, where `pkill -INT -f <id>` finds a first turn's process. A later turn continues Amp's own thread id, which is on its command line anyway. The npm package installs the native binary as `amp` itself, so the signal reaches the CLI. During startup the CLI exits 130 on SIGINT with no output (checked); what it prints when interrupted mid-turn is not known, and the turn ends `aborted` either way.
- **`--no-ide`, `--no-notifications`, `--no-color`**: no IDE connection, sounds or colour codes. **`--no-remote-control-terminal`**: ampcode.com can't open a terminal into the workspace through the CLI.
- **`AMP_SKIP_UPDATE_CHECK=1`**: no update checks; the managed settings below turn them off too.
- **Pim's instructions** (`cliInstructions`) open the thread's first message, inside `<instructions from="Pim">…</instructions>`: Amp has no flag for a system prompt, and writing an `AGENTS.md` would change the checkout. The thread keeps them, so later turns don't repeat them. The transcript in Pim shows the person's own words; the thread on ampcode.com shows the instructions too.

**Steering.** One process per turn, as for Claude Code and Codex: a steer waits and becomes the next turn, which continues the thread. Amp can also take several messages in one process (`--stream-json-input`, with `steer: true` to queue one at the next interruption point), but the runner's turn is one command whose end is the turn's end: its checkpoint, its cost and its result. A process that outlives turns would have no such end, and a restart of the thread would lose messages written to its stdin.

## An untrusted repository

Amp reads more from a project than Claude Code or Codex, and runs some of it without asking:

| What the repository has | What Amp does | What Pim does |
| --- | --- | --- |
| `.amp/settings.json` | Merges it over the user's settings, `--settings-file` included: for the same key, the project wins (checked: a project's `amp.mcpPermissions` allow rule undid one from `--settings-file`) | Amp's managed settings, the one file that wins over a project's (below) |
| MCP servers in `.amp/settings.json` | Waits for approval (`amp mcp approve`), which nobody gives (checked: "awaiting approval") | Rejected by the managed settings too |
| A skill (`.agents/skills/<name>/SKILL.md`) with an `mcp.json` | Starts its MCP server at once, as if it were the user's (checked: the server ran) | Rejected by the managed settings (checked: "MCP server is not allowed by MCP permissions", even with the project allowing it) |
| Plugins in `.amp/plugins/` | Loads and runs them at startup, in a child process of the CLI with its environment, `AMP_API_KEY` included (checked) | **Can't be turned off** (below) |
| Skills, `AGENTS.md` | Reads them as instructions | Nothing: they run nothing by themselves |

**Managed settings.** The workspace image installs [`workspace-agentd/amp-managed-settings.json`](../workspace-agentd/amp-managed-settings.json) as `/etc/ampcode/managed-settings.json`, root's and read-only to the workspace. Amp documents that managed settings take precedence over local ones (for a list, its entries come first), and the CLI reports loading it ("managedSettings.file loaded", 5 keys, no errors). It sets:

- `amp.mcpPermissions`: reject every local (`command`) and remote (`url`) MCP server. The first matching rule applies, and the managed ones come first, so a project's allow rules don't reach any server. The `url` rule is meant for remote servers, such as those saved on the person's Amp account, which act on services past the workspace's egress allowlist; that one couldn't be seen working without a token.
- `amp.tools.disable`: `read_web_page` and `web_search`, which fetch from Amp's servers, past the egress allowlist; Claude Code's are refused the same way. Not verifiable without a token: `amp tools list` ignores `amp.tools.disable` from any settings file.
- `amp.dangerouslyAllowAll`: every tool runs without asking, since nobody is there to answer; Amp's built-in rules otherwise ask before, for example, `rm -rf`, a shell loop or `git push`. A project can still add rules that reject tools, which only makes the agent do less. Not verifiable without a token either: `amp permissions test` doesn't apply it.
- `amp.updates.mode: "disabled"` and `amp.notifications.enabled: false`.

**Plugins can't be turned off.** Amp has no setting for it, and the CLI ignores `AMP_DISABLE_PLUGINS` outside its development builds ("Ignoring AMP_DISABLE_PLUGINS outside development"). A repository's plugin runs with the CLI, inside the workspace, under the same sandbox policy as the agent's shell commands: gVisor, the egress allowlist, no credential but the token. It is no more than the repository's own tests, which the agent runs anyway, can do. What it can do that a plugin elsewhere couldn't is use the token: it is in the environment of the CLI, its plugins and the commands the agent runs, and `ampcode.com` is reachable. With it, such code can do on ampcode.com what the person's token allows, such as start threads in an Amp orb, which run outside the workspace and are billed to the person. The person's own plugins and skills on their Amp account load as well; those are theirs. The Connect panel says this before the token is saved (`HARNESS_DISCLOSURES`), and asks for a token kept for this.

## Its events

Amp's stream-json is Claude Code's, read by the same parser (`StreamJsonParser` in `src/coding/harness/stream-json.ts`), with these differences:

| Amp prints | Pim makes of it |
| --- | --- |
| `system` `init` with `session_id` `T-…` and `agent_mode` | the session (Amp's thread), and the mode as the messages' model |
| `assistant` messages, whole, with `usage` and no `id` | messages and their tokens, each line one model response; no text as it is written |
| tool calls: `shell_command` (`{ command }`), `edit_file`, `create_file`, `apply_patch`, `Task`, … | tool calls under Amp's own names; `shell_command`'s that run tests are test runs (`shellTool`) |
| `assistant`/`user` with `parent_tool_use_id` | nothing: a subagent's messages stay out of the transcript, and its tokens out of the count; what it found is its `Task` call's result |
| `system` `subagent_finished`, `failed` or `cancelled` | a notice (`harness.notice`); a completed one's findings come back to the agent as a message |
| `system` `error_during_execution`/`error_max_turns` | a failed result, which a `result` after it replaces |
| `result` `success` | the turn's success; no `total_cost_usd`, so no cost |
| `result` `error_during_execution` (`error`) / `error_max_turns` | a failed turn, saying why / `max_turns` |
| `result` `permission_denials` (strings) | each one refused (`harness.permission_denied`) |

The shell tool is `shell_command` in Amp's `low`, `medium`, `high` and `ultra` modes (from `amp tools list --mode …` of the pinned CLI); Amp's docs still show an older `Bash`. Without a token, `amp tools list` shows only the CLI's local tools (`create_file`, `edit_file` or `apply_patch`, `shell_command`, `shell_command_kill`, `shell_command_status`, `skill`, and the two web tools); tools Amp's servers add, such as `Task`, are known from its docs.

## Signing in

With an Amp **access token** only, which the person creates in their Amp settings (`https://ampcode.com/settings`, Access tokens) and saves once in the coding page's Connect panel; it starts with `sgamp_`. Amp rejects the short-lived session token `amp login` stores from the environment, so there is no sign-in to relay, as Codex's or Claude Code's. A run hands the token to the CLI in `AMP_API_KEY` alone (`authEnv`), never on its command line, and the runner takes it out of everything the CLI prints. The CLI doesn't write it to disk: after a run, `~/.local/share/amp` held only `device-id.json` and `.legacy-state-owner.json`, and its log only `hasAmpAPIKey: true`.

**A refused token.** With a token Amp refuses, the CLI prints nothing on its output and exits 1 with, on its error output (captured, `test/fixtures/amp/login.stderr`):

```text
Error: Invalid or missing API key. Run 'amp login' to authenticate.
```

The harness's `loginFailure` matches it, so the turn ends `login_required` and the thread waits for the person to save a token again. A failed result that says the same is read the same way. When the CLI can't reach Amp it says "Couldn't connect to the Amp server at …" and the turn fails with that. **Out of credits** isn't a login failure: a failed result whose text says so ("You are out of credits…", a message the CLI holds; not captured) ends the turn as a usage limit, with Amp's own words.

## Cost and budget

**What is real.** Amp reports tokens: each model response's (`usage`: input, output, cache read and cache creation), and the run's in its result. It reports no money. `amp threads usage <T-thread>` prints the thread's cost in credits as text for a person ("display cost", `--details` for more), and `amp usage` the balance; neither has a machine-readable output. A credit isn't a documented number of dollars: Amp's terms define a credit rate, the dollars paid per credit when bought. Amp's External API has a thread's usage in dollars (`GET /api/v2/threads/{id}/usage`), but it is workspace-scoped, with OAuth scopes a personal access token isn't documented to have, and it couldn't be tried here.

**What Pim does.** An Amp turn's `model_call` has its tokens and no cost (`provider: "amp"`, `costUsd: 0`), and the thread's spend doesn't grow. Its budget is kept as a ceiling on tokens instead, as for Codex: each budgeted dollar allows 1,000,000 tokens of every kind, counted from the thread's `model_call`s (`UNPRICED_TOKENS_PER_USD` in `src/coding/thread-do.ts`). That is a ceiling that stops a runaway thread, not a price, and not what Amp charges. Each turn is given what is left (`maxTokens`), and the runner sends SIGINT once the turn's tokens reach it, since Amp has no flag of its own for a budget or a number of turns; the turn ends `budget`, and the thread stops with `stateReason: "budget"`, the tokens in `stateDetail` and a notice in tokens. Steering or continuing is then refused (`budget_spent`) until it is continued with a bigger budget. A subagent's tokens aren't counted, as its messages aren't read, and the wall clock still applies.

## Files

`HOME` is `/workspace`, the workspace's volume. Pim writes nothing of Amp's there; the CLI writes `~/.cache/amp/logs/pim-<session>.log` (its log, one per thread, which may hold the prompts), `~/.local/share/amp/device-id.json` and `~/.config/amp/` (empty). The user settings file (`~/.config/amp/settings.json`) is whatever the workspace has, and the managed settings win over it.

## Egress

A thread's workspace may reach what every coding thread may, plus `ampcode.com` and `*.ampcode.com` (subdomains, as the egress proxy reads it). Amp runs inference on its own servers ("Model routing" on Amp's Egress IPs page), so the CLI needs no model provider's host. Against the stand-in, it made its requests (the user, telemetry at `/api/telemetry`, the account's plugins, the thread) to `AMP_URL`; the other hosts the binary names are `static.ampcode.com`, for its version and notices (update checks are off), and those below. It downloads ripgrep from `storage.googleapis.com` only when there is none on the system; the image has one. Plugins run on the CLI's own binary, so nothing is fetched for them.

## The workspace image

`workspace-agentd/Dockerfile` installs `@ampcode/cli`, pinned by `ARG AMP_VERSION=0.0.1794240032-ga42e06`, globally with npm on the image's Node 22, next to Claude Code and Codex; its package installs the native binary for the platform from an optional dependency. The build copies the managed settings first and runs `amp --version`, so an image whose CLI doesn't start fails to build.

It was built on an orb with Docker: `docker build -t pim-workspace:local workspace-agentd` succeeded, `amp --version` printed `0.0.1794240032-ga42e06`, and as the workspace's user (uid 10001) with `HOME=/workspace` the command above was read as Pim builds it, and refused the fake token as above.

To roll it out on the sandbox host, from the repository's checkout there, in the environment the stack was first started with (as for Codex in [coding-codex.md](coding-codex.md)):

```sh
cd ~/pim-src && git pull && cd sandbox-manager && docker compose up -d --build
docker run --rm --entrypoint amp pim-workspace:local --version     # 0.0.1794240032-ga42e06
docker run --rm --entrypoint cat pim-workspace:local /etc/ampcode/managed-settings.json
```

Workspaces that already exist keep the image they were made with; a thread gets the new one with its next workspace. If `ALLOWED_IMAGES` pins the image by digest, put the new digest there.

To move to a newer Amp, change `AMP_VERSION`, rebuild, and check `amp --help` against `test/fixtures/amp/help.txt`, the shell tool's name (`amp tools list --mode …`), that a skill's MCP server is still refused with a project allowing it (`amp mcp doctor` in a checkout like the one above), and a run's stream-json against `src/coding/harness/stream-json.ts` and `test/fixtures/amp/`.

## What is verified

Verified with the pinned CLI, without a token: every flag of the command (its `--help`, kept as a fixture, and its log of a run of the exact argv); the refused-token and unreachable-server output (fixtures); that the token stays out of the command line and off the disk; settings precedence, and that the managed settings reject MCP servers a project or its skills bring; that a project's plugins run with the token in their environment; SIGINT during startup; and the hosts the CLI called.

Not verified, as there is no Amp token in CI or here:

- A real turn. The `turn`, `max-turns`, `failed` and `credits` fixtures are written from Amp's documented stream-json schema, not captured: whether each line is one model response (so tokens are counted once), the exact shape of `permission_denials`, and the result and error texts are Amp's docs' or guesses.
- That `amp.tools.disable` and `amp.dangerouslyAllowAll` from the managed settings take effect in a run.
- What the CLI prints when interrupted mid-turn, and whether background subagents keep it running past the turn.
- Continuing a thread that execute mode archived, and what out of credits looks like.
- Amp under gVisor with the workspace's limits, and its connections to `*.ampcode.com` through the egress proxy.
