# Claude Code threads

A coding thread started with `harness: "claude-code"` is run by Anthropic's `claude` CLI, unmodified, inside the thread's own workspace, signed in with the person's own Claude subscription. Pim drives it turn by turn and reads what it prints; Pim's own agent loop (the `pi` harness) is not involved. This page explains how, what was decided, and how to update the workspace image.

## The framework

Any CLI that works in a workspace is a `CliHarness` (`src/coding/harness/types.ts`): how a turn is started (`buildCommand`), how a line of its output reads (`parser().parseLine`, into `HarnessEvent`s), the environment and egress it needs, how its process is signalled, and optionally how it signs in (`login`). `cliHarness(id)` in `src/coding/harness/index.ts` lists the ones there are: `claude-code` and `codex` ([coding-codex.md](coding-codex.md)).

`HarnessRunner` (`src/coding/harness/runner.ts`) runs one turn for `CodingThreadDO` when `thread.harness !== "pi"`:

1. **Prepare.** The person's lock for the harness is taken from the space's scheduler (one run per person per harness at a time, since they share one login), then the login is restored from the vault into the workspace. No stored login: the lock is let go and the thread goes to `waiting_input` with `stateReason: "login_required"`. Lock held by another of their threads: the thread stays `running` with `stateReason: "harness_busy"` and tries again at its next heartbeat.
2. **Run.** The CLI runs through `workspace.exec` in `/workspace/repo` with `HOME=/workspace`, `harnessEnv` (`CLAUDE_CONFIG_DIR=/workspace/.claude`) and the harness's own env. Each line is parsed as it arrives (lines split across chunks are joined). Messages go into the thread's transcript as pi-ai messages (`harness.message` entries), so the web app shows text, thinking, tool calls and their results as it does for Pi; text as it is written goes to live followers as `{ type: "partial" }`; `Bash` calls that ran tests become test runs; retries and refused tools go into the thread's log.
3. **End.** The login is written back to the vault and scrubbed from the workspace, and the lock let go, in a `finally`: also after a failure, an abort or a timeout. Then the turn ends as a Pi turn does: a checkpoint commit, its diff, the turn's `model_call` and the thread's spend.

A turn is `completed` only when the CLI printed a successful `result`. No result, a failed result, a non-zero exit, a lost login, a timeout, an abort or a restart never counts as done.

**Steering** never writes to the CLI's stdin mid-turn: the text waits and becomes the next turn, which resumes the CLI's session (`--resume`). `interrupt: true` stops the turn first. **Abort** sends SIGINT (`pkill -INT -f <session id>`), waits up to 15 s for the CLI to stop, then aborts the exec and sends SIGKILL. **Wall clock**: at `limits.wallClockMin` the turn gets SIGINT, then SIGKILL after the grace; it ends `timeout`.

**Restarts.** While a turn runs, the thread keeps a record of it (`coding_harness_run`: operation, session id, lines read, whether the login was restored and the lock taken) and the CLI's session (`coding_harness_session`: id and the session's cost so far). A Durable Object that restarts mid-turn does not re-attach to the process: the exec stream is gone with the old isolate, and output the thread did not read can't be replayed honestly. It kills the CLI, writes the login back, lets the lock go and ends the turn `interrupted`, with how many lines it had read. The session is kept, so the next turn resumes what the CLI saved.

**Cost.** The CLI reports `total_cost_usd` for its whole session; a turn's cost is how much that grew. With a subscription it is the CLI's estimate of what the tokens would cost through the API, not a charge to the person; Pim still counts it against the thread's budget so a runaway thread stops. Each turn is also given `--max-budget-usd` with the budget left, rounded down to the cent; a turn stopped by it ends with `stateReason: "budget"`.

## The command

```sh
claude -p --output-format stream-json --verbose --include-partial-messages \
  --permission-mode acceptEdits --allowedTools Bash --disallowedTools 'mcp__*' \
  --permission-prompts none \
  --setting-sources user --settings '{"disableAllHooks":true}' --strict-mcp-config \
  (--session-id <uuid> | --resume <uuid>) --max-budget-usd <left> [--model <m>] \
  --append-system-prompt <Pim's instructions> -- <prompt>
```

The flags were checked against Anthropic's docs (code.claude.com: CLI reference, headless mode, permissions, authentication, network config) and against `claude --help` of the pinned 2.1.311 binary, which has every one of them. Why each:

- **No `--bare`.** Bare mode skips the CLI's own login and reads only API keys, so a subscription couldn't be used.
- **`--session-id` / `--resume`.** Pim picks the session id for a thread's first turn, so it knows it before the CLI prints anything (for signalling and restarts), and resumes it on later turns.
- **Untrusted repository.** A `-p` run uses a project's `.claude/settings.json` hooks and its `.mcp.json` servers without the trust dialog ("What runs before you trust a folder" in the permissions docs). `--setting-sources user` loads none of the project's settings, MCP config, skills, commands or subagents; `--settings '{"disableAllHooks":true}'` turns off every hook, the person's own included, since nobody watches them; `--strict-mcp-config` with no `--mcp-config`, plus `--disallowedTools 'mcp__*'`, leaves no MCP server or tool.
- **Permissions.** The workspace is a gVisor sandbox of the thread's own with an egress allowlist, holding no credential but the CLI's login, and every change is reviewed as a diff before it is pushed. So the agent may edit files (`acceptEdits`) and run any shell command (`--allowedTools Bash`) without asking. Anything else that would ask, such as fetching a web page, is denied without a prompt (`--permission-prompts none`, since nobody answers in `-p`). `bypassPermissions` is not used: it would also skip the CLI's own safety checks.
- **Environment.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1` and `DISABLE_AUTOUPDATER=1`: no telemetry, error reports or update checks, so the workspace needs no host for them.

## Signing in

**Subscription (the default).** `POST /api/coding/vault/claude-code/login` starts `claude auth login` (which defaults to the Claude subscription, `--claudeai`) in a short-lived workspace of the person's, through `CodingSchedulerDO`. The CLI prints a URL; Pim relays it once it is on one of Anthropic's sign-in hosts. The person signs in there and pastes the code the page shows; `POST …/login/code` writes it to a 0600 file the CLI's stdin waits on (`sh -c '(wait for file; cat; rm) | claude auth login'`). The CLI exchanges the code itself and saves its login under `CLAUDE_CONFIG_DIR`; Pim writes that directory's allowlisted files back to the vault and deletes the workspace. Pim never parses, prints or logs the CLI's output after the URL, or the files. Threads waiting with `login_required` go on. The web app's "Connect Claude Code" panel shows the disclosures (`HARNESS_DISCLOSURES`), the link, the code field, whether it is connected, and Disconnect.

Checked with the real 2.1.311 CLI in the workspace image: `claude auth login` with stdin a pipe prints `If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…` then `Paste code here if prompted >`, and reads the code from the pipe once the file appears (a bogus code was refused by Anthropic with "That code wasn't accepted", exit 1). A real sign-in has not been done.

**API key or gateway (not built).** `authEnv(thread)` in `src/coding/harness/auth.ts` is the seam: it returns `{ mode: "subscription" }` for every thread today. Returning `{ mode: "env", env }` instead, such as `ANTHROPIC_API_KEY`, or `ANTHROPIC_BASE_URL` with `ANTHROPIC_AUTH_TOKEN` for Pim's gateway, runs the CLI with that environment and neither restores a login nor takes the person's lock.

## Egress

A `claude-code` thread's workspace may reach what every coding thread may (Pim's git broker and the package registries) plus `api.anthropic.com` (the API, and the login's profile and roles), `claude.ai` and `platform.claude.com` (where the login's tokens are exchanged and refreshed: `platform.claude.com/v1/oauth/token`). The sign-in workspace may reach only those three. The sign-in page itself (`claude.com`) is opened by the person's browser, not the workspace. Telemetry, error reporting and updates are turned off rather than allowed.

## The workspace image

`workspace-agentd/Dockerfile` installs `@anthropic-ai/claude-code`, pinned by `ARG CLAUDE_CODE_VERSION=2.1.311` (npm's `stable` tag on 2026-11-09), globally with npm on the image's Node 22, and `procps` for `pkill`. The build runs `claude --version`, so an image whose CLI doesn't start fails to build.

It was built on an orb with Docker: `docker build -t pim-workspace:local workspace-agentd` succeeded and printed `2.1.311 (Claude Code)`. The CLI's npm package installs a native binary (about 290 MB) for the platform from an optional dependency.

To roll it out on the sandbox host:

```sh
cd sandbox-manager
docker compose build workspace-image      # rebuilds pim-workspace:local from ../workspace-agentd
docker compose up -d                      # the manager uses the new image for new workspaces
docker run --rm --entrypoint claude pim-workspace:local --version   # 2.1.311 (Claude Code)
```

Without compose: `docker build -t pim-workspace:local workspace-agentd` from the repository root. Workspaces that already exist keep the image they were created with; a thread gets the new one with its next workspace. If `ALLOWED_IMAGES` pins the image by digest, put the new digest there and restart the manager.

To move to a newer CLI, change `CLAUDE_CODE_VERSION`, rebuild, and check `claude --help` for the flags above and a run's stream-json against `src/coding/harness/claude-code.ts` and its fixtures (`test/fixtures/claude-code/`) before deploying.

## Not yet verified

- A real turn with a real login: the parser's `turn` and `budget` fixtures are written from Anthropic's documented stream-json schema; the `login` fixture is real output of 2.1.311 without a login.
- A real sign-in end to end, and whether the vault's file list (`.credentials.json`, `.claude.json`, `settings.json`) is everything a later `-p` run needs to be signed in.
- The CLI under gVisor with the workspace's limits; `/tmp` is a 64 MiB `noexec` tmpfs there, and the CLI puts a messaging socket under `/tmp`.
