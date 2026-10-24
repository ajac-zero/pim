#!/usr/bin/env bash
# Undoes install.sh on the Cua evaluation VM, as root: the VM's Caddyfile and deadline-check.sh
# come back byte for byte, the bridge and the agents' runner stop and their units and files go,
# and cua-spacesd restarts briefly so no media session or driver state of the bridge's time
# survives. It works after a partial install too. It keeps what holds anyone's data: the users
# pim-bridge and pim-agent, /home/pim-agent (the agents' files), /var/lib/pim-cua-bridge (who had
# the machine) and the backups, moved to /var/backups/pim-cua-bridge.rolled-back.<time>. To remove
# those as well, afterwards:
#   userdel -r pim-agent; userdel pim-bridge; rm -rf /var/lib/pim-cua-bridge /var/backups/pim-cua-bridge*
set -euo pipefail
umask 077

BOOT=/opt/cua-evaluation/bootstrap
CADDYFILE="$BOOT/proxy/Caddyfile"
DEADLINE="$BOOT/bin/deadline-check.sh"
BACKUP=/var/backups/pim-cua-bridge
# The reviewed originals (bootstrap 90ea971), which is all this restores; vm_patch.py has the same.
CADDY_ORIGINAL=d529536ac736facba6ef2f41fb097b51427a97f49be9d4e261642702f2e8fdf5
DEADLINE_ORIGINAL=d871bd3295425aee16e5e2d7c8b1809ca666d72ab57e5f57680ada8bac44eacc

say() { printf 'pim-cua-bridge rollback: %s\n' "$*"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

restore() { # restore FILE BACKUP WANT
  if [ "$(sha "$1")" = "$3" ]; then
    say "$1 is the original already"
    return
  fi
  { [ -f "$2" ] && [ "$(sha "$2")" = "$3" ]; } || { echo "pim-cua-bridge rollback: no sound backup of $1 in $BACKUP; it is left as it is" >&2; return 1; }
  cp -p "$1" "$BACKUP/$(basename "$1").replaced.$(date +%s)"
  cp -p "$2" "$1.pim-old"
  mv -f "$1.pim-old" "$1"
  say "restored $1"
}

say "stopping the viewer route"
systemctl stop cua-viewer-proxy.service || true
failed=0 restored=1
restore "$CADDYFILE" "$BACKUP/Caddyfile.orig" "$CADDY_ORIGINAL" || restored=0
restore "$DEADLINE" "$BACKUP/deadline-check.sh.orig" "$DEADLINE_ORIGINAL" || restored=0

say "stopping the bridge and the agents' runner (and whatever the agents' commands left running)"
systemctl disable --now pim-cua-bridge.service pim-agent-exec.socket 2>/dev/null || true
systemctl stop pim-agent-exec.service 2>/dev/null || true
for _ in $(seq 1 10); do ss -Hltn 'sport = :3290' | grep -q . || break; sleep 1; done
for unit in pim-cua-bridge.service pim-agent-exec.socket pim-agent-exec.service; do
  rm -f "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl reset-failed pim-cua-bridge.service pim-agent-exec.service pim-agent-exec.socket 2>/dev/null || true
rm -rf /opt/pim-cua-bridge /etc/pim-cua-bridge

say "restarting cua-spacesd briefly, then the viewer route"
systemctl restart cua-spacesd.service || failed=1
systemctl start cua-viewer-proxy.service || failed=1

for unit in cua-spacesd.service cua-viewer-proxy.service; do
  systemctl is-active --quiet "$unit" || { say "$unit isn't running (if the soft deadline passed, that's expected)"; failed=1; }
done
if [ "$restored" = 1 ] && [ -d "$BACKUP" ]; then
  kept="$BACKUP.rolled-back.$(date +%s)"
  mv "$BACKUP" "$kept"
  say "the backups are in $kept now"
fi
if [ "$failed" = 0 ] && [ "$restored" = 1 ]; then
  say "done: Caddyfile $(sha "$CADDYFILE"), deadline-check.sh $(sha "$DEADLINE"); kept the users, /home/pim-agent and /var/lib/pim-cua-bridge"
else
  say "done, with the problems above"
  exit 1
fi
