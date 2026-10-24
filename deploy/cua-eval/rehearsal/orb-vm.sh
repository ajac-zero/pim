#!/usr/bin/env bash
# A stand-in for the Cua evaluation VM on a disposable machine (an Amp orb), for rehearsing
# install.sh, the E2E smoke test (e2e.py) and rollback.sh before anyone runs them on the VM.
# Never run it on the VM, nor on a machine you keep: it adds users, units, a CA and a hosts entry.
#
#   PIM_REHEARSAL_DISPOSABLE=1 sudo -E rehearsal/orb-vm.sh up BOOTSTRAP   # BOOTSTRAP: Sandbox's cua-evaluation/ at 90ea971
#   PIM_REHEARSAL_DISPOSABLE=1 sudo -E rehearsal/orb-vm.sh down
#
# `up` lays out what the VM's bootstrap would, from that checkout's own files: its units
# (cua-desktop, cua-spacesd, cua-viewer-proxy, the deadline timer), scripts and Caddyfile under
# /opt/cua-evaluation/bootstrap, the pinned Caddy (2.11.7) and cua-spacesd (0.7.0) checked against
# the checkout's pins.env, the user cua without sudo, and synthetic secrets: a random spacesd root
# token and a random viewer password, which it writes, never prints, to a file of the invoking
# user's (~/.pim-rehearsal/viewer-basic, 0600) for e2e.py. What differs from the VM: no XFCE
# (`sleep infinity` as the session), no audio, no Chromium, `tls internal` instead of ACME (its
# root is added to this machine's trust store), Caddy listens on 8443 with 127.0.0.1:443 sent there
# (an orb has its own listener on 127.77.0.1:443), and cua-eval.ajac-zero.com is 127.0.0.1 here.
# The real VM's address is blackholed, so nothing here can reach it.
set -euo pipefail

VM_ADDRESS=168.61.38.107
SITE=cua-eval.ajac-zero.com
[ "${PIM_REHEARSAL_DISPOSABLE:-}" = 1 ] || { echo "only on a disposable machine: set PIM_REHEARSAL_DISPOSABLE=1" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 2; }
WHO="${SUDO_USER:-root}"
WHO_HOME="$(getent passwd "$WHO" | cut -d: -f6)"
UNITS=(cua-desktop.service cua-spacesd.service cua-viewer-proxy.service cua-eval-deadline.service cua-eval-deadline.timer)

pin() { sed -n "s/^$1=//p" "$BOOT/pins.env"; }
fetch() { # fetch URL SHA256 DEST
  [ -f "$3" ] && echo "$2  $3" | sha256sum --quiet -c - && return
  curl -fsSL -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum --quiet -c -
  mv "$3.part" "$3"
}

up() {
  BOOT="$(cd "$1" && pwd)"
  [ "$(sha256sum "$BOOT/bootstrap/proxy/Caddyfile" | cut -d' ' -f1)" = d529536ac736facba6ef2f41fb097b51427a97f49be9d4e261642702f2e8fdf5 ] ||
    { echo "$BOOT is not Sandbox's cua-evaluation/ at 90ea971" >&2; exit 2; }
  [ ! -e /opt/cua-evaluation ] || { echo "/opt/cua-evaluation exists: run down first" >&2; exit 2; }

  echo "never reaching the real VM: $SITE is 127.0.0.1 here, $VM_ADDRESS is blackholed"
  ip route replace blackhole "$VM_ADDRESS/32"
  grep -q "^127.0.0.1 $SITE\$" /etc/hosts || echo "127.0.0.1 $SITE" >>/etc/hosts

  echo "packages and pinned binaries"
  command -v Xvfb >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q xvfb >/dev/null
  cache=/var/cache/pim-rehearsal
  install -d -m 0755 "$cache"
  fetch "https://github.com/caddyserver/caddy/releases/download/v$(pin CADDY_VERSION)/$(pin CADDY_ASSET)" "$(pin CADDY_ASSET_SHA256)" "$cache/caddy.tgz"
  fetch "$(pin CUA_UPSTREAM_REPO)/releases/download/$(pin CUA_SPACESD_TAG)/$(pin CUA_SPACESD_ASSET)" "$(pin CUA_SPACESD_ASSET_SHA256)" "$cache/spacesd.tgz"
  tar -xzf "$cache/caddy.tgz" -C "$cache" caddy
  tar -xzf "$cache/spacesd.tgz" -C "$cache" cua-spacesd
  echo "$(pin CADDY_BIN_SHA256)  $cache/caddy" | sha256sum --quiet -c -
  echo "$(pin CUA_SPACESD_BIN_SHA256)  $cache/cua-spacesd" | sha256sum --quiet -c -
  install -m 0755 "$cache/caddy" /usr/local/bin/caddy
  install -m 0755 "$cache/cua-spacesd" /usr/local/bin/cua-spacesd

  echo "users cua (no sudo) and cua-caddy"
  id cua >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --groups audio,video cua
  passwd -l cua >/dev/null
  id cua-caddy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin cua-caddy

  echo "the bootstrap's files"
  install -d -m 0755 /opt/cua-evaluation
  cp -a "$BOOT/bootstrap" /opt/cua-evaluation/bootstrap
  chown -R root:root /opt/cua-evaluation
  printf 'd /run/cua-desktop 0700 cua cua -\n' >/usr/lib/tmpfiles.d/cua-desktop.conf
  systemd-tmpfiles --create /usr/lib/tmpfiles.d/cua-desktop.conf
  install -d -m 0755 /etc/cua-evaluation /etc/cua /var/lib/cua-evaluation /var/lib/cua-evaluation/viewer-root/viewer
  printf 'CUA_SESSION_CMD=sleep infinity\nCUA_EVAL_PULSE_WAIT_S=1\n' >/etc/cua-evaluation/config.env
  date +%s >/var/lib/cua-evaluation/bootstrap-epoch
  for name in index.html viewer.js index.css audioWorklet.js captureWorklet.js; do
    echo "rehearsal placeholder for the adapted viewer's $name" >"/var/lib/cua-evaluation/viewer-root/viewer/$name"
  done

  echo "synthetic secrets (never printed)"
  (umask 077 && printf 'CUA_ENV_TOKEN=%s\n' "$(openssl rand -hex 32)" >/etc/cua/spacesd.env)
  install -d -m 0700 /etc/cua-evaluation/credentials
  password="$(openssl rand -base64 24 | tr -d '/+=')"
  hash="$(printf '%s\n' "$password" | /usr/local/bin/caddy hash-password)"
  (umask 077 && printf 'rehearsal:%s\n' "$hash" >/etc/cua-evaluation/credentials/viewer-basic)
  install -d -o "$WHO" -m 0700 "$WHO_HOME/.pim-rehearsal"
  (umask 077 && printf 'rehearsal:%s\n' "$password" >"$WHO_HOME/.pim-rehearsal/viewer-basic")
  chown "$WHO" "$WHO_HOME/.pim-rehearsal/viewer-basic"
  unset password hash

  echo "the bootstrap's units, with tls internal for the proxy"
  for unit in "${UNITS[@]}"; do install -m 0644 "$BOOT/bootstrap/systemd/$unit" "/etc/systemd/system/$unit"; done
  install -d -m 0755 /etc/pim-rehearsal /etc/systemd/system/cua-viewer-proxy.service.d
  echo "tls internal" >/etc/pim-rehearsal/tls-internal.caddy
  printf '[Service]\nEnvironment=CUA_EVAL_TLS_SNIPPET=/etc/pim-rehearsal/tls-internal.caddy CUA_EVAL_HTTPS_PORT=8443\n' >/etc/systemd/system/cua-viewer-proxy.service.d/rehearsal.conf
  iptables -t nat -C OUTPUT -p tcp -d 127.0.0.1 --dport 443 -j REDIRECT --to-ports 8443 2>/dev/null ||
    iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 443 -j REDIRECT --to-ports 8443
  systemctl daemon-reload
  systemctl enable --now cua-desktop.service cua-spacesd.service cua-viewer-proxy.service cua-eval-deadline.timer

  echo "trusting the proxy's local CA on this machine"
  root=/var/lib/cua-caddy/caddy/pki/authorities/local/root.crt
  for _ in $(seq 1 30); do [ -f "$root" ] && break; sleep 1; done
  install -m 0644 "$root" /usr/local/share/ca-certificates/pim-rehearsal-caddy.crt
  update-ca-certificates >/dev/null
  for _ in $(seq 1 30); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "https://$SITE/viewer/")" = 401 ] && break
    sleep 1
  done
  for unit in cua-desktop.service cua-spacesd.service cua-viewer-proxy.service; do
    systemctl is-active --quiet "$unit" || { echo "$unit isn't running" >&2; exit 1; }
  done
  echo "up: https://$SITE (here) answers $(curl -s -o /dev/null -w '%{http_code}' "https://$SITE/viewer/") without the Basic login; the viewer password is in $WHO_HOME/.pim-rehearsal/viewer-basic"
}

down() {
  for unit in pim-cua-bridge.service pim-agent-exec.socket pim-agent-exec.service "${UNITS[@]}"; do
    systemctl disable --now "$unit" 2>/dev/null || true
  done
  rm -rf /etc/systemd/system/cua-viewer-proxy.service.d
  for unit in pim-cua-bridge.service pim-agent-exec.socket pim-agent-exec.service "${UNITS[@]}"; do rm -f "/etc/systemd/system/$unit"; done
  systemctl daemon-reload
  rm -rf /opt/cua-evaluation /opt/pim-cua-bridge /etc/pim-cua-bridge /etc/cua /etc/cua-evaluation /etc/pim-rehearsal \
    /var/lib/cua-evaluation /var/lib/cua /var/lib/cua-caddy /var/lib/pim-cua-bridge /var/backups/pim-cua-bridge \
    /usr/lib/tmpfiles.d/cua-desktop.conf /run/cua-desktop "$WHO_HOME/.pim-rehearsal"
  for user in pim-agent pim-bridge cua cua-caddy; do userdel -r "$user" 2>/dev/null || userdel "$user" 2>/dev/null || true; done
  rm -f /usr/local/share/ca-certificates/pim-rehearsal-caddy.crt /usr/local/bin/caddy /usr/local/bin/cua-spacesd
  update-ca-certificates --fresh >/dev/null
  sed -i "/^127.0.0.1 $SITE\$/d" /etc/hosts
  iptables -t nat -D OUTPUT -p tcp -d 127.0.0.1 --dport 443 -j REDIRECT --to-ports 8443 2>/dev/null || true
  echo "down; $VM_ADDRESS stays blackholed until the next reboot"
}

case "${1:-}" in
  up) up "${2:?give the cua-evaluation folder of a Sandbox checkout at 90ea971}" ;;
  down) down ;;
  *) echo "usage: $0 up BOOTSTRAP | down" >&2; exit 2 ;;
esac
