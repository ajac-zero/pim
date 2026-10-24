#!/usr/bin/env bash
# Installs pim-cua-bridge on the Cua evaluation VM bootstrapped at Sandbox commit 90ea971. For the
# VM's operator to run, as root, after review, from a copy of this folder (see docs/cua-evaluation.md,
# "Installing on the VM"); rollback.sh undoes it.
#
#   install.sh --digest-file FILE   # FILE: root-owned, mode 0600/0640/0400/0440, holding the SHA-256 (64 hex)
#   install.sh --digest HEX         #   of Pim's bridge credential; never the credential itself
#   install.sh ... --check          # only the checks: changes nothing
#
# What it does, in order, stopping at the first thing that isn't as reviewed:
#   1. Checks this folder against SHA256SUMS, and the VM: not expired, the bootstrap's Caddyfile and
#      deadline-check.sh byte for byte as reviewed (by SHA-256), its units running, nothing of the
#      bridge's there yet.
#   2. Makes the users: pim-bridge (system, no login) and pim-agent (no administrator groups, no
#      sudo, password locked), and /home/pim-agent/pim, the agents' workspace.
#   3. Copies the bridge, its Caddy fragments and its three units; writes bridge.env with the digest.
#   4. Validates the patched Caddyfile (vm_patch.py) with the real Basic credential in its
#      environment, never printed, before anything that serves changes.
#   5. Keeps the two original files in /var/backups/pim-cua-bridge (root-only, outside any web root).
#   6. Stops the viewer route, puts the patched Caddyfile and deadline-check.sh in place, restarts
#      cua-spacesd briefly (closing every media session from before the bridge), starts the runner's
#      socket and the bridge, and starts the viewer route again.
#   7. Checks from the VM itself that the route answers as reviewed, with no credential.
# A failure in step 6 or 7 runs rollback.sh. The desktop, audio and the rest stay up throughout.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT=/opt/cua-evaluation/bootstrap
CADDYFILE="$BOOT/proxy/Caddyfile"
DEADLINE="$BOOT/bin/deadline-check.sh"
BACKUP=/var/backups/pim-cua-bridge
SITE=cua-eval.ajac-zero.com
UNITS=(pim-cua-bridge.service pim-agent-exec.socket pim-agent-exec.service)

say() { printf 'pim-cua-bridge install: %s\n' "$*"; }
die() { printf 'pim-cua-bridge install: REFUSED: %s\n' "$*" >&2; exit 1; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

digest="" check_only=0
while [ $# -gt 0 ]; do
  case "$1" in
    --digest) digest="${2:-}"; shift 2 ;;
    --digest-file)
      file="${2:-}"; shift 2
      { [ -f "$file" ] && [ ! -L "$file" ]; } || die "--digest-file must be a regular file"
      [ "$(stat -c %u "$file")" = 0 ] || die "--digest-file must be owned by root"
      mode="$(stat -c %a "$file")"
      case "$mode" in 600 | 640 | 400 | 440) ;; *) die "--digest-file must be mode 0600, 0640, 0400 or 0440, not $mode" ;; esac
      read -r digest _ <"$file" || true
      ;;
    --check) check_only=1; shift ;;
    *) die "unknown argument (see the top of this file)" ;;
  esac
done
digest="$(printf %s "$digest" | tr 'A-F' 'a-f')"
[[ "$digest" =~ ^[0-9a-f]{64}$ ]] || die "give the credential's SHA-256 (64 hex digits) with --digest-file or --digest, never the credential"
[ "$(id -u)" = 0 ] || die "run as root"

# ── 1. Checks ───────────────────────────────────────────────────────────────────────────────────
say "1/7 checking this folder and the VM"
(cd "$HERE" && sha256sum --quiet --strict -c SHA256SUMS) || die "this folder doesn't match its SHA256SUMS"
say "    sources: SHA256SUMS $(sha "$HERE/SHA256SUMS")"
[ ! -e /var/lib/cua-evaluation/expired ] || die "the evaluation's soft deadline has passed (/var/lib/cua-evaluation/expired)"
# The deadline itself, not only its marker (written by a timer that may not have run yet): the time
# from the first bootstrap, as deadline-check.sh counts it, must leave at least an hour.
# deadline-check.sh's own calculation (vm_patch.py deadline-left: the earlier of the bootstrap
# epoch and CUA_EVAL_CREATED_EPOCH, plus CUA_EVAL_DEADLINE_HOURS), and its unit may not set any of
# them some other way. At least an hour must be left, here and again just before switching over.
time_left() {
  local env
  env="$(systemctl show -p Environment --value cua-eval-deadline.service)" || die "can't read cua-eval-deadline.service"
  [[ "$env" != *CUA_EVAL_* ]] || die "cua-eval-deadline.service sets CUA_EVAL_* itself, which the installer doesn't follow"
  left="$(python3 -I "$HERE/vm_patch.py" deadline-left)" || die "the soft deadline can't be established"
  [ "$left" -ge 3600 ] || die "the soft deadline is less than an hour away ($((left / 60)) minutes): not installing"
}
time_left
say "    deadline: $((left / 3600)) h left"
read -r caddy_original caddy_patched < <(python3 -I "$HERE/vm_patch.py" hashes | awk '$1 == "caddyfile" { print $3, $5 }')
read -r deadline_original deadline_patched < <(python3 -I "$HERE/vm_patch.py" hashes | awk '$1 == "deadline" { print $3, $5 }')
now="$(sha "$CADDYFILE")"
[ "$now" != "$caddy_patched" ] || die "$CADDYFILE is already patched: the bridge is installed (rollback.sh first)"
[ "$now" = "$caddy_original" ] || die "$CADDYFILE is not the reviewed one (SHA-256 $now, expected $caddy_original)"
now="$(sha "$DEADLINE")"
[ "$now" != "$deadline_patched" ] || die "$DEADLINE is already patched: the bridge is installed (rollback.sh first)"
[ "$now" = "$deadline_original" ] || die "$DEADLINE is not the reviewed one (SHA-256 $now, expected $deadline_original)"
for unit in cua-spacesd.service cua-viewer-proxy.service; do
  [ -f "/etc/systemd/system/$unit" ] || die "no $unit: this isn't the bootstrapped VM"
  systemctl is-active --quiet "$unit" || die "$unit isn't running"
done
for path in /etc/cua/spacesd.env /etc/cua-evaluation/credentials/viewer-basic /usr/local/bin/caddy /usr/bin/python3; do
  [ -e "$path" ] || die "no $path"
done
[ "$(stat -c '%u %g %a' /etc/cua/spacesd.env)" = "0 0 600" ] || die "/etc/cua/spacesd.env (spacesd's root token) is $(stat -c '%U:%G %a' /etc/cua/spacesd.env), not root:root 600"
[ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || die "/sys/fs/cgroup isn't the unified cgroup v2 hierarchy, which the runner's accounting and IPAddressDeny need"
systemd_version="$(systemctl --version | awk 'NR == 1 { print $2 }')"
[[ "$systemd_version" =~ ^[0-9]+$ ]] && [ "$systemd_version" -ge 247 ] || die "systemd $systemd_version is older than 247"
python3 -I -c 'import sys; sys.exit(sys.version_info < (3, 10))' || die "python3 must be 3.10 or newer"
for path in /opt/pim-cua-bridge /etc/pim-cua-bridge "$BACKUP" "${UNITS[@]/#//etc/systemd/system/}"; do
  [ ! -e "$path" ] || die "$path exists already: the bridge is (partly) installed (rollback.sh first)"
done
if ss -Hltn 'sport = :3290' | grep -q .; then die "something listens on port 3290 already"; fi
say "    VM: as reviewed ($(/usr/local/bin/caddy version | cut -d' ' -f1), python $(python3 -I -c 'import platform; print(platform.python_version())'))"
if command -v sudo >/dev/null; then
  say "    desktop user cua: $(sudo -n -l -U cua 2>&1 | tail -n1)"
fi
for user in pim-bridge pim-agent; do
  if id "$user" >/dev/null 2>&1; then
    groups=" $(id -nG "$user") "
    for admin in sudo admin wheel root; do
      [[ "$groups" != *" $admin "* ]] || die "the existing user $user is in $admin"
    done
  fi
done
if [ "$check_only" = 1 ]; then say "checks passed; nothing changed (--check)"; exit 0; fi

# ── 2. Users ────────────────────────────────────────────────────────────────────────────────────
say "2/7 users"
if ! id pim-bridge >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group pim-bridge
fi
if ! id pim-agent >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group pim-agent
fi
passwd -l pim-agent >/dev/null
chmod 0750 /home/pim-agent
install -d -o pim-agent -g pim-agent -m 0750 /home/pim-agent/pim
for user in pim-bridge pim-agent; do
  groups=" $(id -nG "$user") "
  for admin in sudo admin wheel root; do
    [[ "$groups" != *" $admin "* ]] || die "$user is in $admin"
  done
  if command -v sudo >/dev/null; then
    sudo -n -l -U "$user" 2>&1 | grep -q "is not allowed to run sudo" || die "sudo -l -U $user grants something: remove it from sudoers first"
  fi
done


# ── 3. Files ────────────────────────────────────────────────────────────────────────────────────
say "3/7 files"
install -d -m 0755 /opt/pim-cua-bridge /opt/pim-cua-bridge/caddy
install -m 0644 "$HERE/pim_cua_bridge.py" /opt/pim-cua-bridge/pim_cua_bridge.py
for fragment in pim-bridge-machine.caddy pim-bridge-media.caddy pim-bridge-strip.caddy; do
  install -m 0644 "$HERE/caddy/$fragment" "/opt/pim-cua-bridge/caddy/$fragment"
done
install -d -o root -g pim-bridge -m 0750 /etc/pim-cua-bridge
{
  echo "# Written by pim-cua-bridge's install.sh. Not a secret: the SHA-256 of Pim's credential."
  echo "PIM_BRIDGE_LISTEN=127.0.0.1:3290"
  echo "PIM_BRIDGE_TOKEN_SHA256=$digest"
} >/etc/pim-cua-bridge/bridge.env.new
chown root:pim-bridge /etc/pim-cua-bridge/bridge.env.new
chmod 0640 /etc/pim-cua-bridge/bridge.env.new
mv /etc/pim-cua-bridge/bridge.env.new /etc/pim-cua-bridge/bridge.env
for unit in "${UNITS[@]}"; do
  install -m 0644 "$HERE/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload

# The platform, tried for real, before anything serves differently: a transient unit as pim-agent
# under every confining setting of the reviewed pim-agent-exec.service (vm_patch.py
# runner-properties reads them from it, so they can't drift) must write only its workspace and its
# private /tmp, run unprivileged (no capabilities, no_new_privs, no admin group, no sudo), reach no
# loopback, link-local or Azure host address that answers the installer, see neither the desktop's
# X socket and session bus nor other homes nor spacesd's token, and keep a detached process in its
# own cgroup. The installed unit's effective settings must be the reviewed ones, with no drop-ins.
# Anything unproven stops the install here, BLOCKED, before the switch. Nothing here has run on
# the real VM or under root and systemd in a rehearsal of this version.
blocked() { printf 'pim-cua-bridge install: BLOCKED: %s; nothing serves differently; rollback.sh removes what steps 2-3 added\n' "$*" >&2; exit 1; }
say "    trying the runner's sandbox for real"
[ -z "$(systemctl show -p DropInPaths --value pim-agent-exec.service)" ] || blocked "pim-agent-exec.service has drop-ins"
effective="$(systemctl show -p User -p NoNewPrivileges -p ProtectSystem -p ProtectHome -p PrivateTmp -p IPAddressDeny -p CapabilityBoundingSet --value pim-agent-exec.service | tr '\n' ' ')"
for want in "pim-agent " "yes " "strict " "tmpfs "; do
  [[ "$effective" == *"$want"* ]] || blocked "pim-agent-exec.service's effective settings aren't the reviewed ones ($effective)"
done
for target in 127.0.0.1/3211 127.0.0.1/443 169.254.169.254/80; do
  timeout 3 bash -c "exec 3<>/dev/tcp/$target" 2>/dev/null || blocked "$target doesn't answer the installer, so the sandbox's denial of it can't be shown"
done
mapfile -t properties < <(python3 -I "$HERE/vm_patch.py" runner-properties "$HERE/pim-agent-exec.service")
[ "${#properties[@]}" -gt 10 ] || blocked "couldn't read the runner's settings"
cua_uid="$(id -u cua 2>/dev/null || echo none)"
marker="pim-probe-$$"
probe="$(systemd-run --quiet --wait --pipe --collect "${properties[@]/#/-p}" \
  /bin/bash -c '
    no() { ! timeout 3 bash -c "$1" >/dev/null 2>&1; }
    [ "$(id -u)" != 0 ] && [ "$(id -un)" = pim-agent ] && echo ok-unprivileged
    case " $(id -nG) " in *" sudo "*|*" admin "*|*" wheel "*|*" root "*) ;; *) echo ok-groups ;; esac
    grep -qx "CapEff:[[:space:]]*0000000000000000" /proc/self/status && grep -qx "NoNewPrivs:[[:space:]]*1" /proc/self/status && echo ok-caps
    no "sudo -n true" && echo ok-no-sudo
    touch /home/pim-agent/pim/.'"$marker"' && rm /home/pim-agent/pim/.'"$marker"' && touch /tmp/'"$marker"' && echo ok-writes
    no "touch /etc/'"$marker"'" && no "touch /opt/'"$marker"'" && no "touch /usr/local/'"$marker"'" && no "touch /var/lib/'"$marker"'" && echo ok-read-only
    no "exec 3<>/dev/tcp/127.0.0.1/3211" && no "exec 3<>/dev/tcp/127.0.0.1/443" && echo ok-no-loopback
    no "exec 3<>/dev/tcp/169.254.169.254/80" && no "exec 3<>/dev/tcp/168.63.129.16/80" && echo ok-no-metadata
    no "cat /etc/cua/spacesd.env" && echo ok-no-root-token
    [ "$(ls -A /home)" = pim-agent ] && echo ok-homes
    [ ! -e /tmp/.X11-unix ] && no "ls /run/user/'"$cua_uid"'/bus" && echo ok-no-desktop
    cg="$(sed -n "s/^0:://p" /proc/self/cgroup)"
    [ -n "$cg" ] && [ -r "/sys/fs/cgroup$cg/cgroup.procs" ] && echo ok-cgroup
    setsid sleep 20 </dev/null >/dev/null 2>&1 &
    detached=$!
    sleep 1
    grep -qx "$detached" "/sys/fs/cgroup$cg/cgroup.procs" && echo ok-detached
  ' 2>&1)" || true
for want in unprivileged groups caps no-sudo writes read-only no-loopback no-metadata no-root-token homes no-desktop cgroup detached; do
  grep -qx "ok-$want" <<<"$probe" || blocked "the runner's sandbox isn't shown to hold on this machine: $want"
done
[ ! -e "/tmp/$marker" ] || blocked "the runner's /tmp isn't private"
for path in /etc /opt /usr/local /var/lib; do [ ! -e "$path/$marker" ] || { rm -f "$path/$marker"; blocked "the runner could write $path"; }; done
say "    sandbox: shown to hold for every setting of the runner's unit"

# ── 4. The patched Caddyfile, validated ─────────────────────────────────────────────────────────
say "4/7 validating the patched Caddyfile"
install -d -m 0700 "$BACKUP"
python3 -I "$HERE/vm_patch.py" caddyfile "$CADDYFILE" "$BACKUP/Caddyfile.patched"
python3 -I "$HERE/vm_patch.py" deadline "$DEADLINE" "$BACKUP/deadline-check.sh.patched"
scratch="$(mktemp -d)"
if ! (
  IFS= read -r line </etc/cua-evaluation/credentials/viewer-basic
  export CUA_EVAL_BASIC_USER="${line%%:*}" CUA_EVAL_BASIC_HASH="${line#*:}"
  unset line
  export HOME="$scratch" XDG_DATA_HOME="$scratch" XDG_CONFIG_HOME="$scratch"
  exec /usr/local/bin/caddy validate --config "$BACKUP/Caddyfile.patched" --adapter caddyfile
) >"$BACKUP/caddy-validate.log" 2>&1; then
  rm -rf "$scratch"
  die "caddy validate refused the patched Caddyfile; its output is in $BACKUP/caddy-validate.log (root only). Nothing serves differently yet: rollback.sh removes what step 2-3 added"
fi
rm -rf "$scratch"

# ── 5. Backups ──────────────────────────────────────────────────────────────────────────────────
say "5/7 keeping the originals in $BACKUP"
cp -p "$CADDYFILE" "$BACKUP/Caddyfile.orig"
cp -p "$DEADLINE" "$BACKUP/deadline-check.sh.orig"
(cd "$BACKUP" && sha256sum Caddyfile.orig deadline-check.sh.orig >originals.sha256)

# ── 6. Switch over ──────────────────────────────────────────────────────────────────────────────
switched=0
on_failure() {
  if [ "$switched" = 1 ]; then
    echo "pim-cua-bridge install: FAILED while switching over; rolling back" >&2
    "$HERE/rollback.sh" || echo "pim-cua-bridge install: rollback failed too; see the runbook" >&2
  fi
}
trap on_failure ERR
replace() { # replace FILE NEW: NEW takes FILE's place with FILE's owner and mode, atomically.
  chown --reference="$1" "$2"
  chmod --reference="$1" "$2"
  cp -p "$2" "$1.pim-new"
  mv -f "$1.pim-new" "$1"
}
time_left
say "6/7 switching over: the viewer route stops, cua-spacesd restarts briefly"
switched=1
systemctl stop cua-viewer-proxy.service
replace "$DEADLINE" "$BACKUP/deadline-check.sh.patched"
replace "$CADDYFILE" "$BACKUP/Caddyfile.patched"
systemctl restart cua-spacesd.service
listening() { # listening URL: waits up to a minute for an HTTP answer of any kind
  for _ in $(seq 1 60); do
    [ "$(curl -s -o /dev/null --max-time 2 -w '%{http_code}' "$1")" != 000 ] && return
    sleep 1
  done
  echo "pim-cua-bridge install: nothing answers at $1" >&2
  false
}
listening http://127.0.0.1:3211/health
systemctl enable --now pim-agent-exec.socket
systemctl enable --now pim-cua-bridge.service
listening http://127.0.0.1:3290/
systemctl start cua-viewer-proxy.service

# ── 7. Checks, with no credential ───────────────────────────────────────────────────────────────
say "7/7 checking the route from the VM"
probe() { # probe METHOD PATH [HEADER]: the status, and the bridge's X-Pim-Bridge header if it answered ("-" before it knows the route)
  curl -sk -o /dev/null --max-time 10 --resolve "$SITE:443:127.0.0.1" -X "$1" ${3:+-H "$3"} \
    -w '%{http_code} %header{x-pim-bridge}' "https://$SITE$2" || true
}
for _ in $(seq 1 30); do
  [ "$(probe POST /pim-bridge/v1/status | cut -d' ' -f1)" = 401 ] && break
  sleep 1
done
expect() { # expect WHAT GOT WANT
  [ "$2" = "$3" ] || { echo "pim-cua-bridge install: check failed: $1: got '$2', want '$3'" >&2; false; }
  say "    ok: $1"
}
expect "a machine route without Pim's credential is refused by Caddy" "$(probe POST /pim-bridge/v1/status)" "401 "
expect "a machine route with a wrong credential reaches the bridge, which refuses it" \
  "$(probe POST /pim-bridge/v1/status "X-Pim-Bridge-Authorization: Bearer $(printf 'x%.0s' $(seq 1 43))")" "401 -"
expect "OpenMedia without the Basic login is refused" "$(probe POST /cua.env.v1.StreamService/OpenMedia)" "401 "
expect "a machine route with a query goes to the Basic login" "$(probe POST '/pim-bridge/v1/status?x=1')" "401 "
for unit in cua-spacesd.service cua-viewer-proxy.service pim-cua-bridge.service pim-agent-exec.socket; do
  systemctl is-active --quiet "$unit" || { echo "pim-cua-bridge install: $unit isn't running" >&2; false; }
done
trap - ERR
say "installed. The machine is the person's until they resume Pim's agents. Caddyfile $(sha "$CADDYFILE"), deadline-check.sh $(sha "$DEADLINE")"
