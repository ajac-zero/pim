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
2. Each other toolchain with a version: `mise use --global <tool>@<version>`, into mise's configuration in the workspace's home, never into the repository. mise installs npm packages without their install scripts, so for pnpm the step then runs pnpm's postinstall when its executable is still the placeholder, which would otherwise crash Node.
3. Dependencies, only from a lockfile, so nothing in the checkout changes: `go mod download` (with `go.sum`), `pnpm install --frozen-lockfile`, `npm ci`, `yarn install --frozen-lockfile` (or `--immutable` with `.yarnrc.yml`), `bun install --frozen-lockfile`, `uv sync --frozen` (with `uv.lock`), `uv venv && uv pip install -r requirements.txt …` (into `.venv`), and `cargo fetch --locked`. Downloads go to the person's dependency cache for the repository where the backend keeps one.
4. The repository's setup script, `.pim/setup.sh` or the person's setting, if there is one, runs last and may do anything else.

A step that fails is recorded on the toolchain or dependencies it installs, with the end of what it printed, and the thread goes on: a failed step never fails the thread. Dependencies that need a toolchain that couldn't be installed are skipped. No snapshot is kept when a step failed, so the person's next thread tries again, as one would after a network failure; a rebuild tries again in the same thread. A failing setup script is still the environment's failure, as before.

A repository with nothing to install and no setup script has no environment (`state: "none"`), but its checks are still found and told to the agent.

## The cache key

The environment's key ([`environmentKey`](../src/coding/environment-cache.ts)) covers the steps' commands, which name every version they install, so a new pin in `go.mod`, `.nvmrc`, `packageManager` or anywhere else above is a new environment, and so is a new or removed lockfile. It also covers the lockfiles' contents (now with `go.sum`, `bun.lock`, `npm-shrinkwrap.json` and mise's configuration), the setup script, the person, the repository and the workspace image. A change to anything else, such as the code, a Makefile or a workflow, keeps the key and the snapshot. The key's format changed with provisioning, so every snapshot made before it is built once more.

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
- **The API.** The thread's `environment` (`GET /api/coding/threads/:id` and `/environment`) has `toolchains`, `dependencies`, `testCommands` and `notes` ([coding-api.md](coding-api.md#types)); `readyFrom: "snapshot"` is a cache hit.
- **`coding_status`.** The same, with `cache_hit`.
- **The thread page.** The environment chip's popover lists the toolchains and dependencies with their status, the checks, and what isn't set up, and says whether it came from a cached snapshot. The chip warns when a step failed.

## What isn't covered

- **Services.** Postgres, Redis and the other `services:` a CI workflow starts aren't started; the thread's `notes` and the agent's instructions name them, so tests that need them fail or are skipped. Docker isn't available in a workspace, so `docker compose` can't start them either.
- **Dockerfiles and dev containers aren't built.** A `Dockerfile` and a dev container's `image` only hint at versions. Dev container features other than the languages above, and their options besides `version`, aren't installed; `postCreateCommand` and the like aren't run. Put what they do in `.pim/setup.sh`.
- **Only the root.** A monorepo's `go.mod`, `package.json` or `pyproject.toml` in a subdirectory isn't read (its lockfiles one directory down are in the key, as before). A workflow step's `working-directory` and a matrix aren't applied to its command.
- **Some managers.** Poetry, Pipenv, Conda, Gradle, Maven and Bundler projects get no dependency install (Poetry is noted), and Java, Ruby and the rest are installed only when mise configuration or a dev container feature names them. A `package.json` without a lockfile installs nothing.
- **Downloads need the egress allowlist.** mise fetches toolchains from `mise-versions.jdx.dev`, `dl.google.com` and `go.dev` (Go), `sum.golang.org`, `nodejs.org`, `static.rust-lang.org`, and GitHub's releases (`github.com`, `api.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com`) for Python, uv, Bun and most other tools; these are on every workspace's allowlist, as are the package registries dependency steps use (npm, PyPI, crates.io, Go's proxy and the `storage.googleapis.com` it redirects module downloads to). The allowlist is fixed by Pim's deployment, not set per repository or user. A tool hosted elsewhere fails its step. Without a network, every step fails, is recorded, and the thread goes on with the image's tools.
- **The CLIs share the PATH.** mise's shims come first for the coding CLIs too, so a repository that pins a very old Node runs the Node-based CLI wrappers with it.
- **Cloudflare Sandbox** keeps no environments, so it neither provisions, finds checks, nor runs a setup script.
- **Not tested against a live sandbox.** The Worker's tests run the steps in the in-memory workspace. The steps themselves were run for real with mise 2026.10.4 for Go, pnpm, requirements files, uv, Rust and a mise repository, and the Go, pnpm and mise ones in the workspace image as its user, after which a command with only the image's PATH found the pinned versions; but not under gVisor or behind the egress proxy, so the allowlist above is what mise is documented to reach, not what a live run was seen to need.
