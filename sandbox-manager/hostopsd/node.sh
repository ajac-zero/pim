#!/usr/bin/env bash
# Finding, and when the host has none at all installing, the Node.js hostopsd runs. Both up.sh
# (as the invoking user, whose PATH holds nvm's node but sudo's PATH does not) and install.sh (as
# root, where there may be no node: the manager runs in Docker) source this file, and so do the
# tests in test/install.test.js. It only defines functions and variables; the caller's options
# apply. hostopsd needs Node.js 22 or later.

NODE_MIN_MAJOR=22

# node_major NODE_BIN prints a Node.js binary's major version, or nothing when it cannot run it.
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true; }

# node_is_new_enough NODE_BIN succeeds when the binary runs and is Node.js 22 or later.
node_is_new_enough() {
	local major
	major=$(node_major "$1")
	[ -n "$major" ] && [ "$major" -ge "$NODE_MIN_MAJOR" ]
}

# pick_node CANDIDATE... prints the first candidate that exists, runs and is new enough, or fails.
pick_node() {
	local c
	for c in "$@"; do
		[ -n "$c" ] || continue
		if [ -x "$c" ] && node_is_new_enough "$c"; then printf '%s\n' "$c"; return 0; fi
	done
	return 1
}

# nvm_node USER prints the newest Node.js under USER's nvm, or nothing. nvm keeps the invoking
# user's node under the home directory, which root's PATH does not see.
nvm_node() {
	local home
	home=$(getent passwd "$1" 2>/dev/null | cut -d: -f6 || true) || true
	[ -n "$home" ] || return 0
	ls -d "$home"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -n 1 || true
}

# fetch URL prints a downloaded file, retrying: the connection can be flaky on a host that is
# being set up. The tests point it at a fake mirror.
fetch() {
	local url=$1 i
	for i in 1 2 3; do
		curl -fsSL --retry 3 --connect-timeout 30 --max-time 600 "$url" && return 0
		sleep 1
	done
	return 1
}

# install_node_tarball DIST DIR installs the official Node.js 22 LTS linux build from DIST (a
# nodejs.org /dist directory; $HOSTOPSD_NODE_DIST points the tests at a local mirror) into DIR and
# prints the path of DIR/node, which the caller owns. The tarball's SHA256 must match
# SHASUMS256.txt from the same directory, so a corrupted or tampered download is never used;
# failing that fails the install. It skips the download when DIR/node is already new enough.
install_node_tarball() {
	local dist=$1 dir=$2 arch sums name want have version tmp
	case "$(uname -m)" in
	x86_64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	*) echo "cannot install Node.js automatically on $(uname -m); install Node.js 22 or later and pass --node" >&2; return 1 ;;
	esac
	if [ -x "$dir/node" ] && node_is_new_enough "$dir/node"; then printf '%s\n' "$dir/node"; return 0; fi
	sums=$(fetch "$dist/SHASUMS256.txt") || { echo "could not read $dist/SHASUMS256.txt" >&2; return 1; }
	name=$(grep -E "node-v22\.[0-9]+\.[0-9]+-linux-$arch\.tar\.gz$" <<<"$sums" | awk '{print $2}' | tail -n 1)
	[ -n "$name" ] || { echo "$dist has no Node.js 22 linux-$arch tarball in SHASUMS256.txt" >&2; return 1; }
	want=$(awk -v n="$name" '$2 == n {print $1}' <<<"$sums")
	tmp=$(mktemp -d) || return 1
	fetch "$dist/$name" >"$tmp/node.tar.gz" || { rm -rf "$tmp"; echo "could not download $dist/$name" >&2; return 1; }
	have=$(sha256sum "$tmp/node.tar.gz" | cut -d' ' -f1)
	if [ "$have" != "$want" ]; then
		rm -rf "$tmp"
		echo "$name does not match its SHA256 in $dist/SHASUMS256.txt" >&2
		return 1
	fi
	version=${name#node-v}; version=${version%%-*}
	tar -xzf "$tmp/node.tar.gz" -C "$tmp" || { rm -rf "$tmp"; return 1; }
	install -d -m 0755 "$dir"
	rm -rf "$dir/node-v$version"
	mv "$tmp/node-v$version-linux-$arch" "$dir/node-v$version"
	install -m 0755 "$dir/node-v$version/bin/node" "$dir/node"
	rm -rf "$tmp"
	printf '%s\n' "$dir/node"
}
