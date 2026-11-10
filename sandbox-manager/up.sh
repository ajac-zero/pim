#!/usr/bin/env bash
# Rebuilds and starts the sandbox manager stack with the git commit baked in, so /health reports it.
# Usage: ./up.sh [extra docker compose up args]   (same env vars as README: MANAGER_TOKEN etc.)
set -euo pipefail
cd "$(dirname "$0")"
BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD)}" || true
if [ -z "$BUILD_SHA" ] || [ "$BUILD_SHA" = unknown ]; then
  echo "up.sh: cannot determine the git commit to stamp into the image (set BUILD_SHA or run from a git checkout)" >&2
  exit 1
fi
export BUILD_SHA
exec docker compose up -d --build "$@"
