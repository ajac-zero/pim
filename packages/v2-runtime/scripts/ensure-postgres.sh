#!/usr/bin/env bash
# Installs a PostgreSQL server for the runtime's tests when none is on the machine. The tests start their own throwaway
# cluster from these binaries (see test/support/global-setup.ts); they never touch the system cluster. Set
# PIM_V2_PG_URL to run against an existing server instead.
set -euo pipefail
if ls /usr/lib/postgresql/*/bin/initdb >/dev/null 2>&1 || command -v initdb >/dev/null 2>&1; then
	echo "PostgreSQL binaries already installed."
	exit 0
fi
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
$SUDO apt-get update -qq
DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq postgresql
echo "PostgreSQL installed."
