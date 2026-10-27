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
import { isHttpsOrigin } from "../origin.ts";

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
	head: "/usr/bin/head",
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

/**
 * What the viewer adds, when the configuration has a `viewer` (docs/cua-viewer-first-startup.md): the root
 * token's file, which the bridge's account reads and the desktop's can't, and the journal's directory and
 * the tombstone of its one-time provisioning. The installer makes none of them: the root token is a
 * separate gate's, and the journal is made once by `journal-provision.ts`.
 */
export const VIEWER_PATHS = {
	rootToken: "/etc/pim-bridge/viewer-root-token",
	journalDir: "/var/lib/pim-viewer",
	journal: "/var/lib/pim-viewer/journal.json",
	journalLock: "/var/lib/pim-viewer/journal.lock",
	/** Root's, `0444`, made before the journal and never removed or replaced by this tooling: a journal was provisioned, so none is provisioned again. */
	tombstone: "/etc/pim-eval/journal-provisioned",
	/** spacesd's own token file, in a root's directory: the desktop account's (it runs spacesd), `0600`. The value is the bridge's root token's, and is known to the desktop account by design. */
	spacesdDir: "/etc/pim-spacesd",
	spacesdToken: "/etc/pim-spacesd/token",
	spacesdData: "/var/lib/pim-spacesd",
	/** The TLS ingress: Caddy's configuration (root's), the bridge's own certificate it trusts (public part only), and its state (ACME account and certificate key), the ingress account's alone. */
	ingressDir: "/etc/pim-ingress",
	caddyfile: "/etc/pim-ingress/Caddyfile",
	bridgeTrust: "/etc/pim-ingress/bridge-cert.pem",
	ingressState: "/var/lib/pim-ingress",
	spacesdUnit: "/etc/systemd/system/pim-cua-spacesd.service",
	ingressUnit: "/etc/systemd/system/pim-cua-ingress.service",
} as const;

/** The viewer's two more services and the one more account they add. */
export const VIEWER_UNITS = { spacesd: "pim-cua-spacesd.service", ingress: "pim-cua-ingress.service" } as const;
export const VIEWER_ACCOUNTS = { ingress: "pim-ingress" } as const;

/** What `bridge-cert.sh` makes on the VM, as the installer's staging: the bridge's own private certificate, which only Caddy trusts. Its key is born there and never travels. */
export const BRIDGE_CERT_DAYS = 3;

/** The files the viewer adds to the bundle, relative to its directory; `protobuf` is the pinned package's manifest. */
export const VIEWER_BUNDLE_FILES = {
	viewerHost: "computer/cua-host/viewer-host.ts",
	journalStore: "computer/cua-host/journal-store.ts",
	adapter: "computer/cua-host/viewer-adapter.ts",
	manager: "computer/cua-host/viewer-launch-manager.ts",
	lifetime: "computer/cua-host/viewer-lifetime.ts",
	upstream: "computer/cua-host/viewer-upstream.ts",
	provision: "computer/cua-host/eval-install/journal-provision.ts",
	protobuf: "computer/cua-host/node_modules/@bufbuild/protobuf/package.json",
} as const;

/** The viewer's pinned page and scripts, in the bundle under this directory (their SHA-256 is `VIEWER_ASSETS`'s in ./viewer-upstream.ts). */
export const VIEWER_ASSET_DIR = "computer/cua-host/cua-viewer";

/** The names, under `VIEWER_ASSET_DIR`, of the viewer's pinned page and scripts (./viewer-upstream.ts `VIEWER_ASSETS`). */
export const VIEWER_ASSET_NAMES = ["index.html", "viewer.js", "index.css", "audioWorklet.js", "captureWorklet.js"] as const;

/**
 * The SHA-256 of each pinned viewer file, as ./viewer-upstream.ts `VIEWER_ASSETS` pins them. Written out here so the operator's
 * bundle step needs no protobuf install to check them; a test holds the two tables equal.
 */
export const VIEWER_ASSET_SHA256 = {
	"index.html": "6373b22307c629bbb6811e3baaf046bcdcd0074fb87245a6ef79f5d3f0913228",
	"viewer.js": "5a5ee19a184bab0bdbd081c756e127d138030d86a1395dd988e93291ff9bb2f7",
	"index.css": "e4753e6ac86c2142a1912b79823c5edb2149dde8a69272d899df2b7713da921b",
	"audioWorklet.js": "427569b615fe24104fcd5ca8a8f71269d24faa9155a0767ef1f0234a23c6befc",
	"captureWorklet.js": "9cdafdbe7bb59622a9d0cdd63bfd4d9e87644c65210a9b7050e80aef2c4062b0",
} as const;

/** Every file a viewer adds to the bundle, relative to its directory: its programs, its pinned package, and its pinned page and scripts beside their licence. */
export function viewerBundleFiles(): string[] {
	return [...Object.values(VIEWER_BUNDLE_FILES), ...VIEWER_ASSET_NAMES.map((name) => `${VIEWER_ASSET_DIR}/assets/${name}`), `${VIEWER_ASSET_DIR}/LICENSE`];
}

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
	/** Present only when the bridge also serves the view-only viewer (docs/cua-viewer-first-startup.md). */
	readonly viewer?: ViewerConfig;
};

/** What the bridge's viewer flags take (computer/cua-host/viewer-host.ts `parseViewerSettings`), all of them exact. */
export type ViewerConfig = {
	/** Where spacesd is: plain HTTP on 127.0.0.1, never reached from outside. */
	readonly origin: string;
	/** The exact HTTPS origin a browser loads the viewer from: the bridge's own public address. */
	readonly publicOrigin: string;
	/** The exact HTTPS origin of the Pim app that may frame it. */
	readonly embedOrigin: string;
	/** The one display the viewer shows. */
	readonly display: string;
	/** The pinned spacesd binary (root's), run as the desktop account, loopback only. */
	readonly spacesd: { readonly path: string; readonly sha256: string; readonly version: string };
	/** The pinned Caddy binary (root's), the only public listener, run as its own account. */
	readonly caddy: { readonly path: string; readonly sha256: string; readonly version: string };
	/** The DNS name in the bridge's own certificate, which Caddy checks the bridge against (never skipped). */
	readonly backendName: string;
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
const SPACESD_ORIGIN = /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/;
const VIEWER_DISPLAY = /^[A-Za-z0-9._:-]{1,128}$/;
const DNS_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const V_SEMVER = /^v\d+\.\d+\.\d+$/;
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

function check(value: unknown, shape: Shape, where: string, optional: readonly string[] = []): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Refusal(`config-${where}`);
	const record = value as Record<string, unknown>;
	const keys = Object.keys(shape);
	// Exactly the fields of the shape; only those named optional may be absent.
	if (!Object.keys(record).every((key) => keys.includes(key)) || !keys.every((key) => optional.includes(key) || Object.hasOwn(record, key))) throw new Refusal(`config-${where}`);
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) continue;
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
			viewer: {
				origin: matches(SPACESD_ORIGIN),
				publicOrigin: isHttpsOrigin,
				embedOrigin: isHttpsOrigin,
				display: matches(VIEWER_DISPLAY),
				spacesd: { path: isPlainPath, sha256: matches(HEX64), version: matches(SEMVER) },
				caddy: { path: isPlainPath, sha256: matches(HEX64), version: matches(V_SEMVER) },
				backendName: (v) => typeof v === "string" && DNS_NAME.test(v) && net.isIP(v) === 0,
			},
		},
		"object",
		["viewer"],
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
	// The viewer's two origins are two different places: the bridge's own, and the Pim app's.
	if (config.viewer) {
		const viewer = config.viewer;
		if (viewer.publicOrigin === viewer.embedOrigin) throw new Refusal("config-viewer");
		// Caddy is the one public listener, on 443 for exactly the public host: the origin is written without a port, the bridge is private (loopback), and the display is the desktop's headful one.
		if (new URL(viewer.publicOrigin).port !== "" || config.bridge.host !== "127.0.0.1" || !config.desktop.headful) throw new Refusal("config-viewer");
		// The backend's name is a name of its own, never the public host or an address.
		if (viewer.backendName === new URL(viewer.publicOrigin).hostname || new URL(viewer.origin).port === String(config.bridge.port)) throw new Refusal("config-viewer");
	}
	const fixed = [
		PATHS.bridgeDir,
		PATHS.evalDir,
		PATHS.socketDir,
		PATHS.tmpfiles,
		PATHS.desktopUnit,
		PATHS.bridgeUnit,
		...(config.viewer ? [VIEWER_PATHS.journalDir, VIEWER_PATHS.spacesdDir, VIEWER_PATHS.spacesdData, VIEWER_PATHS.ingressDir, VIEWER_PATHS.ingressState, VIEWER_PATHS.spacesdUnit, VIEWER_PATHS.ingressUnit] : []),
	];
	const own = [config.bundle.dir, config.workspace, path.posix.dirname(config.tls.cert), config.node.path, config.browser.path, ...(config.viewer ? [config.viewer.spacesd.path, config.viewer.caddy.path] : [])];
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
 * (docs/cua-bridge.md) before it exits. Nothing here removes the session
 * socket: one an endpoint couldn't remove itself stays until a reboot
 * clears /run, and the next endpoint refuses to start over it.
 */
export function renderUnits(config: Config, desktopUid: number): { desktop: string; bridge: string; spacesd?: string; ingress?: string } {
	const node = config.node.path;
	const bundle = config.bundle.dir;
	const headful = config.desktop.headful;
	const viewer = config.viewer;
	// The reviewed flags of bridge.ts, each exact: spacesd's origin, the bridge's own public origin, the one Pim origin that may frame the page, the journal's directory and the display.
	const viewerFlags = viewer
		? ` --viewer-origin ${viewer.origin} --viewer-public-origin ${viewer.publicOrigin} --viewer-embed-origin ${viewer.embedOrigin} --viewer-journal-dir ${VIEWER_PATHS.journalDir} --viewer-display ${viewer.display}`
		: "";
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
		...(viewer ? [`Environment=PIM_VIEWER_ROOT_TOKEN_FILE=${VIEWER_PATHS.rootToken}`] : []),
		`ExecStart=${node} ${bundle}/${BUNDLE_FILES.bridge} --space ${config.owner} --path ${config.bridge.path} --socket ${PATHS.socket} --host ${config.bridge.host} --port ${config.bridge.port}${viewerFlags}`,
		"KillMode=process",
		"Restart=no",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	].join("\n");
	if (!viewer) return { desktop, bridge };
	// spacesd runs as the desktop account, on loopback only, with the pinned binary, no QUIC, no MCP or driver (native tools stay off) and no pointer probe;
	// its token file is read only by that account. It is the desktop's own authority (docs/cua-viewer-first-startup.md, "spacesd").
	const spacesd = [
		"# Pim Cua evaluation (docs/cua-viewer-first-startup.md): spacesd, as the shared desktop account, loopback only.",
		"[Unit]",
		"Description=Pim Cua evaluation spacesd (view only through the bridge)",
		"",
		"[Service]",
		"Type=simple",
		`User=${ACCOUNTS.desktop}`,
		`Group=${ACCOUNTS.desktop}`,
		`WorkingDirectory=${config.workspace}`,
		"Environment=PATH=/usr/local/bin:/usr/bin:/bin",
		"Environment=LANG=C.UTF-8",
		...display,
		`ExecStart=${viewer.spacesd.path} serve --listen ${new URL(viewer.origin).host} --quic-port 0 --no-mcp --no-driver --cursor-probe false --token-file ${VIEWER_PATHS.spacesdToken} --data-dir ${VIEWER_PATHS.spacesdData}`,
		"KillMode=process",
		"Restart=no",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	].join("\n");
	// Caddy is the only public listener: its own account, state in its own directory, and the one capability it needs to bind 80 and 443.
	const ingress = [
		"# Pim Cua evaluation (docs/cua-viewer-first-startup.md): the TLS ingress, as its own account.",
		"[Unit]",
		"Description=Pim Cua evaluation TLS ingress",
		"Wants=network-online.target",
		"After=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`User=${VIEWER_ACCOUNTS.ingress}`,
		`Group=${VIEWER_ACCOUNTS.ingress}`,
		"WorkingDirectory=/",
		"Environment=PATH=/usr/bin:/bin",
		`Environment=XDG_DATA_HOME=${VIEWER_PATHS.ingressState}`,
		`Environment=XDG_CONFIG_HOME=${VIEWER_PATHS.ingressState}`,
		`ExecStart=${viewer.caddy.path} run --config ${VIEWER_PATHS.caddyfile} --adapter caddyfile`,
		"AmbientCapabilities=CAP_NET_BIND_SERVICE",
		"CapabilityBoundingSet=CAP_NET_BIND_SERVICE",
		"KillMode=process",
		"Restart=no",
		"",
		"[Install]",
		"WantedBy=multi-user.target",
		"",
	].join("\n");
	return { desktop, bridge, spacesd, ingress };
}

/**
 * Caddy's configuration, for the one public hostname and nothing else
 * (docs/cua-viewer-first-startup.md, "The ingress"):
 *
 * - **Certificate:** automatic, for exactly that name, by ACME HTTP-01 on port 80 (the TLS-ALPN
 *   challenge is off). Caddy answers plain HTTP only with its own redirect.
 * - **Forwarding:** only the relay's path, its three management paths, and the adapter's
 *   `/<22 characters>/…` paths, each to the one private bridge on loopback; everything else is
 *   `404`. No forward proxy, no other upstream, no other method of reaching anything.
 * - **Backend TLS:** verified, always: the bridge's own certificate (public part, written by the
 *   installer) is the only trust, and its name is checked (`tls_server_name`). Nothing here
 *   skips verification.
 * - **No log of a target or a header:** access and proxy-error entries are excluded, since a
 *   media ticket is in the query and the launch credential in a header. Only warnings and errors
 *   of Caddy itself (such as a failed ACME order) go to the journal.
 * - **Same origin:** the viewer's page, calls and media socket are all this host, so no CORS
 *   header is added and `Origin` passes unchanged to the bridge, which checks it.
 */
export function renderCaddyfile(config: Config): string {
	const viewer = config.viewer;
	if (!viewer) throw new Refusal("config-viewer");
	const host = new URL(viewer.publicOrigin).hostname;
	const relay = config.bridge.path;
	return [
		"# Pim Cua evaluation (docs/cua-viewer-first-startup.md): the TLS ingress. Written by the installer, never edited.",
		"{",
		"\tadmin off",
		"\thttp_port 80",
		"\thttps_port 443",
		"\tlog {",
		"\t\toutput stderr",
		"\t\tlevel WARN",
		"\t\texclude http.handlers.reverse_proxy http.log.access http.log.error",
		"\t}",
		"}",
		"",
		"(bridge) {",
		"\trequest_body {",
		"\t\tmax_size 16KB",
		"\t}",
		`\treverse_proxy https://127.0.0.1:${config.bridge.port} {`,
		"\t\ttransport http {",
		`\t\t\ttls_server_name ${viewer.backendName}`,
		`\t\t\ttls_trust_pool file ${VIEWER_PATHS.bridgeTrust}`,
		"\t\t}",
		"\t\tflush_interval -1",
		"\t}",
		"}",
		"",
		`${host} {`,
		"\ttls {",
		"\t\tissuer acme {",
		"\t\t\tdisable_tlsalpn_challenge",
		"\t\t}",
		"\t}",
		`\t@bridge path ${relay} ${relay}/observations/launch ${relay}/observations/end ${relay}/observations/status`,
		// Written out, not `{22}`: braces are placeholders in a Caddyfile.
		`\t@viewer path_regexp ^/${"[A-Za-z0-9_-]".repeat(22)}/.+$`,
		"\thandle @bridge {",
		"\t\timport bridge",
		"\t}",
		"\thandle @viewer {",
		"\t\timport bridge",
		"\t}",
		"\thandle {",
		"\t\trespond 404",
		"\t}",
		"}",
		"",
	].join("\n");
}
