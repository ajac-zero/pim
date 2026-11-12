# Coding environments: toolchains, dependencies and checks

A coding thread's workspace starts from one image (Node, pnpm, Yarn, git, build tools and the coding CLIs). Most repositories need more: a Go repository needs Go to run `go vet` and its tests. Before a thread's first turn, Pim reads the repository's checkout, installs the toolchains and dependencies it pins, and tells the coding agent which commands check its work. This is always on: there is no flag, setting or variable. It happens inside the thread's own workspace, so nothing is built on the host, and it is part of the thread's environment ([reference.md](reference.md#workspaces-for-coding-threads)), so its result is kept in the person's snapshot and the next thread starts from it.

The code is [`src/coding/repo-environment.ts`](../src/coding/repo-environment.ts) (detection, the steps, and what the agent is told) and `#prepareEnvironment` in [`src/coding/thread-do.ts`](../src/coding/thread-do.ts) (running the steps, the snapshot and the status).

## What is read

Only files at the repository's root (and the directories named below) are read, each up to 256 KiB.

| Toolchain | Read from, strongest first |
| --- | --- |
| Any tool mise knows | `mise.toml`, `.mise.toml`, `.tool-versions` (asdf's `golang` and `nodejs` are Go and Node) |
| Any of Go, Node, Python, Rust, Java, Ruby, Deno, Bun | A feature of `.devcontainer/devcontainer.json` or `.devcontainer.json`, such as `ghcr.io/devcontainers/features/go:1` with `{ "version": "1.22" }` (`none` and `os-provided` install nothing) |
| Go | `go.mod`'s `toolchain` directive, else its `go` directive, else the latest Go |
| Node | `.nvmrc` or `.node-version` (`lts/*` is the latest LTS); `engines.node` when it names a version (`^20.11.0` is 20, `~20.11` is 20.11; an open range such as `>=18` is met by the image's Node); else the image's Node |
| pnpm, Yarn, Bun | `package.json`'s `packageManager`, else the image's pnpm or Yarn; Bun's latest for a `bun.lock` |
| Python | `.python-version`; `requires-python` in `pyproject.toml` (the version an `==` or `~=` names, else the lower bound of `>=`); else Python 3.13. A repository needs Python when it has `pyproject.toml`, `requirements*.txt`, `uv.lock`, `setup.py`, `Pipfile` or `.python-version` |
| uv | The latest, for a repository with `uv.lock` or requirements files |
| Rust | `rust-toolchain.toml`'s `channel` or a plain `rust-toolchain` file, else stable, for a repository with `Cargo.toml` (its `rust-version`, the oldest Rust it supports, isn't installed) |
| Weakest hint | The image of `Dockerfile`'s `FROM` lines (`golang:1.22-alpine` is Go 1.22) and of the dev container's `image` (`mcr.microsoft.com/devcontainers/go:1-1.22-bookworm` is Go 1.22): they only choose the version of a tool the repository needs, below every file above but above a loose `engines.node` or `requires-python` |

A version that isn't a plain version word (letters, digits and `._+-`) is ignored, so nothing from the repository's files reaches a command but such a word.

## What is installed

The steps run one after another with bash in the checkout, as the setup script does: as the workspace's user, under its egress allowlist and limits, with no secret of Pim's, and for at most 10 minutes each. mise is in the workspace image ([`workspace-agentd/Dockerfile`](../workspace-agentd/Dockerfile)); it keeps what it installs and its shims under the workspace's home, so a snapshot keeps them, and its shims are first on every command's PATH.

1. A repository with mise configuration that lists tools: `mise trust && mise install`, which installs what it lists as mise would on a developer's machine.
2. Each other toolchain with a version: `mise use --global <tool>@<version>`, into mise's configuration in the workspace's home, never into the repository. mise installs npm packages without their install scripts, so for pnpm the step then runs pnpm's own install script when its executable is still the placeholder and points mise's entries at the real executables, which would otherwise crash Node. Every toolchain step ends by running the tool (`node --version`, `go version`), so an install that leaves a binary that crashes is recorded as failed, with the tool's error, not as installed.
3. Dependencies, only from a lockfile, so nothing in the checkout changes: `go mod download` (with `go.sum`), `pnpm install --frozen-lockfile`, `npm ci`, `yarn install --frozen-lockfile` (or `--immutable` with `.yarnrc.yml`), `bun install --frozen-lockfile`, `uv sync --frozen` (with `uv.lock`), `uv venv && uv pip install -r requirements.txt …` (into `.venv`), and `cargo fetch --locked`. Downloads go to the person's dependency cache for the repository where the backend keeps one.
4. The repository's setup runs last and may do anything else. Only the highest of these that exists runs: the person's setting for the repository; the `setup` of `.pim/env.json` ([below](#the-repositorys-contract-pimenvjson)); `.pim/setup.sh`; a mise task named `setup` in `mise.toml` or `.mise.toml` (run with `mise run setup`); the dev container's `onCreateCommand`, `updateContentCommand` and `postCreateCommand` from `.devcontainer/devcontainer.json` or `.devcontainer.json`, in that order. A command may be a string, an array (a program and its arguments) or an object of either; an object's entries run one after another, not in parallel, and the first failure stops the rest.

A step that fails is recorded on the toolchain or dependencies it installs, with the end of what it printed, and the thread goes on: a failed step never fails the thread. Dependencies that need a toolchain that couldn't be installed are skipped. No snapshot is kept when a step failed, so the person's next thread tries again, as one would after a network failure; a rebuild tries again in the same thread. A failing setup script is still the environment's failure, as before.

A repository with nothing to install and no setup script has no environment (`state: "none"`), but its checks are still found and told to the agent. Every workspace backend runs the same lifecycle: detection, provisioning and the setup script. A backend that keeps no snapshots (`capabilities.environmentSnapshots` is false) builds in place for each thread, with no restore, no snapshot and no cross-thread build lock; only the snapshot is the backend's to keep. The `"unsupported"` state remains in the type for threads saved before this, and is no longer produced.

## The environment phase in the transcript

What the environment did is shown at the start of the thread's transcript, as notices before the agent's first message ([`src/coding/environment-phase.ts`](../src/coding/environment-phase.ts)). The restore, each provisioning step (a skipped one too) and the setup script are one notice each: `Environment setup: exit 0, 1.2 s`, the command after `$ `, and the end of what it printed: control characters removed, credentials redacted, at most its last 2048 characters, with a line saying how much was cut. A restore or a build ends with `Environment: restored from a snapshot` or `Environment: ready`. The same record is in the thread's log (`environment.started`, `environment.step`, …; [coding-api.md](coding-api.md#events)).

## When the setup fails

A failed setup script never fails the thread, and is never silent: the thread starts the agent anyway, in the workspace as the checkout and the image left it, and says so. Its `status` has `stateReason: "environment_failed"` with the error as `stateDetail` while the environment is `failed` and nothing else explains the thread's state; the transcript has `Environment: failed: <error>` and a line that the agent starts anyway; and the agent's instructions begin with `The environment's setup failed: <error>`, telling it dependencies may be missing, to say so if that blocks it, and that the person can retry. To retry, the person presses Retry on the thread page's banner (`POST /api/coding/threads/:id/environment/rebuild`), and an agent calls `coding_steer` with `retry_environment: true` (no `text` needed): the setup runs again in the same workspace between turns, and the state clears when it works.

## The repository's contract: `.pim/env.json`

A repository can say what its environment is instead of leaving Pim to guess. `.pim/env.json` is read from the checkout ([`src/coding/env-config.ts`](../src/coding/env-config.ts)); every field is optional:

| Field | Meaning |
| --- | --- |
| `setup` | A bash script, or a list of lines joined into one script that starts with `set -e`. |
| `cacheKeys` | Files, or globs, whose contents are part of the environment's key, such as `["db/schema.sql", "tools/**/*.lock"]`. `*` matches within one name, `**` across directories. |
| `cachePaths` | Paths worth keeping between threads, such as `["node_modules"]`; shown in the status. |
| `services` | Processes of the repository: `{ "name", "command", "port", "ready"?, "preview"? }`. They are described to the agent and shown in the status; Pim doesn't start them yet. |
| `check` | The commands the repository checks itself with. When there are any, they replace the checks found in other files, with source `pim`. |

```json
{
  "setup": ["pnpm install --frozen-lockfile", "pnpm run build:schema"],
  "cacheKeys": ["db/schema.sql", "tools/**/*.lock"],
  "cachePaths": ["node_modules"],
  "services": [{ "name": "web", "command": "pnpm dev", "port": 5173, "ready": "curl -sf localhost:5173", "preview": true }],
  "check": ["pnpm typecheck", "pnpm test"]
}
```

The file is read strictly. A wrong field makes the whole file ignored, with up to five reasons in the thread's notes (`.pim/env.json is ignored: …`), and the thread is set up as if it had none. A field this version doesn't know is ignored with a note. A `cacheKeys` entry that matches no file is left out of the key, with a note. Paths in `cacheKeys` and `cachePaths` must be relative, without `~`, `..` or `\`.

Limits: the file is at most 32 KiB; at most 20 services, with names of a letter and up to 39 letters, digits, `_` or `-` that don't repeat (ignoring case), ports from 1 to 65535 that don't repeat; at most 50 `check` commands of at most 200 characters; at most 50 `cacheKeys` and 50 `cachePaths`. `cacheKeys` globs are matched up to six directories deep, skipping dot-directories and `node_modules`, and at most 200 files of 2 MiB each are hashed.

Precedence of the setup, highest first: the person's setting for the repository, `setup` in `.pim/env.json`, `.pim/setup.sh`, a mise task named `setup`, the dev container's commands. A repository without `.pim/env.json` has what Pim found recorded as a note (`detected: go 1.22, installing with go mod download`) and an `environment.detected` event.

## The cache key

The environment's key ([`environmentKey`](../src/coding/environment-cache.ts)) covers the steps' commands, which name every version they install, so a new pin in `go.mod`, `.nvmrc`, `packageManager` or anywhere else above is a new environment, and so is a new or removed lockfile. It covers the setup that runs and where it came from (a mise task's file or the dev container's commands count as its content), and, for a toolchain that isn't pinned (`lts`, `stable`, `latest`), the concrete version mise resolves it to (`mise latest node@lts`), so a new release is a new environment; where mise can't resolve it, the key changes every 7 days instead. It also covers the contents of the files `.pim/env.json`'s `cacheKeys` name, and the lockfiles' contents (now with `go.sum`, `bun.lock`, `npm-shrinkwrap.json` and mise's configuration), the setup script, the person, the repository and the workspace image. A change to anything else, such as the code, a Makefile or a workflow, keeps the key and the snapshot. Snapshots are kept per sandbox pool ([coding-pools.md](coding-pools.md#environment-snapshots)). The key also covers the pool, except for a provider's first pool, which keeps the keys made before pools, so those snapshots still resolve. The key's format changed with provisioning, so every snapshot made before it is built once more.

## The checks the agent is told

The commands a repository checks itself with are found in this order, and the first twelve, without repeats, are kept:

- mise's tasks named for checks, in `[tasks.<name>]` or `[tasks]` of its configuration and as files in `mise-tasks/`, `.mise/tasks/` or `.mise-tasks/`: `mise run test`.
- The `Makefile`'s targets named for checks: `make test`.
- `package.json`'s scripts named for checks, run with the repository's package manager: `pnpm run lint`. npm's placeholder `test` script is left out.
- The commands in `run:` steps of `.github/workflows/*.yml` and `.gitea/workflows/*.yml`, read the same way for GitHub and a self-hosted Gitea, that test, lint, vet, type-check or check. Install, setup, `echo`, `cd`, `git` and `docker` lines, and lines that use the workflow's `${{ }}` expressions, are left out; a line continued with `\` is joined, and a folded block (`>`) is one command.
- Only when none of those named anything: `go vet ./...` and `go test ./...` for `go.mod`, `cargo test` for `Cargo.toml`, and pytest for a Python repository that mentions it (`uv run pytest` with `uv.lock`, `.venv/bin/python -m pytest` with requirements files, `python -m pytest` otherwise).

A name counts as a check when it is `test`, `tests`, `check`, `lint`, `vet`, `typecheck`, `type-check` or `types`, alone or followed by `:`, `-`, `_` or `.` and more (`test:unit`, `lint-go`), but not one ending in `fix`, `watch`, `update`, `write` or `dev`.

## Where it shows

- **The agent's instructions.** Pi's system prompt and every CLI harness's instructions get the toolchains and their versions, the dependency commands already run, what failed and why, the checks with the file each came from, and what isn't provisioned.
- **The API.** The thread's `environment` (`GET /api/coding/threads/:id` and `/environment`) has `toolchains`, `dependencies`, `testCommands` and `notes` ([coding-api.md](coding-api.md#types)); `readyFrom: "snapshot"` is a cache hit, and `pool` is the pool whose snapshot it is.
- **`coding_status`.** The same, with `cache_hit`.
- **The thread page.** The environment chip's popover lists the toolchains and dependencies with their status, the checks, and what isn't set up, and says whether it came from a cached snapshot. The chip warns when a step failed.

## What isn't covered

- **Services.** Those `.pim/env.json` declares are described, not started yet. Postgres, Redis and the other `services:` a CI workflow starts aren't started either; the thread's `notes` and the agent's instructions name them, so tests that need them fail or are skipped. Docker isn't available in a workspace, so `docker compose` can't start them either.
- **Dockerfiles and dev containers aren't built.** A `Dockerfile` and a dev container's `image` only hint at versions. Dev container features other than the languages above, and their options besides `version`, aren't installed; their lifecycle commands are run only when nothing higher (a setting, `.pim/setup.sh`, a mise `setup` task) is set up.
- **Only the root.** A monorepo's `go.mod`, `package.json` or `pyproject.toml` in a subdirectory isn't read (its lockfiles one directory down are in the key, as before). A workflow step's `working-directory` and a matrix aren't applied to its command.
- **Some managers.** Poetry, Pipenv, Conda, Gradle, Maven and Bundler projects get no dependency install (Poetry is noted), and Java, Ruby and the rest are installed only when mise configuration or a dev container feature names them. A `package.json` without a lockfile installs nothing.
- **Downloads need the egress allowlist.** mise fetches toolchains from `mise-versions.jdx.dev`, `dl.google.com` and `go.dev` (Go), `sum.golang.org`, `nodejs.org`, `static.rust-lang.org`, and GitHub's releases (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`) for Python, uv, Bun and most other tools; these are on every workspace's allowlist, as are the package registries dependency steps use (npm, PyPI, crates.io, Go's proxy and the `storage.googleapis.com` it redirects module downloads to). The allowlist is fixed by Pim's deployment, not set per repository or user. A tool hosted elsewhere fails its step. Without a network, every step fails, is recorded, and the thread goes on with the image's tools.
- **The CLIs share the PATH.** mise's shims come first for the coding CLIs too, so a repository that pins a very old Node runs the Node-based CLI wrappers with it.
- **Every backend runs it.** Cloudflare Containers keeps no environment snapshots, so each thread provisions and runs the setup script in place and keeps no snapshot.
- **Not tested against a live sandbox.** The Worker's tests run the steps in the in-memory workspace. The steps themselves were run for real with mise 2026.10.4 for Go, pnpm, requirements files, uv, Rust and a mise repository, and the Go, pnpm and mise ones in the workspace image as its user, after which a command with only the image's PATH found the pinned versions; but not under gVisor or behind the egress proxy, so the allowlist above is what mise is documented to reach, not what a live run was seen to need.

### Git access inside a thread

An agent can run ordinary `git fetch origin <branch>` and `git pull` for any branch of its thread's repository. Origin is Pim's git broker. The broker admits only the repository and provider instance named in the signed thread token and serves `git-upload-pack` to any thread token. Its `git-receive-pack` serves only a **push token**, which Pim issues for the thread's own branch (`refs/heads/pim/<slug>-<idprefix>`), so `git push origin HEAD` from the workspace saves its commits even if the sandbox dies. The broker parses the push's command list before forwarding anything, with the upstream write credential that never leaves Pim, and allows exactly one update of that branch: from the remote's current tip (or creating it), to a new commit. It refuses every other ref (the default branch, other `pim/` branches, tags), deletes, several updates, and an update whose old SHA isn't the remote's tip, so a force push or one from a stale view fails; a push over 64 MiB is refused too. A read-only token can't push. A successful push adds a `thread.pushed` event. Merging into the default branch and opening pull requests still go through `coding_merge` and the approval flow. Pim also pushes that branch itself, at every checkpoint (turn end for every harness, stop or abort, session move, idle reclaim; at most 30 seconds at a stop), and says in the transcript when pushes keep failing; the thread's status has `lastPushedSha` and `unpushed`. If the workspace's volume is lost and made again, Pim fast-forwards the new clone to `lastPushedSha` when it is ahead of the restored work (never over a newer autosave, never forced), so the agent resumes with its pushed commits. This works on every workspace provider, with no setting.

Pim sets `user.name` (`Pim`) and `user.email` (`coding@pim.invalid`) in the workspace's global Git configuration before each turn, the identity of its own checkpoint commits, so commits work without further setup.

On providers with credential injection, the egress policy supplies the broker header even when Git sends no credentials. Pim refreshes that policy before each turn and when opening an existing workspace. The workspace never receives that token.

Compose cannot inject credentials. After preparing the environment, Pim installs a URL-scoped credential helper in the workspace's **global** Git configuration, with `useHttpPath` enabled. The helper keeps a broker token (read, and push of the thread's own branch) in `/workspace/.config/pim/git/credential.json` (mode 0600), not in the checkout's configuration, remote URL, command arguments or agent environment. This directory is excluded from compose environment snapshots. The agent can read this short-lived token; it never receives an upstream provider credential or a signing key.

The helper asks the broker for a fresh token on each credential lookup, preserving the thread, repository and provider scope. Each token lasts at most one hour; renewal cannot pass the original twelve-hour deadline. Expired tokens cannot renew. Pim supplies a new grant before each turn, including after an idle period or workspace restore. If a command runs after access expires without an intervening credential lookup, or a single turn exceeds the renewal window, Git fails closed; starting another turn refreshes access. The helper does not cache tokens through other Git helpers or print broker errors or credentials.
