#!/bin/sh
# `docker compose` with this directory's files: the stack alone, or with compose.local.yaml (plain HTTP on 127.0.0.1:8088) when .env's PIM_PUBLIC_URL is http://,
# and with compose.dev.yaml (this checkout's sources) when PIM_DEV=1.   deploy/compose/pim.sh up -d | ps | logs -f gate | restart gate | down
set -eu
cd "$(dirname "$0")"
files="-f compose.yaml"
grep -q '^PIM_PUBLIC_URL=http://' .env && files="$files -f compose.local.yaml"
if [ "${PIM_DEV:-}" = 1 ]; then
	# compose.dev.yaml mounts ../../web/dist; Docker would create a missing one empty and owned by root, and the Gate would serve 404 at /.
	[ -f ../../web/dist/index.html ] || { echo "PIM_DEV=1 needs the built web app: run pnpm --filter pim-web build first" >&2; exit 1; }
	files="$files -f compose.dev.yaml"
fi
exec docker compose $files "$@"
