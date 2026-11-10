#!/usr/bin/env bash
# Rebuilds and starts the sandbox manager stack with the git commit baked in, so /health reports it.
# Usage: ./up.sh [extra docker compose up args]   (same env vars as README: MANAGER_TOKEN etc.)
set -euo pipefail
cd "$(dirname "$0")"
export BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo unknown)}"
exec docker compose up -d --build "$@"
