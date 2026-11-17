#!/bin/sh
# `docker compose` with this directory's files: the stack alone, or with compose.local.yaml (plain HTTP on 127.0.0.1:8088) when .env's PIM_PUBLIC_URL is http://,
# and with compose.dev.yaml (this checkout's sources) when PIM_DEV=1.   deploy/compose/pim.sh up -d | ps | logs -f gate | restart gate | down
set -eu
cd "$(dirname "$0")"
files="-f compose.yaml"
grep -q '^PIM_PUBLIC_URL=http://' .env && files="$files -f compose.local.yaml"
[ "${PIM_DEV:-}" = 1 ] && files="$files -f compose.dev.yaml"
exec docker compose $files "$@"
