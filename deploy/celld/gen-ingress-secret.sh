#!/usr/bin/env bash
# Makes PIM_INGRESS_SECRET, which the TLS proxy sends with every request and Pim's celld runtime
# requires, in a file of its own that only its owner can read: `PIM_INGRESS_SECRET=` and 64 hex
# characters. deploy.sh --ingress-secret gives it to Pim, and Caddy's systemd drop-in
# (caddy/pim-ingress.conf) reads the same file. It never replaces a file; to rotate, see
# docs/celld.md, "Trusted ingress".
#
#   deploy/celld/gen-ingress-secret.sh FILE     such as /etc/pim/ingress.env
set -euo pipefail

file="${1:?usage: gen-ingress-secret.sh FILE}"
if [[ -e "$file" ]]; then
	echo "$file exists. Not replacing it." >&2
	exit 1
fi
umask 077
mkdir -p "$(dirname "$file")"
(set -o noclobber && echo "PIM_INGRESS_SECRET=$(openssl rand -hex 32)" >"$file")
chmod 400 "$file"
echo "Wrote $file (mode 400)."
