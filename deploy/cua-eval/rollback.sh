#!/usr/bin/env bash
# Undoes install.sh on the Cua evaluation VM, as root: the VM's Caddyfile and deadline-check.sh
# come back byte for byte, the bridge and the agents' runner stop and their units and files go,
# and cua-spacesd restarts briefly so no media session or driver state of the bridge's time
# survives. It works after a partial install too. It keeps what holds anyone's data: the users
# pim-bridge and pim-agent, /home/pim-agent (the agents' files), /var/lib/pim-cua-bridge (who had
# the machine) and the backups, moved to /var/backups/pim-cua-bridge.rolled-back.<time>. To remove
# those as well, afterwards:
#   userdel -r pim-agent; userdel pim-bridge; rm -rf /var/lib/pim-cua-bridge /var/backups/pim-cua-bridge*
#
# It fails closed, in this order, stopping at the first thing it can't verify, with exit 1:
#   1. The viewer route (cua-viewer-proxy) stops, and stays down unless every later step succeeds.
#   2. The bridge and the runner stop: their units inactive, their cgroups empty, nothing on port
#      3290 or the runner's socket. Until that holds, the patched deadline-check.sh (which stops them
#      at the deadline), the Caddyfile, the units, the code and the backups all stay as they are.
#   3. The Caddyfile comes back (reviewed SHA-256, `caddy validate`), and only then deadline-check.sh.
#   4. Only then do the units and the code go, cua-spacesd restarts, and, if it did, the viewer route
#      starts again.
# A failure in 3 keeps the units (stopped, disabled) and the code as they are, for a person to look
# at. Running it again after fixing the cause is safe.
set -uo pipefail
umask 077

# PIM_ROLLBACK_FS prefixes every path, so test_packaging.py can rehearse failures in a scratch
# folder with stand-in commands; on the VM it is unset.
FS="${PIM_ROLLBACK_FS:-}"
BOOT="$FS/opt/cua-evaluation/bootstrap"
CADDYFILE="$BOOT/proxy/Caddyfile"
DEADLINE="$BOOT/bin/deadline-check.sh"
BACKUP="$FS/var/backups/pim-cua-bridge"
CADDY="$FS/usr/local/bin/caddy"
BASIC="$FS/etc/cua-evaluation/credentials/viewer-basic"
SOCKET="$FS/run/pim-agent-exec.sock"
CGROUPS="$FS/sys/fs/cgroup/system.slice"
UNITS=(pim-cua-bridge.service pim-agent-exec.socket pim-agent-exec.service)
# The reviewed originals (bootstrap 90ea971), which is all this restores; vm_patch.py has the same.
CADDY_ORIGINAL=d529536ac736facba6ef2f41fb097b51427a97f49be9d4e261642702f2e8fdf5
DEADLINE_ORIGINAL=d871bd3295425aee16e5e2d7c8b1809ca666d72ab57e5f57680ada8bac44eacc

say() { printf 'pim-cua-bridge rollback: %s\n' "$*"; }
problem() { printf 'pim-cua-bridge rollback: PROBLEM: %s\n' "$*" >&2; }
sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

say "stopping the viewer route"
if ! systemctl stop cua-viewer-proxy.service || systemctl is-active --quiet cua-viewer-proxy.service; then
  problem "cua-viewer-proxy.service didn't stop; nothing else is changed while it may still serve"
  exit 1
fi

say "stopping the bridge and the agents' runner (and whatever the agents' commands left running)"
quiet=1
for unit in "${UNITS[@]}"; do
  if [ -e "$FS/etc/systemd/system/$unit" ] || systemctl is-active --quiet "$unit"; then
    systemctl stop "$unit" || { problem "systemctl stop $unit failed"; quiet=0; }
    systemctl disable "$unit" >/dev/null 2>&1 || true
  fi
done
for _ in $(seq 1 10); do
  busy=""
  for unit in "${UNITS[@]}"; do
    systemctl is-active --quiet "$unit" && busy="$busy $unit"
    procs="$CGROUPS/$unit/cgroup.procs"
    [ -e "$procs" ] && [ -n "$(cat "$procs" 2>/dev/null || echo unreadable)" ] && busy="$busy $unit's cgroup"
  done
  [ -n "$(ss -Hltn 'sport = :3290' 2>/dev/null || echo unknown)" ] && busy="$busy port-3290"
  [ -e "$SOCKET" ] && busy="$busy $SOCKET"
  [ -z "$busy" ] && break
  sleep 1
done
if [ -n "$busy" ]; then
  problem "still running or listening after stopping:$busy"
  quiet=0
fi
keep() {
  problem "$1: the viewer route stays down; the patched deadline-check.sh, the units, the code and the backups in $BACKUP stay as they are"
  exit 1
}
[ "$quiet" = 1 ] || keep "the bridge or the runner may still run"

restore() { # restore FILE BACKUP WANT
  if [ "$(sha "$1")" = "$3" ]; then
    say "$1 is the original already"
    return 0
  fi
  { [ -f "$2" ] && [ "$(sha "$2")" = "$3" ]; } || { problem "no sound backup of $1 in $BACKUP; it is left as it is"; return 1; }
  cp -p "$1" "$BACKUP/$(basename "$1").replaced.$(date +%s)" || return 1
  cp -p "$2" "$1.pim-old" && mv -f "$1.pim-old" "$1" || { problem "couldn't put $2 in place of $1"; return 1; }
  [ "$(sha "$1")" = "$3" ] || { problem "$1 isn't the original after restoring it"; return 1; }
  say "restored $1"
}
restore "$CADDYFILE" "$BACKUP/Caddyfile.orig" "$CADDY_ORIGINAL" || keep "the Caddyfile isn't the original"
scratch="$(mktemp -d)"
if ! (
  IFS= read -r line <"$BASIC"
  export CUA_EVAL_BASIC_USER="${line%%:*}" CUA_EVAL_BASIC_HASH="${line#*:}"
  unset line
  export HOME="$scratch" XDG_DATA_HOME="$scratch" XDG_CONFIG_HOME="$scratch"
  exec "$CADDY" validate --config "$CADDYFILE" --adapter caddyfile
) >"$scratch/validate.log" 2>&1; then
  rm -rf "$scratch"
  keep "caddy validate refused the restored Caddyfile"
fi
rm -rf "$scratch"
restore "$DEADLINE" "$BACKUP/deadline-check.sh.orig" "$DEADLINE_ORIGINAL" || keep "deadline-check.sh isn't the original"

for unit in "${UNITS[@]}"; do
  rm -f "$FS/etc/systemd/system/$unit"
done
systemctl daemon-reload || keep "systemctl daemon-reload failed"
systemctl reset-failed "${UNITS[@]}" 2>/dev/null || true
rm -rf "$FS/opt/pim-cua-bridge" "$FS/etc/pim-cua-bridge"

say "restarting cua-spacesd briefly, then the viewer route"
failed=0
if systemctl restart cua-spacesd.service && systemctl is-active --quiet cua-spacesd.service; then
  systemctl start cua-viewer-proxy.service || failed=1
else
  problem "cua-spacesd didn't restart, so the viewer route stays down"
  failed=1
fi
for unit in cua-spacesd.service cua-viewer-proxy.service; do
  systemctl is-active --quiet "$unit" || { problem "$unit isn't running (if the soft deadline passed, that's expected)"; failed=1; }
done
if [ -d "$BACKUP" ]; then
  kept="$BACKUP.rolled-back.$(date +%s)"
  mv "$BACKUP" "$kept"
  say "the backups are in $kept now"
fi
if [ "$failed" = 0 ]; then
  say "done: Caddyfile $(sha "$CADDYFILE"), deadline-check.sh $(sha "$DEADLINE"); kept the users, /home/pim-agent and /var/lib/pim-cua-bridge"
else
  say "done, with the problems above"
  exit 1
fi
