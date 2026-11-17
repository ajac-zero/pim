#!/bin/sh
# `docker compose` with this directory's files: the stack alone, or with compose.local.yaml (plain HTTP on 127.0.0.1:8088) when .env's PIM_PUBLIC_URL is http://,
# and with compose.dev.yaml (this checkout's sources) when PIM_DEV=1.   deploy/compose/pim.sh up -d | ps | logs -f gate | restart gate | down
set -eu
cd "$(dirname "$0")"
files="-f compose.yaml"
# PIM_LOCAL=1 is for a stack behind a tunnel or portal: an https PIM_PUBLIC_URL, with Caddy still on plain HTTP on 127.0.0.1:8088 (PIM_DOMAIN=:8088).
if grep -q '^PIM_PUBLIC_URL=http://' .env || [ "${PIM_LOCAL:-}" = 1 ]; then files="$files -f compose.local.yaml"; fi
[ "${PIM_DEV:-}" = 1 ] && files="$files -f compose.dev.yaml"
exec docker compose $files "$@"
