/**
 * Which version of Pim this is, and whether a newer image is published on its channel. The image carries its own version and commit (`PIM_VERSION` and `PIM_REVISION`, build arguments of
 * `deploy/Dockerfile.v2`; a local build is `dev` at an unknown revision). The instance follows one channel (`PIM_CHANNEL`, `stable` by default; also `edge`, or an `X.Y` or `X.Y.Z` tag),
 * which is a tag of the public image on GHCR. The maintenance role asks the registry's anonymous API, a few times a day, what that tag is now (its `org.opencontainers.image.version` and
 * `.revision` labels) and keeps the answer in `instance_settings`; the Gate compares it with the running version when the admin looks, so the notice clears by itself after an update.
 * `PIM_UPDATE_CHECK=off` makes no request at all.
 */
import type { Db } from "@pim/v2-app/db";

export const UPDATE_KEY = "update_check";
/** A good answer is kept this long, and a failed check is tried again after the shorter time, so the registry is asked a few times a day at most. */
export const CHECK_EVERY_MS = 6 * 3_600_000;
export const RETRY_AFTER_MS = 3 * 3_600_000;
const DEFAULT_IMAGE = "ghcr.io/ajac-zero/pim";
const REQUEST_MS = 10_000;
const MANIFESTS = ["application/vnd.oci.image.index.v1+json", "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json", "application/vnd.docker.distribution.manifest.v2+json"];

type Env = Readonly<Record<string, string | undefined>>;

export type Running = { version: string; revision: string; channel: string };
export type Published = { version: string | null; revision: string | null; digest: string | null };
/** What the last check found, as `instance_settings` keeps it. */
export type CheckRecord = { channel: string; checkedAt: number; latest: Published | null; error: string | null };

export const runningRelease = (env: Env): Running => ({ version: env.PIM_VERSION?.trim() || "dev", revision: env.PIM_REVISION?.trim() || "unknown", channel: env.PIM_CHANNEL?.trim() || "stable" });
export const checkEnabled = (env: Env) => !/^(off|false|0|no)$/i.test(env.PIM_UPDATE_CHECK?.trim() ?? "");
const imageOf = (env: Env) => env.PIM_UPDATE_IMAGE?.trim() || DEFAULT_IMAGE;

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
const semver = (v: string | null) => {
	const m = v ? SEMVER.exec(v) : null;
	return m ? ([Number(m[1]), Number(m[2]), Number(m[3])] as const) : null;
};
const known = (revision: string | null): revision is string => !!revision && revision !== "unknown";
const sameRevision = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/** Whether `latest` is newer than what runs: by version where both are X.Y.Z, otherwise by the commit differing. A local build (no version, no commit) is never offered anything. */
export function updateAvailable(running: Running, latest: Published | null): boolean {
	if (!latest) return false;
	const [a, b] = [semver(running.version), semver(latest.version)];
	if (a && b) return b[0] !== a[0] ? b[0] > a[0] : b[1] !== a[1] ? b[1] > a[1] : b[2] > a[2];
	return known(running.revision) && known(latest.revision) && !sameRevision(running.revision, latest.revision);
}

/** Where a person reads what is in `latest`: its release page, or its commit for a channel that follows main. */
export function notesUrl(env: Env, latest: Published): string | null {
	const [, owner, name] = /^ghcr\.io\/([^/]+)\/([^/]+)$/.exec(imageOf(env)) ?? [];
	if (!owner || !name) return null;
	const repo = `https://github.com/${owner}/${name}`;
	if (semver(latest.version)) return `${repo}/releases/tag/v${latest.version!.replace(/^v/, "")}`;
	return known(latest.revision) ? `${repo}/commit/${latest.revision}` : null;
}

/** The image the channel's tag names now, read from the registry without a login: its digest and its version and revision labels. */
export async function fetchChannel(env: Env, fetcher: typeof fetch = fetch): Promise<Published> {
	const image = imageOf(env);
	const [, host, path] = /^([^/]+)\/(.+)$/.exec(image) ?? [];
	if (host !== "ghcr.io" || !path) throw new Error(`PIM_UPDATE_IMAGE must be a ghcr.io image, not ${image}`);
	const channel = runningRelease(env).channel;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channel)) throw new Error("PIM_CHANNEL is not a tag name");
	const get = async (url: string, headers: Record<string, string> = {}) => {
		const res = await fetcher(url, { headers, signal: AbortSignal.timeout(REQUEST_MS) });
		if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} for ${new URL(url).pathname}`);
		return res;
	};
	const grant = ((await (await get(`https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull`)).json()) as { token?: string }).token;
	if (!grant) throw new Error("ghcr.io gave no pull grant");
	const auth = { authorization: `Bearer ${grant}` };
	const manifest = async (ref: string) => {
		const res = await get(`https://ghcr.io/v2/${path}/manifests/${ref}`, { ...auth, accept: MANIFESTS.join(", ") });
		return { digest: res.headers.get("docker-content-digest"), body: (await res.json()) as any };
	};
	const top = await manifest(channel);
	let body = top.body;
	// A multi-platform tag is an index; its first real image (not an attestation, whose platform is `unknown`) has the labels, which are the same for each platform.
	if (Array.isArray(body.manifests)) {
		const entry = body.manifests.find((m: any) => m.platform?.os !== "unknown" && m.platform?.architecture !== "unknown") ?? body.manifests[0];
		if (!entry?.digest) throw new Error(`${channel} lists no image`);
		body = (await manifest(entry.digest)).body;
	}
	const configDigest = body.config?.digest;
	if (typeof configDigest !== "string") throw new Error(`${channel} has no image config`);
	const labels = ((await (await get(`https://ghcr.io/v2/${path}/blobs/${configDigest}`, auth)).json()) as any).config?.Labels ?? {};
	return { digest: top.digest, version: labels["org.opencontainers.image.version"] ?? null, revision: labels["org.opencontainers.image.revision"] ?? null };
}

export async function readRecord(db: Db): Promise<CheckRecord | null> {
	const row = (await db.anonymous(async (tx) => (await tx.query("SELECT value FROM pim_app.instance_settings WHERE key = $1", [UPDATE_KEY])).rows[0])) as { value: CheckRecord } | undefined;
	return row?.value ?? null;
}

/**
 * One look at the registry, if one is due: never with the check off, never for a local build, and not before the last answer is `CHECK_EVERY_MS` old (or `RETRY_AFTER_MS` for a failure,
 * or at once when the channel changed). Returns the record when it asked.
 */
export async function checkForUpdate(db: Db, env: Env, { now = Date.now(), fetcher = fetch }: { now?: number; fetcher?: typeof fetch } = {}): Promise<CheckRecord | null> {
	if (!checkEnabled(env)) return null;
	const running = runningRelease(env);
	if (!known(running.revision) && !semver(running.version)) return null;
	const last = await readRecord(db);
	if (last && last.channel === running.channel && now - last.checkedAt < (last.error ? RETRY_AFTER_MS : CHECK_EVERY_MS)) return null;
	let record: CheckRecord;
	try {
		record = { channel: running.channel, checkedAt: now, latest: await fetchChannel(env, fetcher), error: null };
	} catch (error) {
		record = { channel: running.channel, checkedAt: now, latest: last?.channel === running.channel ? last.latest : null, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
	}
	await db.anonymous((tx) => tx.query("INSERT INTO pim_app.instance_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [UPDATE_KEY, JSON.stringify(record)]));
	return record;
}

/** What Settings → Deployment shows of the release: what runs, and what the last check found. Nothing is fetched here. */
export function releaseView(env: Env, record: CheckRecord | null) {
	const running = runningRelease(env);
	const enabled = checkEnabled(env);
	const mine = enabled && record?.channel === running.channel ? record : null;
	const latest = mine?.latest ?? null;
	return {
		...running,
		check: enabled ? ("on" as const) : ("off" as const),
		checkedAt: mine?.checkedAt ?? null,
		error: mine?.error ?? null,
		available: updateAvailable(running, latest),
		latest: latest ? { version: latest.version, revision: latest.revision, notesUrl: notesUrl(env, latest) } : null,
	};
}
