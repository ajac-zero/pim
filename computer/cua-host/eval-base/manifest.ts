/**
 * What a Cua evaluation VM's base is made of (docs/cua-eval-base.md): the
 * exact software, by version and digest, with where each pin came from. It
 * is data only, read by ./base.ts, which renders the scripts that set the
 * base up, and by its tests. Importing it does nothing.
 *
 * Every pin was taken on 2026-10-26 from the vendor's own signed metadata,
 * downloaded and checked read-only on the operator's machine; nothing was
 * installed or run there. A pin is replaced by editing this file in a
 * reviewed commit, never at setup time: the setup refuses anything that
 * doesn't match it.
 */

/** The one image the base sets up: a new Ubuntu 24.04 VM on x86-64. */
export const IMAGE = {
	/** As /usr/lib/os-release says it, read as data. */
	id: "ubuntu",
	versionId: "24.04",
	codename: "noble",
	/** `uname -m` and `dpkg --print-architecture`. */
	machine: "x86_64",
	dpkgArch: "amd64",
} as const;

/**
 * Node, the official build for Linux x64: one versioned archive from
 * nodejs.org, of which only `bin/node` is installed.
 *
 * Provenance: `SHASUMS256.txt` for the release, whose detached signature
 * (`SHASUMS256.txt.sig`) verified with `gpgv` against the Node release
 * team's active keys (nodejs/release-keys, `gpg-only-active-keys`) as made
 * by key 5BE8A3F6C8A5C01D106C0AD820B1A390B168D356 (Antoine du Hamel), lists
 * the archive with `archiveSha256`. The archive, downloaded and checked
 * against it, holds `member` as a regular file of `binarySize` bytes with
 * `binarySha256`, which is what the installer's configuration pins
 * (`node.sha256`). 24.22.1 is the latest release of the 24 LTS line, a
 * security release; the installer needs 22.18 or later.
 */
export const NODE = {
	version: "v24.22.1",
	url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz",
	archiveSize: 32_026_916,
	archiveSha256: "6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6",
	member: "node-v24.22.1-linux-x64/bin/node",
	binarySize: 126_879_696,
	binarySha256: "e32e2d16081cf644f88392934288086e7662529d0d43277c34f7aad2207cfafb",
	signingKey: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356",
} as const;

/**
 * Google Chrome, the vendor's own .deb, which installs the browser at
 * /opt/google/chrome/chrome, root's, where Ubuntu 24.04's stock AppArmor
 * profile `chrome` (/etc/apparmor.d/chrome, from Ubuntu's `apparmor`
 * package) lets it make the user namespaces its sandbox needs under the
 * image's unprivileged user namespace restriction. Nothing here changes
 * that policy or turns the sandbox off; the .deb also brings its setuid
 * `chrome-sandbox`, as it always does.
 *
 * Provenance: the stable repository's `InRelease` at dl.google.com, its
 * signature verified with `gpgv` against Google's Linux signing key
 * (EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796, signing subkey
 * 0E225917414670F4442C250DFD533C07C264648F), lists the amd64 `Packages`
 * index by SHA-256, which lists this version with `debSha256` and
 * `debSize`. The .deb, downloaded and checked against it, holds `binary`
 * (`binarySha256`, which the installer pins as `browser.sha256`), mode
 * 0755, and `chrome-sandbox` mode 4755, both root's.
 *
 * Google keeps only recent versions at their pool URLs. Once this one is
 * gone, the setup's download fails and refuses; the pin must then be
 * replaced, not worked around.
 */
export const CHROME = {
	package: "google-chrome-stable",
	version: "156.0.8078.47-1",
	url: "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_156.0.8078.47-1_amd64.deb",
	debSize: 144_849_192,
	debSha256: "6c92cd22e90c6e3e255d782991543fa2091db8614e8536a971a7433a5c4d7ac8",
	binary: "/opt/google/chrome/chrome",
	binarySize: 300_920_136,
	binarySha256: "95dc9473b4f904cb3ab0800fc7206081fcae12abc094a088bd741a13f1747b72",
	sandbox: "/opt/google/chrome/chrome-sandbox",
	sandboxSize: 15_216,
	sandboxSha256: "be9f5d4be90fa60b985ad3069812b144ba7331fed0c3f980c6d9399d37d60314",
	signingKey: "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796",
} as const;

/**
 * Ubuntu's stock AppArmor profile for Google Chrome's path, as both
 * `apparmor` 4.0.0-beta3-0ubuntu3 (noble) and
 * 4.0.1really4.0.1-0ubuntu0.24.04.9 (noble-updates) ship it. The setup
 * reads it as data and refuses unless these lines are there; it never
 * writes, loads or changes a profile. Chrome's own postinst installs a
 * profile of its own only when this file is missing, which the setup
 * refuses first.
 */
export const STOCK_CHROME_PROFILE = {
	path: "/etc/apparmor.d/chrome",
	lines: ["profile chrome /opt/google/chrome/chrome flags=(unconfined) {", "  userns,"],
} as const;

/**
 * The Ubuntu packages the base asks for, each at an exact version, from the
 * image's own apt sources (noble, noble-updates, noble-security, main and
 * universe), which apt authenticates with the image's Ubuntu archive key.
 *
 * Provenance: each version is the newest of the three suites' amd64
 * `Packages` indices as they were on 2026-10-26, each index matching the
 * SHA-256 its suite's `InRelease` lists, each `InRelease` verified with
 * `gpgv` against `ubuntu-archive-keyring.gpg` (Ubuntu Archive Automatic
 * Signing Key (2018), F6ECB3762474EDA9D21B7022871920D1991BC93C).
 *
 * The limit of this: only these top-level versions are pinned. Their
 * dependencies (and Chrome's) are whatever those suites hold on the day the
 * setup runs, and the updates and security pockets list only their newest
 * version, so a pin here stops resolving once it is superseded, and the
 * setup then refuses. The setup records every installed package and
 * version on the VM (`packages.tsv`); two VMs set up on different days may
 * differ below these pins, and that record is how to tell.
 */
export const UBUNTU_PACKAGES = [
	{ name: "xvfb", version: "2:21.1.12-1ubuntu1.9", suite: "noble-updates", component: "universe" },
	{ name: "xinit", version: "1.4.1-0ubuntu5", suite: "noble", component: "main" },
	{ name: "xfce4-session", version: "4.18.3-1build2", suite: "noble", component: "universe" },
	{ name: "xfwm4", version: "4.18.0-1build3", suite: "noble", component: "universe" },
	{ name: "xfce4-panel", version: "4.18.4-1ubuntu0.1", suite: "noble-updates", component: "universe" },
	{ name: "xfdesktop4", version: "4.18.1-1build3", suite: "noble", component: "universe" },
	{ name: "xfce4-settings", version: "4.18.4-0ubuntu3", suite: "noble", component: "universe" },
	{ name: "dbus-user-session", version: "1.14.10-4ubuntu4.1", suite: "noble-updates", component: "main" },
] as const;

/** The Ubuntu archive key apt checks the suites with, on the image. */
export const UBUNTU_ARCHIVE_KEY = "F6ECB3762474EDA9D21B7022871920D1991BC93C";

/**
 * Cua's own programs are not part of this base. The accepted data path
 * (docs/cua-bridge.md) is the bridge, a Unix socket, the desktop endpoint
 * and `pim-computer --stdio`, which drives Chrome over the DevTools
 * protocol and runs commands itself; none of it calls Cua's driver or its
 * `spacesd` daemon. So neither is pinned or installed here (an earlier,
 * standalone evaluation used spacesd 0.7.0 and driver 0.38.0; that
 * bootstrap is not this one). Adding them would be a separate, reviewed
 * change with its own reason.
 */
export const CUA = null;
