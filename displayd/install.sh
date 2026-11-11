#!/usr/bin/env bash
# Installs or updates displayd on the Pim host. Run it as root; running it again is safe and keeps
# the token it generated before.
#
#   sudo displayd/install.sh [--node /path/to/node] [--checkout PATH]
#
# It needs Xvnc (TigerVNC), openbox, dbus-daemon, at-spi-bus-launcher and xauth on the host:
#   apt-get install tigervnc-standalone-server openbox dbus at-spi2-core x11-xauth
# (plus xdotool and xclip for scripts/integration.sh). The token lands only in /etc/displayd/env,
# readable by the displayd group; give the same value to whatever calls the API.
set -euo pipefail
die() { echo "install.sh: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ETC=${DISPLAYD_ETC:-/etc/displayd}
UNIT_DIR=${DISPLAYD_UNIT_DIR:-/etc/systemd/system}
CHECKOUT=${PIM_CHECKOUT:-$(cd "$SCRIPT_DIR/.." && pwd)}
NODE_BIN=${NODE_BIN:-}
while [ $# -gt 0 ]; do
	case "$1" in
	--node) NODE_BIN=${2:?--node needs a value}; shift 2 ;;
	--checkout) CHECKOUT=${2:?--checkout needs a value}; shift 2 ;;
	*) die "unknown option $1" ;;
	esac
done
installed() { [ -f "$ETC/env" ] && sed -n "s/^$1=//p" "$ETC/env" | tail -n 1 || true; }

for cmd in Xvnc openbox dbus-daemon xauth systemctl; do command -v "$cmd" >/dev/null || die "$cmd is missing; see the header of this script"; done
[ -x /usr/libexec/at-spi-bus-launcher ] || command -v at-spi-bus-launcher >/dev/null || die "at-spi-bus-launcher is missing (at-spi2-core)"
NODE_BIN=${NODE_BIN:-$(installed NODE_BIN)}
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
[ -x "$NODE_BIN" ] || die "no node found; pass --node"
[ "$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "$NODE_BIN is older than Node.js 22"
[ -f "$CHECKOUT/displayd/src/main.js" ] || die "$CHECKOUT has no displayd"

id displayd >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/displayd --no-create-home --shell /usr/sbin/nologin displayd
# X wants its socket directory to exist, world-writable and sticky; Xvnc cannot make it as displayd.
install -d -m 1777 /tmp/.X11-unix
install -d -o root -g displayd -m 0750 "$ETC"
TOKEN=$(installed DISPLAYD_TOKEN)
TOKEN=${TOKEN:-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')}
umask 077
tmp=$(mktemp "$ETC/.env.XXXXXX")
{
	echo "# Written by displayd/install.sh; run it again to change these."
	echo "DISPLAYD_TOKEN=$TOKEN"
	echo "PIM_CHECKOUT=$CHECKOUT"
	echo "NODE_BIN=$NODE_BIN"
} >"$tmp"
chown root:displayd "$tmp"
chmod 0640 "$tmp"
mv -f "$tmp" "$ETC/env"
install -m 0644 "$SCRIPT_DIR/displayd.service" "$UNIT_DIR/displayd.service"
systemctl daemon-reload
systemctl enable --quiet displayd
systemctl restart displayd
for _ in 1 2 3 4 5 6 7 8 9 10; do
	curl -fsS -H "authorization: Bearer $TOKEN" http://127.0.0.1:9900/health >/dev/null 2>&1 && { echo "displayd is running on 127.0.0.1:9900"; exit 0; }
	sleep 1
done
die "displayd did not answer /health; see journalctl -u displayd"
