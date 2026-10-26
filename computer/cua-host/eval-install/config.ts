/**
 * What a Cua evaluation VM's installation is made of (docs/cua-eval-install.md):
 * the fixed accounts, paths, tools and services, and the one configuration
 * an operator gives, checked strictly. It is shared by the operator's side
 * (./operator.ts, which renders the management scripts and makes the bundle)
 * and the VM's (./install.ts, which runs as root from the verified bundle).
 *
 * The configuration holds nothing secret: IDs, digests, paths, the
 * evaluation's public key and the bridge's address. The bridge's TLS key is
 * a file staged on the VM, and its token is made there by
 * ../eval-credentials.ts; neither passes through anything here.
 *
 * Importing it does nothing.
 */

import * as crypto from "node:crypto";
import * as net from "node:net";
import * as path from "node:path";

/** The three accounts and groups. The desktop account is a prerequisite; the other two are made by the installer. */
export const ACCOUNTS = { desktop: "pim-desktop", bridge: "pim-bridge", session: "pim-session" } as const;

/** Everything the installer makes, at fixed paths. */
export const PATHS = {
	bridgeDir: "/etc/pim-bridge",
	token: "/etc/pim-bridge/token",
	cert: "/etc/pim-bridge/cert.pem",
	key: "/etc/pim-bridge/key.pem",
	evalDir: "/etc/pim-eval",
	publicKey: "/etc/pim-eval/eval-key.pub.pem",
	socketDir: "/run/pim-session",
	socket: "/run/pim-session/session.sock",
	tmpfiles: "/etc/tmpfiles.d/pim-cua-session.conf",
	desktopUnit: "/etc/systemd/system/pim-cua-desktop.service",
	bridgeUnit: "/etc/systemd/system/pim-cua-bridge.service",
} as const;

export const UNITS = { desktop: "pim-cua-desktop.service", bridge: "pim-cua-bridge.service" } as const;

/** Ubuntu 24.04's own programs, by their canonical paths; the installer checks each is root's. */
export const TOOLS = {
	groupadd: "/usr/sbin/groupadd",
	useradd: "/usr/sbin/useradd",
	runuser: "/usr/sbin/runuser",
	nologin: "/usr/sbin/nologin",
	systemctl: "/usr/bin/systemctl",
	tmpfiles: "/usr/bin/systemd-tmpfiles",
	find: "/usr/bin/find",
	head: "/usr/bin/head",
	dash: "/usr/bin/dash",
} as const;

/** The files of the bundle the installation runs, relative to its directory. */
export const BUNDLE_FILES = {
	marker: "BUNDLE",
	pimComputer: "computer/pim-computer.ts",
	bridge: "computer/cua-host/bridge.ts",
	desktop: "computer/cua-host/desktop.ts",
	credentials: "computer/cua-host/eval-credentials.ts",
	installer: "computer/cua-host/eval-install/install.ts",
	ws: "computer/cua-host/node_modules/ws/package.json",
} as const;

/** The first line of the bundle's `BUNDLE` file, followed by `commit <sha>`. */
export const BUNDLE_FORMAT = "pim-cua-eval-bundle v1";

/** The oldest Node the programs run on (type stripping without a flag). */
export const MIN_NODE = [22, 18, 0] as const;

export type Config = {
	readonly version: 1;
	readonly evaluation: string;
	readonly owner: string;
	readonly commit: string;
	readonly bundle: { readonly dir: string; readonly sha256: string };
	readonly node: { readonly path: string; readonly sha256: string; readonly version: string };
	readonly browser: { readonly path: string; readonly sha256: string };
	readonly workspace: string;
	readonly tls: { readonly cert: string; readonly key: string };
	readonly evalKey: { readonly fingerprint: string; readonly publicKeyPem: string };
	readonly bridge: { readonly host: string; readonly port: number; readonly path: string };
	readonly desktop: { readonly headful: boolean; readonly display: string | null; readonly xauthority: string | null };
};

/** A refusal with a fixed reason, the only thing said about it. */
export class Refusal extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(reason);
		this.reason = reason;
	}
}

// As ../eval-credentials.ts checks them.
const EVALUATION = /^[a-z0-9][a-z0-9-]{2,62}$/;
const OWNER = /^o_[0-9a-z]{26}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NODE_VERSION = /^v(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;
/** A path's components: letters, digits, `.`, `_` and `-`, so it needs no quoting in a unit file or a shell script. */
const COMPONENT = /^[A-Za-z0-9._-]+$/;
const URL_COMPONENT = /^[A-Za-z0-9._~-]+$/;
const DISPLAY = /^:[0-9]{1,2}$/;
const PEM = /^-----BEGIN PUBLIC KEY-----\n(?:[A-Za-z0-9+/=]{1,64}\n){1,40}-----END PUBLIC KEY-----\n$/;

/** Whether `value` is an absolute, normalized path of plain components, at most 255 bytes. */
export function isPlainPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 255 || !value.startsWith("/") || value === "/") return false;
	const parts = value.slice(1).split("/");
	return parts.every((part) => COMPONENT.test(part) && part !== "." && part !== "..") && path.posix.normalize(value) === value;
}

/** Whether `inner` is `outer` or inside it. */
export function within(inner: string, outer: string): boolean {
	return inner === outer || inner.startsWith(`${outer}/`);
}

export function nodeVersionAtLeast(version: string, minimum: readonly number[]): boolean {
	const match = NODE_VERSION.exec(version);
	if (!match) return false;
	const parts = match.slice(1).map(Number);
	for (let i = 0; i < minimum.length; i++) {
		if (parts[i]! !== minimum[i]!) return parts[i]! > minimum[i]!;
	}
	return true;
}

/** The SHA-256 of a public key's SubjectPublicKeyInfo (DER), as eval-credentials.ts pins it. */
export function fingerprintOf(pem: string): string {
	const key = crypto.createPublicKey(pem);
	return crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

type Shape = { readonly [key: string]: Shape | ((value: unknown) => boolean) };

function check(value: unknown, shape: Shape, where: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal(`config-${where}`);
	const record = value as Record<string, unknown>;
	const keys = Object.keys(shape);
	if (Object.keys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(record, key))) throw new Refusal(`config-${where}`);
	for (const key of keys) {
		const rule = shape[key]!;
		if (typeof rule === "function") {
			if (!rule(record[key])) throw new Refusal(`config-${key}`);
		} else check(record[key], rule, key);
	}
}

const matches = (pattern: RegExp) => (value: unknown) => typeof value === "string" && pattern.test(value);

/**
 * The configuration in `text`, a JSON object with exactly the fields of
 * `Config`, each checked; anything else is refused with a fixed reason
 * (`config-<field>`). The public key must be RSA-3072 with exponent 65537
 * and have the pinned fingerprint, as `seal` will require.
 */
export function parseConfig(text: string): Config {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Refusal("config-json");
	}
	check(
		value,
		{
			version: (v) => v === 1,
			evaluation: matches(EVALUATION),
			owner: matches(OWNER),
			commit: matches(COMMIT),
			bundle: { dir: isPlainPath, sha256: matches(HEX64) },
			node: { path: isPlainPath, sha256: matches(HEX64), version: (v) => typeof v === "string" && nodeVersionAtLeast(v, MIN_NODE) },
			browser: { path: isPlainPath, sha256: matches(HEX64) },
			workspace: isPlainPath,
			tls: { cert: isPlainPath, key: isPlainPath },
			evalKey: { fingerprint: matches(HEX64), publicKeyPem: (v) => typeof v === "string" && v.length < 4096 && PEM.test(v) },
			bridge: {
				host: (v) => typeof v === "string" && net.isIP(v) !== 0 && !v.includes("%"),
				port: (v) => Number.isSafeInteger(v) && (v as number) >= 1024 && (v as number) <= 65535,
				path: (v) => typeof v === "string" && v.length <= 128 && v.startsWith("/") && v.slice(1).split("/").every((part) => URL_COMPONENT.test(part) && part !== "." && part !== ".."),
			},
			desktop: { headful: (v) => typeof v === "boolean", display: (v) => v === null || matches(DISPLAY)(v), xauthority: (v) => v === null || isPlainPath(v) },
		},
		"object",
	);
	const config = value as Config;

	let key: crypto.KeyObject;
	try {
		key = crypto.createPublicKey(config.evalKey.publicKeyPem);
	} catch {
		throw new Refusal("config-public-key");
	}
	const details = key.asymmetricKeyDetails;
	if (key.asymmetricKeyType !== "rsa" || details?.modulusLength !== 3072 || details.publicExponent !== 65537n) throw new Refusal("config-public-key");
	if (fingerprintOf(config.evalKey.publicKeyPem) !== config.evalKey.fingerprint) throw new Refusal("config-fingerprint");

	// A headful browser needs the persistent session's display; a headless one is given none.
	if (config.desktop.headful !== (config.desktop.display !== null) || (!config.desktop.headful && config.desktop.xauthority !== null)) throw new Refusal("config-desktop");
	// The workspace is under /srv: never where a system program reads its configuration, such as a unit's drop-in directory.
	if (!config.workspace.startsWith("/srv/")) throw new Refusal("config-workspace");
	// The two staged TLS files sit side by side in one staging directory, apart from everything the installation makes or runs.
	if (path.posix.dirname(config.tls.cert) !== path.posix.dirname(config.tls.key) || config.tls.cert === config.tls.key) throw new Refusal("config-tls");
	const fixed = [PATHS.bridgeDir, PATHS.evalDir, PATHS.socketDir, PATHS.tmpfiles, PATHS.desktopUnit, PATHS.bridgeUnit];
	const own = [config.bundle.dir, config.workspace, path.posix.dirname(config.tls.cert), config.node.path, config.browser.path];
	for (const [i, a] of own.entries()) {
		if (fixed.some((b) => within(a, b) || within(b, a))) throw new Refusal("config-overlap");
		for (const b of own.slice(i + 1)) {
			if (within(a, b) || within(b, a)) throw new Refusal("config-overlap");
		}
	}
	return config;
}

/** The tmpfiles.d entry that makes the session socket's directory at boot: the desktop's, setgid to the session group, nothing for others. */
export function renderTmpfiles(): string {
	return `# Pim Cua evaluation (docs/cua-eval-install.md): the session socket's directory.\nd ${PATHS.socketDir} 2750 ${ACCOUNTS.desktop} ${ACCOUNTS.session} -\n`;
}

/**
 * The two services' unit files. Each runs its program as its own account
 * with fixed arguments and only the environment named here. Neither has a
 * resource, confinement or sandboxing directive, and neither restarts by
 * itself. `KillMode=process` with no `SIGKILL` and no stop timeout is there
 * to take away systemd's default (signal every process of the unit, then
 * `SIGKILL` them after 90 s), so stopping a service signals only its main
 * program, and the desktop endpoint ends its own pim-computer as it does
 * (docs/cua-bridge.md) before it exits.
 */
export function renderUnits(config: Config, desktopUid: number): { desktop: string; bridge: string } {
	const node = config.node.path;
	const bundle = config.bundle.dir;
	const headful = config.desktop.headful;
	const display = headful
		? [
				`Environment=DISPLAY=${config.desktop.display}`,
				...(config.desktop.xauthority ? [`Environment=XAUTHORITY=${config.desktop.xauthority}`] : []),
				`Environment=XDG_RUNTIME_DIR=/run/user/${desktopUid}`,
				`Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${desktopUid}/bus`,
			]
		: [];
	const desktop = [
		"# Pim Cua evaluation (docs/cua-eval-install.md): the desktop session endpoint, as the shared desktop account.",
		"[Unit]",
		`Description=Pim Cua evaluation desktop session endpoint`,
		"After=systemd-tmpfiles-setup.service",
		"",
		"[Service]",
		"Type=simple",
		`User=${ACCOUNTS.desktop}`,
		`Group=${ACCOUNTS.desktop}`,
		`WorkingDirectory=${config.workspace}`,
		"Environment=PATH=/usr/local/bin:/usr/bin:/bin",
		"Environment=LANG=C.UTF-8",
		...display,
		`ExecStart=${node} ${bundle}/${BUNDLE_FILES.desktop} --socket ${PATHS.socket} --root ${config.workspace} --browser ${config.browser.path} --pim-computer ${bundle}/${BUNDLE_FILES.pimComputer}${headful ? " --headful" : ""}`,
		// Runs once systemd has seen the endpoint exit. Only when a signal ended it (so it couldn't remove its own socket) is that socket removed,
		// and nothing else; after an exit, a refusal included, whatever is at the path stays, and the next start refuses it (`$$` is a literal `$`).
		`ExecStopPost=${TOOLS.dash} -c 'case "$$EXIT_CODE" in killed|dumped) exec ${TOOLS.find} ${PATHS.socketDir} -mindepth 1 -maxdepth 1 -name ${path.posix.basename(PATHS.socket)} -type s -user ${ACCOUNTS.desktop} -delete;; esac'`,
		"KillMode=process",
		"SendSIGKILL=no",
		"TimeoutStopSec=infinity",
		"Restart=no",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	].join("\n");
	const bridge = [
		"# Pim Cua evaluation (docs/cua-eval-install.md): the bridge, as its own account; it alone reads the token and TLS key.",
		"[Unit]",
		"Description=Pim Cua evaluation bridge",
		"Wants=network-online.target",
		"After=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`User=${ACCOUNTS.bridge}`,
		`Group=${ACCOUNTS.bridge}`,
		"WorkingDirectory=/",
		"Environment=PATH=/usr/bin:/bin",
		`Environment=PIM_BRIDGE_TOKEN_FILE=${PATHS.token}`,
		`Environment=PIM_BRIDGE_CERT_FILE=${PATHS.cert}`,
		`Environment=PIM_BRIDGE_KEY_FILE=${PATHS.key}`,
		`ExecStart=${node} ${bundle}/${BUNDLE_FILES.bridge} --space ${config.owner} --path ${config.bridge.path} --socket ${PATHS.socket} --host ${config.bridge.host} --port ${config.bridge.port}`,
		"KillMode=process",
		"Restart=no",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	].join("\n");
	return { desktop, bridge };
}
