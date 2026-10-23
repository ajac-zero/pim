#!/usr/bin/env bash
# Installs the celld release pinned in versions.env, and nothing else: the download must match
# its pinned SHA-256, its build attestation is checked when `gh` is signed in, and the binary
# must report the pinned version. Rerunning it is harmless; an older release stays beside the
# new one, so going back is pointing the symlink at it again.
#
#   deploy/celld/install-celld.sh [DIR]    DIR defaults to /opt/celld
#
# It leaves DIR/releases/<version>/celld and DIR/bin/celld, a symlink to it.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$here/versions.env"
dir="${1:-/opt/celld}"

case "$(uname -s)-$(uname -m)" in
	Linux-x86_64 | Linux-amd64) target=x86_64-unknown-linux-gnu ;;
	Linux-aarch64 | Linux-arm64) target=aarch64-unknown-linux-gnu ;;
	Darwin-arm64) target=aarch64-apple-darwin ;;
	*)
		echo "celld has no release for $(uname -s) $(uname -m)." >&2
		exit 1
		;;
esac
pin_var="CELLD_SHA256_${target//-/_}"
expected="${!pin_var}"

release="$dir/releases/$CELLD_VERSION"
if [[ -x "$release/celld" ]] && [[ "$("$release/celld" --version)" == "celld ${CELLD_VERSION#v}" ]]; then
	echo "celld $CELLD_VERSION is already at $release/celld."
else
	staging="$(mktemp -d)"
	trap 'rm -rf "$staging"' EXIT
	asset="celld-$target.gz"
	curl --proto '=https' --tlsv1.2 -fsSL -o "$staging/$asset" "https://github.com/denoland/celld/releases/download/$CELLD_VERSION/$asset"
	actual="$(sha256sum "$staging/$asset" | cut -d' ' -f1)"
	if [[ "$actual" != "$expected" ]]; then
		echo "$asset has SHA-256 $actual, not the pinned $expected. Not installing it." >&2
		exit 1
	fi
	echo "$asset matches its pinned SHA-256."
	if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
		# The attestation names the commit the release was built from; it must be the pinned tag's.
		built_from="$(gh attestation verify "$staging/$asset" --repo denoland/celld --format json --jq '.[0].verificationResult.signature.certificate.sourceRepositoryDigest')"
		if [[ "$built_from" != "$CELLD_COMMIT" ]]; then
			echo "$asset's attestation names commit $built_from, not $CELLD_COMMIT. Not installing it." >&2
			exit 1
		fi
		echo "$asset's build attestation checks out: built by denoland/celld from $CELLD_COMMIT."
	else
		echo "Skipped the build attestation: sign in with \`gh auth login\` to check it too." >&2
	fi
	gzip -dc "$staging/$asset" >"$staging/celld"
	chmod 755 "$staging/celld"
	reported="$("$staging/celld" --version)"
	if [[ "$reported" != "celld ${CELLD_VERSION#v}" ]]; then
		echo "The binary reports \"$reported\", not celld ${CELLD_VERSION#v}." >&2
		exit 1
	fi
	rm "$staging/$asset"
	chmod 755 "$staging"
	mkdir -p "$dir/releases"
	rm -rf "$release"
	mv "$staging" "$release"
	trap - EXIT
fi

mkdir -p "$dir/bin"
ln -sfn "../releases/$CELLD_VERSION/celld" "$dir/bin/celld"
echo "Installed: $dir/bin/celld -> $("$dir/bin/celld" --version)"
