#!/usr/bin/env bash
# Readies a Pim coding thread's workspace for this repository before its first turn: installs the
# dependencies of the Worker and the web app (one pnpm workspace) from the lockfile. Pim runs it in
# the sandbox with no secrets and only the package registries reachable, and keeps a snapshot of the
# result for the threads after it, so it does nothing else. pnpm is the workspace image's own;
# corepack ignores the egress proxy, so it isn't used. Running it again changes nothing.
set -euo pipefail
pnpm install --frozen-lockfile
