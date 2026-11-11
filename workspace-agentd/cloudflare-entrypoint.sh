#!/bin/sh
set -eu
# Cloudflare mounts this CA at boot. Install it before dropping root, on every restore too.
cp /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers.crt
update-ca-certificates >/dev/null
# Start agentd and every command it spawns as the workspace user.
exec setpriv --reuid=10001 --regid=10001 --init-groups node /opt/agentd/server.mjs
