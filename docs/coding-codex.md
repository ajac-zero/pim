# Codex threads

A coding thread started with `harness: "codex"` is run by OpenAI's `codex` CLI, unmodified, inside the thread's own workspace, signed in with the person's own ChatGPT plan. It is the second CLI harness, after Claude Code, and goes through the same framework: [coding-claude-code.md](coding-claude-code.md) explains the runner, the person's lock, steering, aborts, restarts and the vault. This page covers what is Codex's own: its command, its events, its device-code sign-in, and the image.

Everything below was checked against Codex 0.167.0 (npm's `latest` on 2026-11-09), its source at the `rust-v0.167.0` tag, and by running the CLI in the workspace image built from this repository.

## The command

```sh
codex exec --json --ignore-user-config --ignore-rules \
  --sandbox danger-full-access -c 'approval_policy="never"' \
  -c 'projects={"/workspace/repo"={trust_level="untrusted"}}' -c analytics.enabled=false \
  -C /workspace/repo -o /tmp/pim-codex-<session>.txt [-m <model>] \
  -c 'developer_instructions="<Pim's instructions>"' \
  [resume <session>] -- <prompt>
```

`codex exec --help` of 0.167.0 lists every one of these flags. Why each:

- **`--json`**: one JSON event a line on stdout, `ThreadEvent` in `codex-rs/exec/src/exec_events.rs`. Codex's logs go to stderr.
- **Untrusted repository.** `codex exec` loads a project's `.codex/config.toml` (MCP servers, hooks, exec policies) only for a trusted project. But a run whose sandbox may write the checkout marks an unknown project trusted by itself, writes `[projects."/workspace/repo"] trust_level = "trusted"` into `$CODEX_HOME/config.toml`, and reloads its config (`app-server/src/request_processors/thread_processor.rs`). In the image, a repository with an MCP server in `.codex/config.toml` had that server started by `codex exec --sandbox danger-full-access`. Saying the checkout is `untrusted` with `-c projects=…` stops both: nothing was started and nothing was written. `--ignore-user-config` also keeps `$CODEX_HOME/config.toml` from being read (the login in `auth.json` still is, as the flag's help says), so nothing an earlier run or sign-in saved there adds servers, hooks, a provider or trust. `--ignore-rules` leaves out execpolicy `.rules` files. `AGENTS.md` is still read: it is instructions, not something that runs.
- **No inner sandbox.** Codex's `workspace-write` sandbox is bubblewrap in a new user namespace. In a container it can't make one: `codex sandbox` in the image printed "bwrap: No permissions to create a new namespace", so every command the agent ran would fail, and it would also cut the network the agent installs packages with. The workspace is already the sandbox (gVisor, its own egress allowlist, no credential but the CLI's login, every change reviewed as a diff), as it is for Claude Code's `Bash`. So `--sandbox danger-full-access`, and `approval_policy="never"` because nobody is there to approve. `--dangerously-bypass-approvals-and-sandbox` isn't used: it also skips the check that `-C` is a git checkout.
- **`-C /workspace/repo`**: the checkout, which is a git repository, so `--skip-git-repo-check` isn't needed.
- **`-o /tmp/pim-codex-<session>.txt`** writes the turn's last message to a file. It is there for its name: Codex names a new session itself, after it starts, so this puts the id Pim gave the turn on the command line, where `pkill -INT -f <id>` finds a first turn's process. A later turn resumes Codex's own session id, which is on its command line anyway. The npm package's `codex` replaces itself with the native binary (`process.execve`), so the signal reaches Codex itself; it then ends the turn and exits 1 without a `turn.completed`.
- **`-m`** when the thread's profile names a model (`{ providerId: "codex", model }`); otherwise Codex's default.
- **`developer_instructions`** is Pim's instructions to every CLI harness (`cliInstructions`), as a developer message. The value is a JSON string, which is also a TOML basic string, so it is never read as another type.
- **`resume <session>`** on every turn after the first, with the session `thread.started` named. A session Codex no longer has fails with "no rollout found for thread id …" and no events, so the thread lets it go and the next turn starts a new one. Sessions are kept in `$CODEX_HOME/sessions/`, on the workspace's volume.
- **`--` before the prompt**, so a prompt that starts with a dash is never read as a flag. agentd closes the command's stdin at once, so Codex appends nothing from it.
- **`analytics.enabled=false`**: no usage analytics.

`$CODEX_HOME` is `/workspace/.codex` (`harnessEnv("codex")`); Codex won't start unless that directory exists ("Error finding codex home"). With a subscription it always does, since the login was just restored into it; the API-key mode, when it is built, has to make it.

## Its events

`CodexJsonParser` in `src/coding/harness/codex.ts` reads:

| Codex prints | Pim makes of it |
| --- | --- |
| `thread.started` | the session (`thread_id`), kept for `resume` |
| `turn.completed` | the session's tokens so far (`usage`) and a successful result |
| `turn.failed` | a failed result; a lost login when it says so (below) |
| `error` "Reconnecting... n/m (…)" | a retry (`harness.api_retry`) |
| other `error` | a notice (`harness.notice`) |
| `agent_message`, `reasoning` | assistant text, thinking |
| `command_execution` | a `shell` tool call when it starts, its output and exit code when it ends; one that runs tests is a test run |
| `file_change` | an `apply_patch` call with its paths and kinds, and whether it applied |
| `mcp_tool_call` | an `mcp__<server>__<tool>` call and its result |
| `web_search` | a `web_search` call with its query |
| `todo_list` | an `update_plan` call each time the plan is made or changes |
| `error` item | a notice |
| `collab_tool_call` | nothing: subagents stay out of the transcript |

Codex prints commands shell-quoted, `/bin/bash -lc 'npm test'`; the transcript and the test runs show the script, `npm test`. It prints messages whole, so the web app shows a Codex message when it is done, not as it is written.

**A lost login.** With no login, Codex goes to the API with no key and fails the turn with "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"; with a login whose refresh token OpenAI refuses, "Your access token could not be refreshed. Please log out and sign in again." Both end the turn `login_required`, and the thread waits for the person. Only `turn.failed` is read for this: the retries before it carry the 401 too.

**Tokens and cost.** Codex reports tokens only at the turn's end, and for the whole session: on `resume` it starts from what the session used before. A turn's tokens are how much the session's grew since the last turn (`coding_harness_session.usage`); when the count went down, as after Codex compacted its context, the count is taken as it is. OpenAI's `input_tokens` include the cached ones, which Pim counts apart. Codex estimates no cost, so a Codex turn's `model_call` costs $0, the thread's spend doesn't grow, and its budget never stops it; the wall clock does. Codex has no `--max-budget-usd`.

## Signing in

`codex login --device-auth`, in a short-lived workspace of the person's (`POST /api/coding/vault/codex/login`), run as `sh -c 'mkdir -p "$CODEX_HOME" && exec codex login --device-auth'`. It prints, in 0.167.0:

```text
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   XXXX-XXXXX
```

Pim relays the link and the code (`url`, `userCode`; the login flow's `mode: "device_code"`), and the web app's "Connect Codex" panel shows both, with the disclosures in `HARNESS_DISCLOSURES` and Disconnect. Nothing is pasted back: the CLI polls OpenAI (`/api/accounts/deviceauth/token`) and exits 0 once the person has entered the code, after saving its login to `$CODEX_HOME/auth.json`. Pim notices the exit itself, keeps `auth.json` (and `config.toml`, if Codex wrote one) in the vault, deletes the workspace and goes on with the threads that waited. The panel polls the sign-in's status every 2 s to hear of it. A non-zero exit, such as OpenAI refusing, or the 15 minutes running out, fails the sign-in. Pim never logs the code, what the CLI prints after it, or the files.

OpenAI's docs call device-code sign-in beta; a person may first have to turn it on in ChatGPT's security settings, and Codex says "device code login is not enabled" when it is off. Running the command in the image did get a real code from OpenAI; no sign-in was finished.

Before each turn the login is restored into the thread's workspace and written back after it, as for Claude Code. OpenAI's refresh tokens rotate, and reusing one is a permanent failure, so one Codex run per person at a time (the person's lock) matters more here: two runs refreshing one login would sign each other out.

**API key or gateway (not built).** `authEnv` in `src/coding/harness/auth.ts` is the seam, as for Claude Code: `{ mode: "env", env }` with `OPENAI_API_KEY`/`CODEX_API_KEY`, or Pim's gateway (`OPENAI_BASE_URL`), runs Codex without a login or the lock.

## Egress

A `codex` thread's workspace may reach what every coding thread may, plus `chatgpt.com` (a ChatGPT login's turns go to `chatgpt.com/backend-api/codex`, over a WebSocket or HTTPS), `auth.openai.com` (where the login is made and refreshed, `auth.openai.com/oauth/token`) and `api.openai.com` (where an API key's turns go, and where Codex goes without a login). The sign-in workspace may reach those three; the device-code sign-in uses only `auth.openai.com`. The page the person opens is opened by their browser.

## The workspace image

`workspace-agentd/Dockerfile` installs `@openai/codex`, pinned by `ARG CODEX_VERSION=0.167.0`, globally with npm, next to Claude Code. Its package installs the native binary for the platform from an optional dependency. The build runs `codex --version`, so an image whose CLI doesn't start fails to build.

It was built on an orb with Docker: `docker build -t pim-workspace:local workspace-agentd` succeeded and printed `codex-cli 0.167.0`; `codex exec --help` in it lists the flags above.

To roll it out on the sandbox host, from the repository's checkout there (here `~/pim-src`) with this change in it, in the same environment the stack was first started with (`MANAGER_TOKEN`, `PROXY_ADMIN_TOKEN` and `AGENTD_TOKEN_SECRET` exported or in `sandbox-manager/.env`; compose refuses to start without the first two, and new values would cut Pim off from the manager):

```sh
cd ~/pim-src && git pull && cd sandbox-manager && docker compose up -d --build
docker run --rm --entrypoint codex pim-workspace:local --version    # codex-cli 0.167.0
docker run --rm --entrypoint claude pim-workspace:local --version   # 2.1.311 (Claude Code)
```

`up -d --build` rebuilds every image the compose file builds, `pim-workspace:local` from `../workspace-agentd` included (its `workspace-image` service, which the manager waits for), and recreates the containers whose image changed. `git pull` brings the change once it is on the branch the checkout follows; before that, `git fetch origin && git checkout review/coding-s5-codex`. Workspaces that already exist keep the image they were made with; a thread gets the new one with its next workspace. If `ALLOWED_IMAGES` pins the image by digest, put the new digest there.

To move to a newer Codex, change `CODEX_VERSION`, rebuild, and check `codex exec --help` for the flags above, the trust behavior (a repository's `.codex/config.toml` MCP server must not start), and a run's JSONL against `src/coding/harness/codex.ts` and `test/fixtures/codex/`.

## Not yet verified

- A real turn with a real login. The `turn` and `failed` fixtures are written from the 0.167.0 schema; `login` and `expired` are real output of 0.167.0 without a login and with a refused one.
- A real device-code sign-in end to end, and whether `auth.json` is all a later run needs.
- That `thread.started` names the resumed session on `resume` (the source says so; the parser assumes the resumed id if it doesn't).
- Codex under gVisor with the workspace's limits, and its WebSocket to `chatgpt.com` through the egress proxy (it falls back to HTTPS when the WebSocket fails).
