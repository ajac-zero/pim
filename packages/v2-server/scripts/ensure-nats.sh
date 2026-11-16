#!/usr/bin/env bash
# Installs the nats-server binary the Live and integration tests start their own private servers from, when none is on
# the PATH. The release is pinned and checked against its published SHA-256.
set -euo pipefail
if command -v nats-server >/dev/null 2>&1; then
	echo "nats-server already installed."
	exit 0
fi
VERSION=v2.10.22
SHA256=db0b3ccbe4cbdd3872ae7486ec4f6b0f85824632a0789f4da2e0a8518390483e
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/nats.tar.gz" "https://github.com/nats-io/nats-server/releases/download/${VERSION}/nats-server-${VERSION}-linux-amd64.tar.gz"
echo "${SHA256}  $TMP/nats.tar.gz" | sha256sum -c -
tar -xzf "$TMP/nats.tar.gz" -C "$TMP"
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"
$SUDO install -m 0755 "$TMP/nats-server-${VERSION}-linux-amd64/nats-server" /usr/local/bin/nats-server
echo "nats-server installed."
