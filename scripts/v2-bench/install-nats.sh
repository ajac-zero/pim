#!/usr/bin/env bash
# Downloads the pinned NATS server into ~/.cache/pim-bench after checking its published SHA-256. The benchmark uses it for NATS Core fanout, as the Compose profile does.
set -euo pipefail
VERSION="${NATS_VERSION:-v2.10.22}"
DIR="${HOME}/.cache/pim-bench"
mkdir -p "$DIR"
cd "$DIR"
curl -fsSL -o nats.tgz "https://github.com/nats-io/nats-server/releases/download/${VERSION}/nats-server-${VERSION}-linux-amd64.tar.gz"
curl -fsSL -o SHA256SUMS "https://github.com/nats-io/nats-server/releases/download/${VERSION}/SHA256SUMS"
expected="$(grep "nats-server-${VERSION}-linux-amd64.tar.gz" SHA256SUMS | cut -d' ' -f1)"
actual="$(sha256sum nats.tgz | cut -d' ' -f1)"
[ "$expected" = "$actual" ] || { echo "checksum mismatch" >&2; exit 1; }
tar xzf nats.tgz
echo "installed $DIR/nats-server-${VERSION}-linux-amd64/nats-server"
