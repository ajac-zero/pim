#!/usr/bin/env bash
# Rebuilds and starts the sandbox manager stack with the git commit baked in, so /health reports it,
# then makes sure hostopsd (the host operations daemon, see hostopsd/README.md) is installed and
# current. That is all an update takes: git pull && sandbox-manager/up.sh
# Usage: ./up.sh [extra docker compose up args]   (same env vars as README: MANAGER_TOKEN etc.)
set -euo pipefail
cd "$(dirname "$0")"
BUILD_SHA="${BUILD_SHA:-$(git rev-parse --short HEAD)}" || true
if [ -z "$BUILD_SHA" ] || [ "$BUILD_SHA" = unknown ]; then
  echo "up.sh: cannot determine the git commit to stamp into the image (set BUILD_SHA or run from a git checkout)" >&2
  exit 1
fi
export BUILD_SHA
docker compose up -d --build "$@"

# Installs or updates hostopsd when it is missing or stale. The manager stack is already up, so
# nothing here may fail the script: problems are warnings.
ensure_hostopsd() {
  local etc=${HOSTOPSD_ETC:-/etc/hostopsd}
  local installer="$PWD/hostopsd/install.sh"
  local checkout url cmd

  [ -f "$installer" ] || return 0
  checkout=$(cd .. && pwd)

  # Pim's origin: HOSTOPS_URL in the environment, else what is installed, else sandbox-manager/.env,
  # else the default.
  url=${HOSTOPS_URL:-}
  [ -n "$url" ] || url=$(sed -n 's/^HOSTOPS_URL=//p' "$etc/env" 2>/dev/null | tail -n 1 || true)
  [ -n "$url" ] || url=$(sed -n 's/^HOSTOPS_URL=//p' "$etc/installed" 2>/dev/null | tail -n 1 || true)
  [ -n "$url" ] || url=$(sed -n 's/^HOSTOPS_URL=//p' .env 2>/dev/null | tail -n 1 || true)
  url=${url:-https://pim.ajac-zero.com}
  url=${url%/}

  # Current means the stamp install.sh left matches this install.sh, unit, URL and checkout, and
  # the daemon is running (or was revoked in Pim's Settings, which keeps it stopped on purpose).
  local want got
  want="INSTALL_SHA=$(sha256sum <"$installer" | cut -d' ' -f1)
UNIT_SHA=$(sha256sum <hostopsd/hostopsd.service | cut -d' ' -f1)
HOSTOPS_URL=$url
PIM_CHECKOUT=$checkout"
  got=$(grep -v '^REVOKED=' "$etc/installed" 2>/dev/null || true)
  if [ "$got" = "$want" ]; then
    if grep -qx 'REVOKED=1' "$etc/installed" || systemctl is-active --quiet hostopsd 2>/dev/null; then return 0; fi
  fi

  cmd=("$installer" --url "$url" --checkout "$checkout")
  local manual="sudo ${cmd[*]}"
  if [ "$(id -un)" = hostopsd ]; then
    echo "up.sh: hostopsd is out of date; run '$manual' from a login with sudo to update its unit" >&2
    return 0
  fi
  echo "up.sh: installing hostopsd (needs sudo once: it creates the hostopsd system user and its systemd unit, and gives it access to this checkout)"
  local rc=0
  if [ "$(id -u)" = 0 ]; then
    "${cmd[@]}" || rc=$?
  elif ! command -v sudo >/dev/null; then
    echo "up.sh: sudo is not available; to finish installing hostopsd run: $manual" >&2
    return 0
  elif [ -t 0 ]; then
    sudo "${cmd[@]}" || rc=$?
  else
    sudo -n "${cmd[@]}" || rc=$?
  fi
  if [ "$rc" != 0 ]; then
    echo "up.sh: hostopsd was not installed (exit $rc); the manager is up. To retry run: $manual" >&2
  fi
}
ensure_hostopsd || true
