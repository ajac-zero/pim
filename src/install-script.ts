/**
 * `/install.sh`: what installs pim-host (../computer/pim-host.ts) on the
 * operator's computer host, or pim-computer (../computer/pim-computer.ts) on a
 * person's own machine, in one command, which Settings shows with its token:
 *
 *   curl -fsSL https://pim.example.com/install.sh | sh -s -- host pimh_…
 *   curl -fsSL https://pim.example.com/install.sh | sh -s -- computer pimc_…
 *
 * It gets Node.js where the machine has none new enough (Node's official
 * build, checked against the checksum here), downloads the program from this
 * Pim into its own folder, and runs the program's `install` command, which
 * does the rest: its checks, and a service that keeps it running. Anything
 * after the token goes to that command. The computers a Pim's host keeps
 * are set up with it too, with `PIM_URL` set to the address they reach the
 * Pim at.
 */

/** Node.js for the programs, where the machine has none new enough: its official build, as .tar.gz (which needs no xz), with each one's SHA-256. */
const NODE_VERSION = "22.23.4";
const NODE_BUILDS: Record<string, string> = {
	"Linux-x86_64": "linux-x64 b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
	"Linux-aarch64": "linux-arm64 f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9",
	"Darwin-x86_64": "darwin-x64 efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819",
	"Darwin-arm64": "darwin-arm64 c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428",
};

/** The script, for the Pim at `pimUrl`. It's POSIX sh, so it runs where bash isn't, as on Debian's `sh`. */
export function installScript(pimUrl: string): string {
	const builds = Object.entries(NODE_BUILDS)
		.map(([machine, build]) => `\t${machine}) build="${build}" ;;`)
		.join("\n");
	return `#!/bin/sh
# Installs pim-host or pim-computer from the Pim at ${pimUrl}:
#   curl -fsSL ${pimUrl}/install.sh | sh -s -- host pimh_…
#   curl -fsSL ${pimUrl}/install.sh | sh -s -- computer pimc_…
# Anything after the token goes to the program's install command.
set -eu
PIM_URL="\${PIM_URL:-${pimUrl}}"
case "\${1:-}" in
host) program=pim-host; variable=PIM_HOST_TOKEN ;;
computer) program=pim-computer; variable=PIM_COMPUTER_TOKEN ;;
*)
	echo "Usage: curl -fsSL $PIM_URL/install.sh | sh -s -- host|computer <token>" >&2
	exit 2
	;;
esac
shift
case "\${1:-}" in pim?_*) export "$variable=$1"; shift ;; esac
DIR="$HOME/.$program"
mkdir -p "$DIR"
chmod 700 "$DIR"

# Node.js 22.18 or later: the one on the PATH, the one this got before, or Node's official build, checked.
new_enough() {
	"$1" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a >= 24 || (a === 23 && b >= 6) || (a === 22 && b >= 18) ? 0 : 1)' 2>/dev/null
}
if command -v node >/dev/null 2>&1 && new_enough node; then
	NODE="$(command -v node)"
elif new_enough "$DIR/node/bin/node"; then
	NODE="$DIR/node/bin/node"
else
	case "$(uname -s)-$(uname -m)" in
${builds}
	*)
		echo "Install Node.js 22.18 or later, then run this again." >&2
		exit 1
		;;
	esac
	platform="\${build% *}"
	sum="\${build#* }"
	echo "Downloading Node.js ${NODE_VERSION} for $program…"
	archive="$DIR/node.tar.gz"
	curl -fsSL --retry 5 -o "$archive" "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-$platform.tar.gz"
	if command -v sha256sum >/dev/null 2>&1; then got="$(sha256sum "$archive")"; else got="$(shasum -a 256 "$archive")"; fi
	if [ "\${got%% *}" != "$sum" ]; then
		rm -f "$archive"
		echo "Node.js's download doesn't match its checksum, so it isn't used." >&2
		exit 1
	fi
	rm -rf "$DIR/node"
	mkdir -p "$DIR/node"
	tar -xzf "$archive" -C "$DIR/node" --strip-components=1
	rm -f "$archive"
	NODE="$DIR/node/bin/node"
fi

# pim-host uses pim-computer's code for its service, so it has both.
files="$program.ts"
if [ "$program" = pim-host ]; then files="$files pim-computer.ts"; fi
for file in $files; do
	curl -fsSL --retry 5 -o "$DIR/$file.download" "$PIM_URL/$file"
	mv "$DIR/$file.download" "$DIR/$file"
done
exec "$NODE" "$DIR/$program.ts" install --url "$PIM_URL" "$@" </dev/null
`;
}
