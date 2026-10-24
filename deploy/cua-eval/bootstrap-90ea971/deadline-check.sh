#!/usr/bin/env bash
# Soft 48h deadline. Past it, stop EVERY evaluation unit (public proxy first, then runners, the login
# handoff, daemon, audio, desktop) and write the "expired" marker, which every unit's
# ConditionPathExists=! honours so nothing restarts after a reboot or a manual start. This reduces
# exposure only: it does NOT stop Azure compute billing (a guest shutdown
# leaves the VM allocated). Deallocate from Azure; see docs/AZURE-OPTIONS.md.
#
# Env: CUA_EVAL_STATE_DIR (/var/lib/cua-evaluation), CUA_EVAL_DEADLINE_HOURS
# (48), CUA_EVAL_NOW (epoch seconds; test seam), CUA_EVAL_SYSTEMCTL
# (systemctl; test seam), CUA_EVAL_CREATED_EPOCH (optional, set by the operator in
# /etc/cua-evaluation/config.env to the real Azure creation time). The clock starts at the EARLIER of that and
# the first-bootstrap epoch, so neither a later value nor a bootstrap re-run can extend the window.
set -euo pipefail

STATE="${CUA_EVAL_STATE_DIR:-/var/lib/cua-evaluation}"
HOURS="${CUA_EVAL_DEADLINE_HOURS:-48}"
NOW="${CUA_EVAL_NOW:-$(date +%s)}"
SYSTEMCTL="${CUA_EVAL_SYSTEMCTL:-systemctl}"

START=""
[ -r "$STATE/bootstrap-epoch" ] && START="$(cat "$STATE/bootstrap-epoch")"
CREATED="${CUA_EVAL_CREATED_EPOCH:-}"
case "$START$CREATED$HOURS$NOW" in *[!0-9]*) echo "non-numeric epoch/hours" >&2; exit 1 ;; esac
if [ -n "$CREATED" ] && { [ -z "$START" ] || [ "$CREATED" -lt "$START" ]; }; then START="$CREATED"; fi
[ -n "$START" ] || { echo "no start epoch: bootstrap has not completed and none was set"; exit 0; }

DEADLINE=$((START + HOURS * 3600))
if [ "$NOW" -lt "$DEADLINE" ]; then
  echo "ok: $(((DEADLINE - NOW) / 60)) minutes left before the soft deadline"
  exit 0
fi

echo "soft deadline passed ($HOURS h): stopping cua services"
: >"$STATE/expired"
for unit in cua-viewer-proxy cua-amp-runner-login cua-amp-runner cua-amp-login cua-spacesd cua-audio cua-desktop; do
  "$SYSTEMCTL" stop "$unit.service" || true
done
echo "Azure compute is still billed until the VM is deallocated."
