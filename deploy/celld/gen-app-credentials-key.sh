#!/usr/bin/env bash
# Makes APP_CREDENTIALS_KEY, the key that encrypts people's sign-ins to apps Pim implements (Gmail,
# Google Drive, Spotify), in a file of its own that only its owner can read. Make it once per Pim
# and back it up apart from everything else (docs/celld.md, "APP_CREDENTIALS_KEY"): a Pim that
# loses it, or gets another, makes everyone connect those apps again. It never replaces a key.
#
#   deploy/celld/gen-app-credentials-key.sh FILE     such as /etc/pim/app-credentials-key
#
# It prints the key's fingerprint, never the key, so a backup can be checked against it.
set -euo pipefail

file="${1:?usage: gen-app-credentials-key.sh FILE}"
if [[ -e "$file" ]]; then
	echo "$file exists. It is this Pim's key: keep it, and back it up. Not replacing it." >&2
	exit 1
fi
umask 077
mkdir -p "$(dirname "$file")"
# noclobber: a file that appears in the meantime is never written over.
(set -o noclobber && openssl rand -base64 32 >"$file")
chmod 400 "$file"
echo "Wrote $file (mode 400)."
# The same command on a backup copy must print the same fingerprint.
echo "Fingerprint: $(tr -d '\n' <"$file" | sha256sum | cut -c1-16)"
