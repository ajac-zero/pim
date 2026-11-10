// Small repositories, as their files, for detecting what a repository needs (src/coding/repo-environment.ts). Each is
// written the way such a repository usually is, with the files that matter and a few that don't.
import { verifyTool } from "../../src/coding/repo-environment";

/** A Go module pinned by its toolchain directive, with a Makefile, a GitHub workflow that starts Postgres, and a Dockerfile. */
export const GO_REPO: Record<string, string> = {
	"go.mod": "module example.com/widgets\n\ngo 1.22\n\ntoolchain go1.22.5\n\nrequire github.com/google/uuid v1.6.0\n",
	"go.sum": "github.com/google/uuid v1.6.0 h1:abc=\n",
	"main.go": "package main\n\nfunc main() {}\n",
	Dockerfile: "FROM --platform=$BUILDPLATFORM golang:1.21-alpine AS build\nRUN go build ./...\nFROM gcr.io/distroless/static\n",
	Makefile: ".PHONY: build test lint\n\nbuild:\n\tgo build ./...\n\ntest: build\n\tgo test -race ./...\n\nlint:\n\tgolangci-lint run\n\nVERSION := 1\n\ndeploy:\n\t./deploy.sh\n",
	".github/workflows/ci.yml": `name: CI
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
      redis:
        image: redis:7
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version-file: go.mod
      - run: go mod download
      - name: Vet
        run: go vet ./...
      - name: Test
        run: |
          go test -race \\
            -count=1 ./...
          echo "done"
      - run: make test
      - run: ./deploy.sh \${{ secrets.TOKEN }}
`,
};

/** A pnpm workspace whose packageManager pins pnpm, with .nvmrc for Node and a Gitea workflow. */
export const PNPM_REPO: Record<string, string> = {
	"package.json": JSON.stringify({
		name: "web",
		private: true,
		packageManager: "pnpm@9.15.0+sha512.76e2379760a4328ec4415815bcd6628dee727af3779aaa4c914e3944156c4299921a89f976381ee107d41f12cfa4b66681ca9c718f0668fa0831ed4c6d8ba56c",
		engines: { node: ">=18" },
		scripts: { build: "vite build", test: "vitest run", "test:watch": "vitest", lint: "biome check .", "lint:fix": "biome check --write .", typecheck: "tsc --noEmit", dev: "vite" },
	}),
	"pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
	".nvmrc": "v20.11.1\n",
	".gitea/workflows/check.yaml": `on: push
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile
      - run: "pnpm test"
      - run: pnpm run lint # Biome
`,
};

/** An npm package with a lockfile, a caret range for Node and npm's placeholder test script. */
export const NPM_REPO: Record<string, string> = {
	"package.json": JSON.stringify({ name: "lib", engines: { node: "^18.17.0 || ^20.3.0" }, scripts: { test: 'echo "Error: no test specified" && exit 1', lint: "eslint ." } }),
	"package-lock.json": '{ "lockfileVersion": 3 }\n',
};

/** A uv project: requires-python, uv.lock and pytest in its dev dependencies, and nothing else to run. */
export const UV_REPO: Record<string, string> = {
	"pyproject.toml": `[project]
name = "service"
requires-python = ">=3.11,<3.14" # supported range
dependencies = ["httpx>=0.27"]

[dependency-groups]
dev = [
  "pytest>=8",
  "ruff",
]

[tool.uv]
package = true
`,
	"uv.lock": "version = 1\n",
	"src/service/__init__.py": "",
};

/** A Python project with requirements files and .python-version. */
export const PIP_REPO: Record<string, string> = {
	"requirements.txt": "flask==3.0.0\n",
	"requirements-dev.txt": "pytest==8.0.0\n",
	".python-version": "3.12.4\n",
	"app.py": "print('hi')\n",
};

/** A Rust crate pinned by rust-toolchain.toml, with Cargo.lock. */
export const RUST_REPO: Record<string, string> = {
	"Cargo.toml": '[package]\nname = "tool"\nversion = "0.1.0"\nrust-version = "1.70"\n',
	"Cargo.lock": "version = 3\n",
	"rust-toolchain.toml": '[toolchain]\nchannel = "1.79.0"\ncomponents = ["clippy", "rustfmt"]\n',
	"src/main.rs": "fn main() {}\n",
};

/** A repository whose tools and tasks are mise's: mise.toml pins Go and Node over go.mod and .nvmrc, and a dev container adds Python. */
export const MISE_REPO: Record<string, string> = {
	"mise.toml": `[tools]
go = "1.23.2"
node = ["22", "20"]
"npm:prettier" = { version = "3.3.3", os = ["linux"] }

[tasks.test]
run = "go test ./..."

[tasks."lint:go"]
run = "golangci-lint run"

[tasks.build]
run = "go build ./..."
`,
	"go.mod": "module example.com/both\n\ngo 1.21\n",
	".nvmrc": "18\n",
	".devcontainer/devcontainer.json": `{
  // A dev container, written with comments and trailing commas.
  "image": "mcr.microsoft.com/devcontainers/go:1-1.21-bookworm",
  "features": {
    "ghcr.io/devcontainers/features/python:1": { "version": "3.12" },
    "ghcr.io/devcontainers/features/go:1": { "version": "1.20" },
    "ghcr.io/devcontainers/features/docker-in-docker:2": {},
  },
}
`,
	"mise-tasks/check": "#!/bin/sh\ngo vet ./...\n",
};

/** The script that installs the mise tool `spec` (such as `go@1.22`) and then checks that it runs, as provisioning builds it; `between` runs after the install. */
export function installed(spec: string, ...between: string[]): string {
	const tool = spec.replace(/^npm:/, "").replace(/@.*/, "");
	return [`mise use --global --yes ${spec}`, ...between, verifyTool(tool)].join(" && ");
}
