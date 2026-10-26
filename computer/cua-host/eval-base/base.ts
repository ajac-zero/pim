/**
 * Sets up a Cua evaluation VM's base (docs/cua-eval-base.md): on one new,
 * disposable Ubuntu 24.04 x86-64 VM, the pinned Node and Google Chrome
 * (./manifest.ts), the shared non-root `pim-desktop` account, and one
 * persistent X11 display and Xfce session for it, which is what the
 * installer (../eval-install/) requires before it runs. It makes no other
 * account, and nothing of the installer's or the bridge's: no workspace,
 * secret directory, token, certificate or service of theirs.
 *
 * The base is a fixed plan (`plan()`): checks that refuse before anything
 * changes, then steps in order, each one call with fixed words. `render`
 * turns it into three bash scripts for Azure Run Command (`setup`, `check`
 * and `review`) and a cloud-init user-data that only places them:
 *
 *   node base.ts render --out <new directory>
 *
 * The scripts hold no secret and make none, read os-release as data, never
 * source or evaluate anything they read, and call nothing from a request.
 * A failure prints a fixed reason and the step, and undoes nothing: the VM
 * is then discarded, never repaired in place.
 *
 * Importing it does nothing.
 */

import * as crypto from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ACCOUNTS, Refusal } from "../eval-install/config.ts";
import { writePrivate } from "../eval-install/operator.ts";
import { CHROME, IMAGE, NODE, STOCK_CHROME_PROFILE, UBUNTU_PACKAGES } from "./manifest.ts";

/** The desktop account: its own group and nothing else, a locked password, no subordinate IDs, and a home of its own. */
export const DESKTOP = {
	name: ACCOUNTS.desktop,
	uid: 2000,
	gid: 2000,
	comment: "Pim desktop",
	home: "/home/pim-desktop",
	shell: "/bin/bash",
	homeMode: 0o750,
	/** Made as the account, in its home: pim-computer's browser profile lives in the first, the account's own programs in the last. */
	dirs: [".pim-computer", ".local", ".local/bin"],
} as const;

/** The one display, its session's user unit, and the lingering that starts the account's user manager at boot. */
export const SESSION = {
	display: ":0",
	screen: "1280x800x24",
	unit: "pim-desktop-session.service",
	unitPath: "/etc/systemd/user/pim-desktop-session.service",
	wants: "/etc/systemd/user/default.target.wants/pim-desktop-session.service",
	linger: `/var/lib/systemd/linger/${DESKTOP.name}`,
	runtimeDir: `/run/user/${DESKTOP.uid}`,
	xSocketDir: "/tmp/.X11-unix",
	xSocket: "/tmp/.X11-unix/X0",
} as const;

/** What a process of the desktop account needs to reach the session: what the installer's configuration and unit must say. */
export const SESSION_ENVIRONMENT = {
	DISPLAY: SESSION.display,
	XDG_RUNTIME_DIR: SESSION.runtimeDir,
	DBUS_SESSION_BUS_ADDRESS: `unix:path=${SESSION.runtimeDir}/bus`,
} as const;

/** Where the base keeps what it downloaded and recorded, and where it installs Node. */
export const BASE_PATHS = {
	state: "/var/lib/pim-cua-base",
	nodeArchive: "/var/lib/pim-cua-base/node-v24.22.1-linux-x64.tar.xz",
	nodeExtract: "/var/lib/pim-cua-base/node",
	chromeDeb: "/var/lib/pim-cua-base/google-chrome-stable_156.0.8078.47-1_amd64.deb",
	log: "/var/lib/pim-cua-base/setup.log",
	packages: "/var/lib/pim-cua-base/packages.tsv",
	nodeDir: "/opt/pim-node",
	nodeBin: "/opt/pim-node/bin",
	node: "/opt/pim-node/bin/node",
	chromeDefaults: "/etc/default/google-chrome",
	osRelease: "/usr/lib/os-release",
} as const;

/** The programs the scripts call, by their canonical paths on Ubuntu 24.04; `setup` checks each is root's before anything changes. */
export const BASE_TOOLS = [
	"/usr/bin/apt-get",
	"/usr/bin/chmod",
	"/usr/bin/curl",
	"/usr/bin/cut",
	"/usr/bin/dirname",
	"/usr/bin/dpkg",
	"/usr/bin/dpkg-query",
	"/usr/bin/env",
	"/usr/bin/getent",
	"/usr/bin/grep",
	"/usr/bin/id",
	"/usr/bin/install",
	"/usr/bin/loginctl",
	"/usr/bin/mkdir",
	"/usr/bin/passwd",
	"/usr/bin/readlink",
	"/usr/bin/sha256sum",
	"/usr/bin/stat",
	"/usr/bin/systemctl",
	"/usr/bin/tar",
	"/usr/bin/uname",
	"/usr/bin/xz",
	"/usr/sbin/groupadd",
	"/usr/sbin/runuser",
	"/usr/sbin/useradd",
] as const;

/** The desktop session's user unit: one X server and one Xfce session, started by xinit, as the desktop account only. */
export function renderSessionUnit(): string {
	return [
		"# Pim Cua evaluation base (docs/cua-eval-base.md): the desktop account's one X11 display and Xfce session.",
		"# It runs in that account's own systemd user manager, which lingering starts at boot, and in no other account's.",
		"[Unit]",
		`Description=Pim Cua evaluation desktop session (Xvfb ${SESSION.display} and Xfce)`,
		`ConditionUser=${DESKTOP.name}`,
		"Requires=dbus.socket",
		"After=dbus.socket",
		"",
		"[Service]",
		"Type=simple",
		"Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=%t/bus",
		"Environment=XDG_SESSION_TYPE=x11",
		"Environment=XDG_CURRENT_DESKTOP=XFCE",
		`ExecStart=/usr/bin/xinit /usr/bin/xfce4-session -- /usr/bin/Xvfb ${SESSION.display} -screen 0 ${SESSION.screen} -nolisten tcp`,
		"Restart=no",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/** /etc/default/google-chrome, read by Chrome's package scripts: they then add no apt source of their own. */
export function renderChromeDefaults(): string {
	return [
		"# Pim Cua evaluation base (docs/cua-eval-base.md): Google Chrome's package adds no apt source of its own.",
		'repo_add_once="false"',
		'repo_reenable_on_distupgrade="false"',
		"",
	].join("\n");
}

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/** One call of a plan: a helper of `BASE_HELPERS_BASH` or a program by its path, with fixed words; `$NAME` words name a content variable. */
export type Call = readonly string[];
export type Step = { readonly step: string; readonly reason: string; readonly calls: readonly Call[]; readonly changes: boolean };

const mode = (value: number) => value.toString(8);
const desktopId = [String(DESKTOP.uid), String(DESKTOP.gid)] as const;
const pinned = [...UBUNTU_PACKAGES.map((p) => `${p.name}=${p.version}`)];
const homeDirs = DESKTOP.dirs.map((dir) => `${DESKTOP.home}/${dir}`);

/** Everything the base makes, or a stock file it relies on, that must not be there before it runs. */
export const ABSENT = [
	DESKTOP.home,
	`/var/mail/${DESKTOP.name}`,
	BASE_PATHS.state,
	BASE_PATHS.nodeDir,
	"/opt/google",
	BASE_PATHS.chromeDefaults,
	"/etc/apt/sources.list.d/google-chrome.sources",
	"/etc/apt/sources.list.d/google-chrome.list",
	"/etc/apparmor.d/google-chrome-stable",
	SESSION.unitPath,
	`${SESSION.unitPath}.d`,
	SESSION.wants,
	SESSION.linger,
	SESSION.runtimeDir,
	SESSION.xSocket,
	"/tmp/.X0-lock",
	"/etc/X0.hosts",
] as const;

/** The directories the base makes things in, each root's, not a link, and writable by no one else, from / down. */
export const TRUSTED_PARENTS = ["/home", "/opt", "/var/lib", "/etc/default", "/etc/apt/sources.list.d", "/etc/systemd/user", "/var/lib/systemd"] as const;

/** The checks `setup` makes before anything changes, in order, each refusing with its reason. */
export function preflight(): Step[] {
	const check = (step: string, reason: string, calls: Call[]): Step => ({ step, reason, calls, changes: false });
	return [
		check("root", "root-required", [["is_root"]]),
		check("os", "os", [
			["trusted_file", BASE_PATHS.osRelease],
			["os_release_is", BASE_PATHS.osRelease, "ID", IMAGE.id],
			["os_release_is", BASE_PATHS.osRelease, "VERSION_ID", IMAGE.versionId],
			["os_release_is", BASE_PATHS.osRelease, "VERSION_CODENAME", IMAGE.codename],
		]),
		check("arch", "arch", [["arch_is", IMAGE.machine, IMAGE.dpkgArch]]),
		check("systemd", "systemd", [["systemd_booted"]]),
		check("tools", "tools", BASE_TOOLS.map((tool) => ["trusted_file", tool])),
		check("accounts", "preexisting-account", [
			...[DESKTOP.name, String(DESKTOP.uid), ACCOUNTS.bridge, ACCOUNTS.session].map((name) => ["unknown_to", "passwd", name]),
			...[DESKTOP.name, String(DESKTOP.gid), ACCOUNTS.bridge, ACCOUNTS.session].map((name) => ["unknown_to", "group", name]),
		]),
		check("paths", "preexisting-path", ABSENT.map((p) => ["absent", p])),
		check("parents", "unsafe-parent", TRUSTED_PARENTS.map((dir) => ["trusted_dirs", dir])),
		// Ubuntu's own profile is what lets Chrome's sandbox make user namespaces; without it there is no stock way, and the base stops.
		check("browser-sandbox", "browser-sandbox", [
			["trusted_file", STOCK_CHROME_PROFILE.path],
			["lines_in", STOCK_CHROME_PROFILE.path, ...STOCK_CHROME_PROFILE.lines],
		]),
	];
}

/** What `setup` does once every check passed, in order. Downloads are checked against their pins before anything is installed from them. */
export function actions(): Step[] {
	const act = (step: string, calls: Call[]): Step => ({ step, reason: step, calls, changes: true });
	const apt = ["/usr/bin/env", "DEBIAN_FRONTEND=noninteractive", "/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=600"];
	return [
		act("staging", [["/usr/bin/mkdir", "-m", "0700", "--", BASE_PATHS.state]]),
		act("node-archive", [["fetch", NODE.url, BASE_PATHS.nodeArchive, String(NODE.archiveSize), NODE.archiveSha256]]),
		act("chrome-deb", [["fetch", CHROME.url, BASE_PATHS.chromeDeb, String(CHROME.debSize), CHROME.debSha256]]),
		act("node-extract", [["extract_member", BASE_PATHS.nodeArchive, BASE_PATHS.nodeExtract, NODE.member, String(NODE.binarySize), NODE.binarySha256]]),
		act("node", [
			["/usr/bin/mkdir", "-m", "0755", "--", BASE_PATHS.nodeDir],
			["/usr/bin/mkdir", "-m", "0755", "--", BASE_PATHS.nodeBin],
			["install_new", `${BASE_PATHS.nodeExtract}/${NODE.member}`, BASE_PATHS.node, "0755", String(NODE.binarySize), NODE.binarySha256],
			["file_is", BASE_PATHS.node, "file", "0", "0", "755"],
		]),
		act("chrome-defaults", [["write_new", BASE_PATHS.chromeDefaults, "0644", "$CHROME_DEFAULTS"]]),
		act("apt-update", [["run_logged", BASE_PATHS.log, ...apt, "-o", "APT::Update::Error-Mode=any", "update"]]),
		act("packages", [
			["run_logged", BASE_PATHS.log, ...apt, "-o", "Dpkg::Options::=--force-confold", "--yes", "--no-install-recommends", "install", ...pinned, BASE_PATHS.chromeDeb],
			["packages_are", ...pinned, `${CHROME.package}=${CHROME.version}`],
		]),
		act("chrome", [
			["trusted_file", CHROME.binary],
			["file_is", CHROME.binary, "file", "0", "0", "755"],
			["file_digest_is", CHROME.binary, String(CHROME.binarySize), CHROME.binarySha256],
			["file_is", CHROME.sandbox, "file", "0", "0", "4755"],
			["file_digest_is", CHROME.sandbox, String(CHROME.sandboxSize), CHROME.sandboxSha256],
			// Chrome's package used Ubuntu's profile and added no apt source or profile of its own.
			["absent", "/etc/apt/sources.list.d/google-chrome.sources"],
			["absent", "/etc/apt/sources.list.d/google-chrome.list"],
			["absent", "/etc/apparmor.d/google-chrome-stable"],
		]),
		act("record-packages", [["record_packages", BASE_PATHS.packages]]),
		act("desktop-group", [["/usr/sbin/groupadd", "--gid", String(DESKTOP.gid), DESKTOP.name]]),
		act("desktop-account", [
			[
				"/usr/sbin/useradd",
				"--uid",
				String(DESKTOP.uid),
				"--gid",
				String(DESKTOP.gid),
				"--comment",
				DESKTOP.comment,
				"--home-dir",
				DESKTOP.home,
				"--create-home",
				"--shell",
				DESKTOP.shell,
				"--key",
				`HOME_MODE=0${mode(DESKTOP.homeMode)}`,
				"--key",
				"SUB_UID_COUNT=0",
				"--key",
				"SUB_GID_COUNT=0",
				DESKTOP.name,
			],
		]),
		act("desktop-check", [
			["account_is", DESKTOP.name, ...desktopId, DESKTOP.home, DESKTOP.shell, DESKTOP.comment],
			["file_is", DESKTOP.home, "dir", ...desktopId, mode(DESKTOP.homeMode)],
		]),
		act("desktop-dirs", [
			...homeDirs.map((dir) => ["/usr/sbin/runuser", "-u", DESKTOP.name, "--", "/usr/bin/mkdir", "-m", "0700", "--", dir]),
			...homeDirs.map((dir) => ["file_is", dir, "dir", ...desktopId, "700"]),
		]),
		act("session-unit", [["write_new", SESSION.unitPath, "0644", "$SESSION_UNIT"]]),
		act("session-enable", [
			["run_logged", BASE_PATHS.log, "/usr/bin/systemctl", "--global", "enable", SESSION.unit],
			["link_is", SESSION.wants, SESSION.unitPath],
		]),
		// Starts the account's user manager now and at every boot, and with it the session; nothing else starts it.
		act("linger", [
			["/usr/bin/loginctl", "enable-linger", DESKTOP.name],
			["present_file", SESSION.linger],
		]),
	];
}

/** What `check` verifies, read-only, once the setup ran and the session had time to start. */
export function checks(): Step[] {
	const check = (step: string, calls: Call[]): Step => ({ step, reason: step, calls, changes: false });
	return [
		check("account", [["account_is", DESKTOP.name, ...desktopId, DESKTOP.home, DESKTOP.shell, DESKTOP.comment]]),
		check("home", [["file_is", DESKTOP.home, "dir", ...desktopId, mode(DESKTOP.homeMode)], ...homeDirs.map((dir) => ["file_is", dir, "dir", ...desktopId, "700"])]),
		check("node", [
			["trusted_file", BASE_PATHS.node],
			["file_is", BASE_PATHS.node, "file", "0", "0", "755"],
			["file_digest_is", BASE_PATHS.node, String(NODE.binarySize), NODE.binarySha256],
		]),
		check("chrome", [
			["trusted_file", CHROME.binary],
			["file_is", CHROME.binary, "file", "0", "0", "755"],
			["file_digest_is", CHROME.binary, String(CHROME.binarySize), CHROME.binarySha256],
			["file_is", CHROME.sandbox, "file", "0", "0", "4755"],
		]),
		check("browser-sandbox", [["lines_in", STOCK_CHROME_PROFILE.path, ...STOCK_CHROME_PROFILE.lines]]),
		check("apt-sources", [
			["absent", "/etc/apt/sources.list.d/google-chrome.sources"],
			["absent", "/etc/apt/sources.list.d/google-chrome.list"],
		]),
		check("packages", [["packages_are", ...pinned, `${CHROME.package}=${CHROME.version}`]]),
		check("session-unit", [
			["file_is", SESSION.unitPath, "file", "0", "0", "644"],
			["text_digest_is", SESSION.unitPath, sha256(renderSessionUnit())],
			["link_is", SESSION.wants, SESSION.unitPath],
			["present_file", SESSION.linger],
		]),
		check("user-manager", [["unit_running", "system", `user@${DESKTOP.uid}.service`]]),
		check("session", [["unit_running", `${DESKTOP.name}@.host`, SESSION.unit]]),
		check("runtime-dir", [
			["file_is", SESSION.runtimeDir, "dir", ...desktopId, "700"],
			["socket_of", `${SESSION.runtimeDir}/bus`, String(DESKTOP.uid)],
		]),
		check("display", [
			["file_is", SESSION.xSocketDir, "dir", "0", "0", "1777"],
			["socket_of", SESSION.xSocket, String(DESKTOP.uid)],
		]),
	];
}

/**
 * The scripts' helpers, the same in each. They use the programs by name, so
 * the scripts' fixed `PATH` (/usr/sbin:/usr/bin) picks Ubuntu's own, which
 * `setup` checks are root's first; tests define stand-ins of the same names.
 * Each returns non-zero rather than exit, and reads what it reads as data.
 */
export const BASE_HELPERS_BASH = `is_root() {
	[[ "$(id -u)" == 0 ]]
}

# Nothing at $1, not even a dangling link.
absent() {
	[[ ! -e "$1" && ! -L "$1" ]]
}

present_file() {
	[[ -f "$1" && ! -L "$1" ]]
}

# A directory of root's, not a link, that no one else can write.
root_dir() {
	local owner mode
	[[ -d "$1" && ! -L "$1" ]] || return 1
	read -r owner mode < <(stat -c '%u %a' -- "$1") || return 1
	[[ "$owner" == 0 ]] && (( (8#$mode & 8#022) == 0 ))
}

# Every directory from / down to $1 is root_dir.
trusted_dirs() {
	local current="" part
	local -a parts
	root_dir / || return 1
	IFS=/ read -r -a parts <<<"\${1#/}"
	for part in "\${parts[@]}"; do
		[[ -n "$part" && "$part" != . && "$part" != .. ]] || return 1
		current="$current/$part"
		root_dir "$current" || return 1
	done
}

# A regular file of root's, not a link, that no one else can write, in trusted directories.
trusted_file() {
	local owner mode
	trusted_dirs "$(dirname -- "$1")" || return 1
	[[ -f "$1" && ! -L "$1" ]] || return 1
	read -r owner mode < <(stat -c '%u %a' -- "$1") || return 1
	[[ "$owner" == 0 ]] && (( (8#$mode & 8#022) == 0 ))
}

# $1 is of kind $2 (file, dir), not a link, with owner $3, group $4 and mode $5 as stat's %a says it.
file_is() {
	local found
	case "$2" in
		file) [[ -f "$1" && ! -L "$1" ]] || return 1 ;;
		dir) [[ -d "$1" && ! -L "$1" ]] || return 1 ;;
		*) return 1 ;;
	esac
	found="$(stat -c '%u %g %a' -- "$1")" || return 1
	[[ "$found" == "$3 $4 $5" ]]
}

# $1 is a socket, not a link, of the user with ID $2.
socket_of() {
	local owner
	[[ -S "$1" && ! -L "$1" ]] || return 1
	owner="$(stat -c '%u' -- "$1")" || return 1
	[[ "$owner" == "$2" ]]
}

link_is() {
	local target
	[[ -L "$1" ]] || return 1
	target="$(readlink -- "$1")" || return 1
	[[ "$target" == "$2" ]]
}

# A regular file, not a link, of exactly $2 bytes with SHA-256 $3.
file_digest_is() {
	local size digest
	[[ -f "$1" && ! -L "$1" ]] || return 1
	size="$(stat -c %s -- "$1")" || return 1
	[[ "$size" == "$2" ]] || return 1
	digest="$(sha256sum <"$1" | cut -d' ' -f1)" || return 1
	[[ "$digest" == "$3" ]]
}

text_digest_is() {
	local digest
	[[ -f "$1" && ! -L "$1" ]] || return 1
	digest="$(sha256sum <"$1" | cut -d' ' -f1)" || return 1
	[[ "$digest" == "$2" ]]
}

# Whether getent knows nothing of $2 in database $1: "not found" (2) passes; found, or any other answer, refuses.
unknown_to() {
	local status=0
	getent "$1" "$2" >/dev/null 2>&1 || status=$?
	[[ "$status" == 2 ]]
}

# Whether os-release file $1 says exactly $3 for $2, once. Its lines are read as data: never sourced or evaluated.
os_release_is() {
	local line value found=0
	[[ -f "$1" && ! -L "$1" ]] || return 1
	while IFS= read -r line || [[ -n "$line" ]]; do
		[[ "$line" == "$2="* ]] || continue
		(( found == 0 )) || return 1
		found=1
		value="\${line#"$2="}"
		if (( \${#value} >= 2 )) && [[ "\${value:0:1}" == '"' && "\${value: -1}" == '"' ]]; then
			value="\${value:1:\${#value}-2}"
		fi
	done <"$1"
	(( found == 1 )) && [[ "$value" == "$3" ]]
}

arch_is() {
	[[ "$(uname -m)" == "$1" && "$(dpkg --print-architecture)" == "$2" ]]
}

systemd_booted() {
	[[ -d /run/systemd/system && ! -L /run/systemd/system ]]
}

# Every line after $1 is a whole line of file $1.
lines_in() {
	local file="$1" line
	shift
	for line in "$@"; do
		grep -Fxq -- "$line" "$file" || return 1
	done
}

# Downloads $1, over HTTPS only, to $2, a path where nothing is, then checks it is $3 bytes with SHA-256 $4.
fetch() {
	absent "$2" || return 1
	curl --proto =https --proto-redir =https --tlsv1.2 --fail --silent --show-error --location --max-redirs 3 --retry 3 \\
		--max-filesize "$3" --output "$2" -- "$1" || return 1
	file_digest_is "$2" "$3" "$4"
}

# Takes the one member $3 out of xz archive $1 into $2, a new directory, as a regular file of $4 bytes with SHA-256 $5. Nothing else is extracted.
extract_member() {
	absent "$2" || return 1
	mkdir -m 0700 -- "$2" || return 1
	tar --extract --xz --file="$1" --directory="$2" --no-same-owner --no-same-permissions --keep-old-files -- "$3" || return 1
	file_digest_is "$2/$3" "$4" "$5"
}

# Copies $1 to $2, where nothing is, with mode $3, and checks the copy is $4 bytes with SHA-256 $5.
install_new() {
	absent "$2" || return 1
	install -m "$3" -T -- "$1" "$2" || return 1
	file_digest_is "$2" "$4" "$5"
}

# Creates $1, where nothing is, never through a link, holding exactly $3, then gives it mode $2.
write_new() {
	absent "$1" || return 1
	( set -o noclobber; umask 077; printf '%s' "$3" >"$1" ) || return 1
	chmod -- "$2" "$1"
}

# Runs the rest, appending everything it prints to log $1.
run_logged() {
	local log="$1"
	shift
	"$@" >>"$log" 2>&1
}

# Each NAME=VERSION is installed at exactly that version.
packages_are() {
	local pair version
	for pair in "$@"; do
		version="$(dpkg-query --show --showformat='\${Version}' -- "\${pair%%=*}")" || return 1
		[[ "$version" == "\${pair#*=}" ]] || return 1
	done
}

# Records every package dpkg knows, its version, architecture and state, in $1, a new file.
record_packages() {
	absent "$1" || return 1
	( set -o noclobber; umask 077; dpkg-query --show --showformat='\${Package}\\t\${Version}\\t\${Architecture}\\t\${db:Status-Abbrev}\\n' >"$1" )
}

# Account $1 is exactly: UID $2, its own group $3 holding no one, home $4, shell $5, comment $6, in no other group, password locked, no subordinate IDs.
account_is() {
	local name status rest
	[[ "$(getent passwd "$1")" == "$1:x:$2:$3:$6:$4:$5" ]] || return 1
	[[ "$(getent passwd "$2")" == "$1:x:$2:$3:$6:$4:$5" ]] || return 1
	[[ "$(getent group "$1")" == "$1:x:$3:" ]] || return 1
	[[ "$(getent group "$3")" == "$1:x:$3:" ]] || return 1
	[[ "$(id -G "$1")" == "$3" ]] || return 1
	read -r name status rest < <(passwd --status "$1") || return 1
	[[ "$name" == "$1" && "$status" == L ]] || return 1
	no_subids "$1" "$2" /etc/subuid /etc/subgid
}

# No line of the subordinate ID files after $2 is for account $1 (by name or UID $2); a file that is there must be a regular one.
no_subids() {
	local name="$1" uid="$2" file owner rest
	shift 2
	for file in "$@"; do
		[[ -e "$file" || -L "$file" ]] || continue
		[[ -f "$file" && ! -L "$file" ]] || return 1
		while IFS=: read -r owner rest || [[ -n "$owner" ]]; do
			[[ "$owner" != "$name" && "$owner" != "$uid" ]] || return 1
		done <"$file"
	done
}

# systemd says unit $2 is active and running, in the system manager ($1 "system") or a user's (\`user@.host\`).
unit_running() {
	local answer
	if [[ "$1" == system ]]; then
		answer="$(systemctl show --property=ActiveState,SubState -- "$2")" || return 1
	else
		answer="$(systemctl --user --machine="$1" show --property=ActiveState,SubState -- "$2")" || return 1
	fi
	[[ "$answer" == $'ActiveState=active\\nSubState=running' ]]
}`;

/** A word of a script, single-quoted; every word here is checked to need nothing more. */
export function word(value: string): string {
	if (value.startsWith("$")) {
		if (!/^\$[A-Z_]+$/.test(value)) throw new Refusal("render-value");
		return `"${value}"`;
	}
	if (!/^[A-Za-z0-9._:/@=+,%~(){} -]*$/.test(value)) throw new Refusal("render-value");
	return `'${value}'`;
}

const HELPER_NAMES = new Set([...BASE_HELPERS_BASH.matchAll(/^([a-z_]+)\(\) \{$/gm)].map((match) => match[1]!));

function renderCall(call: Call): string {
	const [command, ...args] = call;
	if (!command || (!HELPER_NAMES.has(command) && !BASE_TOOLS.includes(command as (typeof BASE_TOOLS)[number]))) throw new Refusal("render-call");
	return [command, ...args.map(word)].join(" ");
}

function prologue(command: string, purpose: string): string {
	return `#!/bin/bash
# Pim Cua evaluation base: ${command} (docs/cua-eval-base.md). ${purpose}
# Rendered by computer/cua-host/eval-base/base.ts from its pinned manifest. It holds no secret, makes none, and prints none.
if [ -z "\${BASH_VERSION:-}" ]; then exec /bin/bash "$0" "$@"; fi
set -euo pipefail
umask 022
export LC_ALL=C PATH=/usr/sbin:/usr/bin
cd /

readonly COMMAND=${word(command)}
STEP=start
CHANGED=false

fail() {
	printf '{"event":"pim-cua-base.failed","command":"%s","step":"%s","reason":"%s","changed":%s}\\n' "$COMMAND" "$STEP" "$1" "$CHANGED" >&2
	exit 1
}

${BASE_HELPERS_BASH}
`;
}

/** A quoted here-document read whole into a variable: nothing in it is expanded. */
function content(name: string, text: string): string {
	const delimiter = `PIM_CUA_BASE_${name}`;
	if (text.split("\n").includes(delimiter)) throw new Refusal("render-value");
	return `IFS= read -r -d '' ${name} <<'${delimiter}' || true\n${text}${delimiter}\n`;
}

/** The setup script: every check, then every step, each stopping at its first failure with a fixed reason. */
export function renderSetup(): string {
	const lines = [
		prologue("setup", "Run once, as root, on a new VM; any failure means a new VM."),
		content("SESSION_UNIT", renderSessionUnit()),
		content("CHROME_DEFAULTS", renderChromeDefaults()),
		"# Checks: nothing changes until every one passes.",
	];
	for (const step of preflight()) {
		lines.push(`STEP=${step.step}`);
		for (const call of step.calls) lines.push(`${renderCall(call)} || fail ${step.reason}`);
	}
	lines.push("", "# Steps, in order; none is undone when a later one fails.", "CHANGED=true");
	for (const step of actions()) {
		lines.push(`STEP=${step.step}`);
		for (const call of step.calls) lines.push(`${renderCall(call)} || fail ${step.reason}`);
	}
	lines.push(`printf '{"event":"pim-cua-base.set-up","account":"%s","display":"%s"}\\n' ${word(DESKTOP.name)} ${word(SESSION.display)}`, "");
	return lines.join("\n");
}

/** The check script: read-only; one line per check, then whether all passed. */
export function renderCheck(): string {
	const lines = [prologue("check", "Read-only; run after setup, once the session has had time to start."), "OK=true", "result() {", '\tprintf \'{"event":"pim-cua-base.check","check":"%s","ok":%s}\\n\' "$1" "$2"', "}"];
	for (const step of checks()) {
		const all = step.calls.map(renderCall).join(" && ");
		lines.push(`if ${all}; then result ${step.step} true; else result ${step.step} false; OK=false; fi`);
	}
	lines.push(`printf '{"event":"pim-cua-base.checked","ok":%s}\\n' "$OK"`, '[[ "$OK" == true ]]', "");
	return lines.join("\n");
}

/**
 * The review script: read-only metadata for a person to review the image's
 * administrative authority (docs/cua-eval-base.md): each sudoers and polkit
 * rules file by SHA-256 and owning package, dpkg's own check of the
 * packages that ship them, the name service's lines for accounts, groups
 * and sudoers, the admin groups' members, and the desktop account's groups.
 * It prints no other file's contents, and decides nothing: a name missing
 * from sudoers doesn't show the account has no authority.
 */
export function renderReview(): string {
	return `${prologue("review", "Read-only metadata for reviewing the image's administrative authority; it decides nothing.")}
describe() {
	local digest owner
	digest="$(sha256sum <"$1" | cut -d' ' -f1)" || digest=unreadable
	owner="$(dpkg-query --search -- "$1" 2>/dev/null | cut -d: -f1)" || owner=none
	printf 'file %s %q %q\\n' "$digest" "\${owner:-none}" "$1"
}
for file in /etc/sudoers /etc/sudoers.d/* /etc/polkit-1/rules.d/* /usr/share/polkit-1/rules.d/* /etc/nsswitch.conf; do
	if [[ -L "$file" ]]; then
		printf 'link %q\\n' "$file"
	elif [[ -f "$file" ]]; then
		describe "$file"
	elif [[ -e "$file" ]]; then
		printf 'other %q\\n' "$file"
	fi
done
if [[ -f /etc/nsswitch.conf && ! -L /etc/nsswitch.conf ]]; then
	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ "$line" =~ ^(passwd|group|shadow|gshadow|sudoers|netgroup): ]]; then printf 'nss %q\\n' "$line"; fi
	done </etc/nsswitch.conf
fi
for group in sudo admin wheel adm; do
	printf 'group %q\\n' "$(getent group "$group" || printf '%s absent' "$group")"
done
printf 'desktop-groups %q\\n' "$(id -Gn ${word(DESKTOP.name)} 2>/dev/null || printf 'absent')"
{ dpkg --verify sudo polkitd libc-bin 2>&1 || true; } | while IFS= read -r line; do printf 'verify %q\\n' "$line"; done
printf '{"event":"pim-cua-base.reviewed"}\\n'
`;
}

/**
 * A cloud-init user-data that only places the three scripts on the VM, as
 * `/usr/local/sbin/pim-cua-base-<name>` (root's, 0700), and runs none of
 * them. JSON is YAML, so it is written as JSON after the header.
 */
export function renderCloudConfig(scripts: Record<string, string>): string {
	const files = Object.entries(scripts).map(([name, text]) => ({ path: `/usr/local/sbin/pim-cua-base-${name.replace(/\.sh$/, "")}`, owner: "root:root", permissions: "0700", content: text }));
	return `#cloud-config\n${JSON.stringify({ write_files: files }, null, 2)}\n`;
}

/** The part of the installer's configuration (docs/cua-eval-install.md) this base decides: the pinned Node and browser, and the session's display. */
export function installerFragment() {
	return {
		node: { path: BASE_PATHS.node, sha256: NODE.binarySha256, version: NODE.version },
		browser: { path: CHROME.binary, sha256: CHROME.binarySha256 },
		desktop: { headful: true, display: SESSION.display, xauthority: null },
	};
}

/** Every file `render` writes, by name. */
export function renderAll(): Record<string, string> {
	const scripts = { "setup.sh": renderSetup(), "check.sh": renderCheck(), "review.sh": renderReview() };
	return { ...scripts, "cloud-config.yaml": renderCloudConfig(scripts), "installer-fragment.json": `${JSON.stringify(installerFragment(), null, 2)}\n` };
}

const USAGE = `Renders a Cua evaluation VM's base setup scripts into a new private directory. See docs/cua-eval-base.md.

  node base.ts render --out <new directory>`;

function main(argv: string[]): void {
	let out: string | undefined;
	try {
		if (argv[0] !== "render") throw new Error();
		out = parseArgs({ args: argv.slice(1), options: { out: { type: "string" } }, strict: true, allowPositionals: false }).values.out;
		if (!out) throw new Error();
	} catch {
		process.stderr.write(`${USAGE}\n`);
		process.exit(2);
	}
	try {
		const files = renderAll();
		writePrivate(out, new Map(Object.entries(files).map(([name, text]) => [name, Buffer.from(text)])));
		process.stdout.write(`${JSON.stringify({ event: "pim-cua-base.rendered", files: Object.keys(files) })}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ event: "pim-cua-base.failed", command: "render", reason: error instanceof Refusal ? error.reason : "internal" })}\n`);
		process.exit(1);
	}
}

// Run as a program, never when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main(process.argv.slice(2));
