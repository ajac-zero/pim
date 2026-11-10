#!/usr/bin/env bash
# Readies a Pim coding thread's workspace for this repository before its first turn: installs the
# dependencies of the Worker and the web app (one pnpm workspace) from the lockfile. Pim runs it in
# the sandbox with no secrets and only the package registries reachable, and keeps a snapshot of the
# result for the threads after it when restoring one is quicker than running this again, so it does
# nothing else. pnpm's store is on the workspace's dependency cache volume (the sandbox sets
# pnpm_config_store_dir), so running it again downloads nothing. pnpm is the workspace image's own;
# corepack ignores the egress proxy, so it isn't used. Running it again changes nothing.
set -euo pipefail
pnpm install --frozen-lockfile
# env cache re-measure 2026-11-10
