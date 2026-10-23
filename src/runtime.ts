/**
 * Where this Worker runs, and what it may trust about a request there.
 * `PIM_RUNTIME` chooses:
 *
 * - `cloudflare`, the default when unset: Cloudflare's edge sets
 *   `CF-Connecting-IP`, the `AUTH_LIMITER` and `API_LIMITER` bindings slow
 *   requests down, and `CF_VERSION_METADATA` dates the deploy, which opens
 *   a window to claim a Pim that has no admin.
 * - `celld`: Pim runs on celld (https://celld.dev) behind the operator's own
 *   ingress proxy. celld passes on every header a client sends and has none
 *   of those bindings. So the proxy proves each request came through it with
 *   the shared secret `PIM_INGRESS_SECRET` in `X-Pim-Ingress-Secret`, and says
 *   which address connected in `X-Pim-Client-IP`, both replacing whatever
 *   the client sent. A Directory object of its own counts requests, and no
 *   window opens: the Pim is claimed only with the setup link from the logs.
 *
 * Any other value, or a celld deployment without a usable secret, refuses
 * every request: a Pim that is set up wrong fails closed rather than
 * trusting what clients say about themselves.
 */

export type Runtime = "cloudflare" | "celld";

/** The header in which celld's ingress proxy sends `PIM_INGRESS_SECRET`. */
export const INGRESS_SECRET_HEADER = "x-pim-ingress-secret";
/** The header in which celld's ingress proxy sends the address the client connected from. */
export const CLIENT_IP_HEADER = "x-pim-client-ip";
/** The shortest `PIM_INGRESS_SECRET` celld's profile accepts. */
export const MIN_INGRESS_SECRET_LENGTH = 32;

/** How long after a deploy a Pim with no admin lets whoever opens it become the admin, on Cloudflare. */
export const CLAIM_WINDOW_MS = 15 * 60 * 1000;

/**
 * What each limit allows. On Cloudflare `auth` is the `AUTH_LIMITER` binding
 * and `api` and `public` share `API_LIMITER`, as wrangler.jsonc sets them; on
 * celld the Directory counts them with these numbers.
 */
export const LIMITS = {
	/** Attempts at sign-in and registration, per client address. */
	auth: { limit: 30, periodMs: 60_000 },
	/** API requests, per person. */
	api: { limit: 600, periodMs: 60_000 },
	/** Requests nobody signs in for, such as public links, per client address. */
	public: { limit: 600, periodMs: 60_000 },
} as const;

export type LimitName = keyof typeof LIMITS;

/** The Directory object that counts celld's limits, apart from the one that keeps accounts, so counting never waits behind registration. */
export const LIMITER_OBJECT = "rate-limits";

/** The runtime `PIM_RUNTIME` names, or why it can't be used. */
function profile(env: Env): { runtime: "cloudflare" } | { runtime: "celld"; secret: string } | { problem: string } {
	const vars = env as unknown as Record<string, unknown>;
	const named = typeof vars.PIM_RUNTIME === "string" ? vars.PIM_RUNTIME.trim() : vars.PIM_RUNTIME;
	if (named === undefined || named === null || named === "" || named === "cloudflare") return { runtime: "cloudflare" };
	if (named !== "celld") return { problem: "PIM_RUNTIME must be cloudflare or celld" };
	const secret = vars.PIM_INGRESS_SECRET;
	if (typeof secret !== "string" || secret === "") return { problem: "PIM_INGRESS_SECRET must be set when PIM_RUNTIME is celld" };
	if (secret.length < MIN_INGRESS_SECRET_LENGTH || !/^[\x21-\x7e]+$/.test(secret)) {
		return { problem: `PIM_INGRESS_SECRET must be at least ${MIN_INGRESS_SECRET_LENGTH} visible ASCII characters, such as \`openssl rand -hex 32\` makes` };
	}
	// The key that seals people's app sign-ins is never also something every request carries.
	if (secret === vars.APP_CREDENTIALS_KEY) return { problem: "PIM_INGRESS_SECRET must not be APP_CREDENTIALS_KEY" };
	if (!vars.Directory) return { problem: "the Directory binding is missing, so requests can't be counted" };
	return { runtime: "celld", secret };
}

/** The runtime this deployment runs on, or null when it is set up wrong. */
export function runtimeOf(env: Env): Runtime | null {
	const found = profile(env);
	return "runtime" in found ? found.runtime : null;
}

const IPV4_PART = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^(?:${IPV4_PART}\\.){3}${IPV4_PART}$`);

/** An IPv6 address's eight 16-bit groups, from its canonical form as `URL` writes it. */
function groups(canonical: string): number[] {
	const [head = "", tail] = canonical.split("::");
	const parse = (part: string) => (part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16)));
	const first = parse(head);
	const last = tail === undefined ? [] : parse(tail);
	return [...first, ...new Array<number>(8 - first.length - last.length).fill(0), ...last];
}

/**
 * The address a client connected from, as Pim counts it: an IPv4 address in
 * dotted decimal, or the /64 network of an IPv6 address, which one
 * subscriber usually holds whole, so walking through it gains nothing. An
 * IPv4 address written as IPv6 is the IPv4 address. Null for anything else,
 * including several addresses, ports, brackets and zones.
 */
export function clientAddress(value: string | null): string | null {
	if (value === null || value.length > 45) return null;
	if (IPV4.test(value)) return value;
	if (!value.includes(":") || !/^[0-9A-Fa-f:.]+$/.test(value)) return null;
	const host = URL.parse(`http://[${value}]/`)?.hostname;
	if (!host?.startsWith("[")) return null;
	const address = groups(host.slice(1, -1));
	if (address.length !== 8 || address.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
	if (address.slice(0, 5).every((group) => group === 0) && address[5] === 0xffff) {
		const [high, low] = [address[6]!, address[7]!];
		return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
	}
	return `${address
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(":")}::/64`;
}

/** Whether two strings are equal, in time that doesn't depend on where they differ. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
	const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= a[index]! ^ b[index]!;
	return difference === 0;
}

/** A request the gateway may serve: who sent it, as far as the runtime can tell, and the request without what only the ingress may say. */
export type Admitted = { readonly request: Request; readonly address: string };

const refuse = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

/**
 * Checks where a request came from before anything else reads it. On
 * Cloudflare it is as it arrived, from the address Cloudflare reports. On
 * celld it must carry the ingress's secret and a valid address, which are
 * then taken off it, with any `CF-Connecting-IP` the client made up.
 */
export async function admitIngress(request: Request, env: Env): Promise<Admitted | Response> {
	const found = profile(env);
	if ("problem" in found) {
		// The operator reads why in the logs; the public learns only that this Pim isn't answering.
		console.error(JSON.stringify({ event: "pim.runtime_misconfigured", problem: found.problem }));
		return refuse(503, "This Pim isn't set up to answer requests yet.");
	}
	if (found.runtime === "cloudflare") return { request, address: request.headers.get("CF-Connecting-IP") ?? "unknown" };
	const secret = request.headers.get(INGRESS_SECRET_HEADER);
	// Not logged: anyone who finds the node's own address can send these, as often as they like.
	if (secret === null || !(await sameSecret(secret, found.secret))) return refuse(403, "Forbidden");
	const address = clientAddress(request.headers.get(CLIENT_IP_HEADER));
	if (address === null) {
		console.error(JSON.stringify({ event: "pim.ingress_refused", why: "no valid client address" }));
		return refuse(400, `The ingress must send the client's address in ${CLIENT_IP_HEADER}.`);
	}
	const headers = new Headers(request.headers);
	for (const name of [INGRESS_SECRET_HEADER, CLIENT_IP_HEADER, "cf-connecting-ip"]) headers.delete(name);
	return { request: new Request(request, { headers }), address };
}

/**
 * Whether a request counted by `key` is over a limit now. On Cloudflare a
 * deployment without the binding has no limit, as before; on celld the
 * Directory counts, and a Pim that can't count refuses.
 */
export async function limited(env: Env, name: LimitName, key: string): Promise<boolean> {
	const runtime = runtimeOf(env);
	if (runtime === "cloudflare") {
		const limiter = (name === "auth" ? env.AUTH_LIMITER : env.API_LIMITER) as RateLimit | undefined;
		if (!limiter) return false;
		return !(await limiter.limit({ key: name === "public" ? `public:${key}` : key })).success;
	}
	if (runtime === null) return true;
	const { limit, periodMs } = LIMITS[name];
	return !(await env.Directory.getByName(LIMITER_OBJECT).hit(name, key, limit, periodMs));
}

/** Whether this version of the Worker was deployed less than `CLAIM_WINDOW_MS` ago. Only Cloudflare says when that was; elsewhere it never is. */
export function claimWindowOpen(env: Env, now: number): boolean {
	if (runtimeOf(env) !== "cloudflare") return false;
	const deployed = Date.parse(env.CF_VERSION_METADATA?.timestamp ?? "");
	return now >= deployed && now < deployed + CLAIM_WINDOW_MS;
}
