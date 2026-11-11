import { containerProvider } from "./coding/workspace/cloudflare";
import { ComposeWorkspaceProvider } from "./coding/workspace/compose";
import type { WorkspaceProvider } from "./coding/workspace/types";
import { HttpError } from "./http";

/**
 * Compute providers: the third-party services whose sandboxes run coding
 * threads' workspaces. Like the admin's model providers, they are set once
 * for the whole deployment, shared by everyone on it, and paid for by whoever
 * runs it: nobody brings their own. Their credentials are kept in the Gallery
 * (./gallery.ts) and handed only to the Durable Objects that make workspaces;
 * no route ever shows one again, only that it is set.
 *
 * Each kind below says which settings and credentials a provider takes and
 * which workspace backend (src/coding/workspace) it makes. A deployment has at
 * most one provider of each kind, and the provider's id is its kind.
 *
 * What people may use of them is limited by quotas (`ComputeQuota`): a
 * deployment default the admin sets, and an override for one person.
 */

/** A kind's field: `secret` ones are credentials, kept apart and never shown again. */
type Field = { readonly name: string; readonly secret: boolean; readonly required: boolean };

/**
 * Whether new coding threads go to a backend first (`primary`), or to it
 * only when the primary ones have no room for them (`overflow`). An overflow
 * backend is still the default where it is the only one.
 */
export type ComputeRole = "primary" | "overflow";

type Kind = {
	readonly name: string;
	/** The id of the workspace backend (`WorkspaceProvider.id`) a provider of this kind makes. */
	readonly workspace: string;
	readonly role: ComputeRole;
	readonly fields: readonly Field[];
};

/** The kinds Pim can make workspaces with. Daytona, E2B and the others join here as their backends are written. */
export const COMPUTE_KINDS = {
	// Billed by the second while up, it takes the threads the sandbox manager has no room for.
	"cloudflare-sandbox": { name: "Cloudflare Containers", workspace: "cloudflare", role: "overflow", fields: [] },
	compose: {
		name: "Sandbox manager",
		workspace: "compose",
		role: "primary",
		fields: [
			{ name: "managerUrl", secret: false, required: true },
			{ name: "token", secret: true, required: true },
		],
	},
} as const satisfies Record<string, Kind>;

export type ComputeKind = keyof typeof COMPUTE_KINDS;

const isKind = (value: unknown): value is ComputeKind => typeof value === "string" && Object.hasOwn(COMPUTE_KINDS, value);

/** A provider as it's kept: its credentials included. */
export type ComputeProvider = {
	/** The kind's name: a deployment has one provider of each kind. */
	readonly id: ComputeKind;
	readonly kind: ComputeKind;
	readonly name: string;
	/** What isn't secret, by field name, such as the manager's address. */
	readonly settings: Readonly<Record<string, string>>;
	/** Secrets, by field name. */
	readonly credentials: Readonly<Record<string, string>>;
	/** Whether coding threads may get their workspaces here, as their first choice or as overflow by its kind's role. A provider switched off stays configured. */
	readonly codingSandbox: boolean;
	/** Reserved for agents' own computers; nothing uses it yet. */
	readonly agentComputer: boolean;
};

/** A provider as the API shows it: which credentials are set, never what they are. */
export type ComputeProviderInfo = Omit<ComputeProvider, "credentials"> & { readonly credentialsSet: Readonly<Record<string, boolean>> };

/** What adding or changing a provider gives; a missing field keeps what it was. */
export type ComputeProviderInput = {
	readonly kind?: unknown;
	readonly name?: unknown;
	readonly settings?: unknown;
	readonly credentials?: unknown;
	readonly codingSandbox?: unknown;
	readonly agentComputer?: unknown;
};

/** A provider without its secrets: the only form any route returns. */
export function computeProviderInfo({ credentials, ...provider }: ComputeProvider): ComputeProviderInfo {
	const fields = COMPUTE_KINDS[provider.kind].fields.filter((field) => field.secret);
	return { ...provider, credentialsSet: Object.fromEntries(fields.map((field) => [field.name, Boolean(credentials[field.name])])) };
}

/** What the people's spaces need to know of a provider to say whether coding is on: no credentials. `usable` is whether this Worker can make its workspaces at all. */
export type ComputeSummary = { readonly id: ComputeKind; readonly kind: ComputeKind; readonly codingSandbox: boolean; readonly usable: boolean };

export function computeSummary(provider: ComputeProvider, env: object): ComputeSummary {
	let usable = false;
	try {
		usable = workspaceProviderOf(provider, env) !== null;
	} catch {}
	return { id: provider.id, kind: provider.kind, codingSandbox: provider.codingSandbox, usable };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function readText(value: unknown, field: string, max: number): string {
	if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
	const trimmed = value.trim();
	if (trimmed.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`);
	return trimmed;
}

/** Reads the values the admin gave for a kind's fields, over `existing`: a field left out stays, an empty one is taken away. */
function readFields(given: unknown, label: "settings" | "credentials", secret: boolean, kind: ComputeKind, existing: Readonly<Record<string, string>>): Record<string, string> {
	const allowed = COMPUTE_KINDS[kind].fields.filter((field) => field.secret === secret).map((field) => field.name as string);
	if (given !== undefined && !isObject(given)) throw new HttpError(400, `${label} must be an object`);
	const values: Record<string, string> = { ...existing };
	for (const [name, value] of Object.entries(given ?? {})) {
		if (!allowed.includes(name)) throw new HttpError(400, `${COMPUTE_KINDS[kind].name} has no ${name} ${label === "settings" ? "setting" : "credential"}`);
		const text = value === null ? "" : readText(value, name, 2_000);
		if (text) values[name] = text;
		else delete values[name];
	}
	return values;
}

/** Checks a new provider, or a change to `existing`, and returns it as it will be kept. */
export function prepareComputeProvider(input: ComputeProviderInput, existing: ComputeProvider | null): ComputeProvider {
	const kind = input.kind === undefined ? existing?.kind : input.kind;
	if (!isKind(kind)) throw new HttpError(400, `kind must be one of ${Object.keys(COMPUTE_KINDS).join(", ")}`);
	if (existing && kind !== existing.kind) throw new HttpError(400, "A provider's kind cannot be changed. Add another provider instead.");
	const name = input.name === undefined ? (existing?.name ?? COMPUTE_KINDS[kind].name) : readText(input.name, "name", 60) || COMPUTE_KINDS[kind].name;
	const settings = readFields(input.settings, "settings", false, kind, existing?.settings ?? {});
	const credentials = readFields(input.credentials, "credentials", true, kind, existing?.credentials ?? {});
	if (settings.managerUrl !== undefined) {
		// An address is a place, not a login: credentials in it would be kept and shown as a setting.
		const url = URL.parse(settings.managerUrl);
		if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new HttpError(400, "managerUrl must be an http(s) address");
		if (url.username || url.password) throw new HttpError(400, "managerUrl must not contain a user name or password: give the token as a credential");
	}
	for (const field of COMPUTE_KINDS[kind].fields) {
		const given = field.secret ? credentials[field.name] : settings[field.name];
		if (field.required && !given) throw new HttpError(400, `${COMPUTE_KINDS[kind].name} needs ${field.name}`);
	}
	for (const flag of ["codingSandbox", "agentComputer"] as const) {
		if (input[flag] !== undefined && typeof input[flag] !== "boolean") throw new HttpError(400, `${flag} must be true or false`);
	}
	return {
		id: kind,
		kind,
		name,
		settings,
		credentials,
		codingSandbox: (input.codingSandbox as boolean | undefined) ?? existing?.codingSandbox ?? true,
		agentComputer: (input.agentComputer as boolean | undefined) ?? existing?.agentComputer ?? false,
	};
}

/**
 * The workspace backend a provider makes, or null when this Worker can't make
 * it (Cloudflare Containers needs both workspace bindings). Throws with
 * why when its settings can't be used.
 */
export function workspaceProviderOf(provider: ComputeProvider, env: object): WorkspaceProvider | null {
	switch (provider.kind) {
		case "cloudflare-sandbox":
			return containerProvider(env);
		case "compose":
			return new ComposeWorkspaceProvider({ managerUrl: provider.settings.managerUrl ?? "", token: provider.credentials.token ?? "" });
	}
}

/** The role of the workspace backend `id`, by the kind that makes it; a backend no kind makes is primary. */
export function workspaceRole(id: string): ComputeRole {
	return Object.values(COMPUTE_KINDS).find((kind) => kind.workspace === id)?.role ?? "primary";
}

/** Removes every credential from a message that may quote one, such as an error from a library. */
export function withoutSecrets(message: string, provider: ComputeProvider): string {
	let clean = message;
	for (const secret of Object.values(provider.credentials)) if (secret.length >= 4) clean = clean.split(secret).join("[hidden]");
	return clean.slice(0, 300);
}

const HEALTH_TIMEOUT_MS = 15_000;

/** What a health check found. */
export type ComputeHealth = { readonly ok: boolean; readonly message: string; readonly ms: number };

/** One cheap read against the provider: its workspace listing, and for the manager its `/health` too. Never throws, and never says a credential. */
export async function checkCompute(provider: ComputeProvider, env: object): Promise<ComputeHealth> {
	const started = Date.now();
	const result = (ok: boolean, message: string): ComputeHealth => ({ ok, message, ms: Date.now() - started });
	const read = async (): Promise<ComputeHealth> => {
		const backend = workspaceProviderOf(provider, env);
		if (!backend) return result(false, "This Worker has no WorkspaceContainer and WorkspaceCatalog bindings, so Cloudflare Containers can't be used.");
		// The manager's `/health` needs no token, so its listing, which does, is what shows the credentials work.
		await backend.list();
		const health = provider.kind === "compose" ? await (backend as ComposeWorkspaceProvider).managerHealth() : null;
		return result(true, health ? `Reachable: ${health.running} of ${health.maxConcurrent} workspaces running.` : "Ready.");
	};
	// A provider that keeps retrying a down service shouldn't keep the admin waiting.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ComputeHealth>((resolve) => {
		timer = setTimeout(() => resolve(result(false, "It didn't answer in 15 seconds.")), HEALTH_TIMEOUT_MS);
	});
	try {
		return await Promise.race([read(), timeout]);
	} catch (error) {
		return result(false, withoutSecrets(error instanceof Error ? error.message : String(error), provider));
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The ids of the workspace backends coding threads may use: those the
 * deployment's environment sets up, with a configured provider's put in, or,
 * when the admin switched it off for coding, taken out. Nothing configured
 * leaves the environment's as they were.
 */
export function codingBackendIds(environment: readonly string[], configured: readonly ComputeSummary[]): string[] {
	const on = configured.filter((provider) => provider.codingSandbox && provider.usable).map((provider) => COMPUTE_KINDS[provider.kind].workspace as string);
	const off = new Set(configured.filter((provider) => !provider.codingSandbox).map((provider) => COMPUTE_KINDS[provider.kind].workspace as string));
	return [...new Set([...on, ...environment.filter((id) => !off.has(id))])];
}

/** The line a chat's system prompt carries while no provider can run a coding thread. */
export const NO_CODING_SANDBOX_LINE = "Coding threads are unavailable: this Pim has no coding sandbox provider configured, so you have no coding tools. Say so if asked to work on a repository.";

// Quotas

/** What one person may use of the deployment's compute; null is no limit. */
export type ComputeQuota = {
	/** Workspaces running at once. */
	readonly maxConcurrentWorkspaces: number | null;
	/** Minutes of running sandboxes in a UTC month, over every provider. */
	readonly monthlySandboxMinutes: number | null;
	/** Minutes one workspace may run before it is stopped. */
	readonly maxSessionMinutes: number | null;
};

export const QUOTA_NAMES = ["maxConcurrentWorkspaces", "monthlySandboxMinutes", "maxSessionMinutes"] as const satisfies readonly (keyof ComputeQuota)[];

/** The quota a deployment starts with, until its admin sets one: none. A deployment that ran coding threads before quotas existed keeps running them as before; the admin who wants limits sets them. */
export const DEFAULT_COMPUTE_QUOTA: ComputeQuota = { maxConcurrentWorkspaces: null, monthlySandboxMinutes: null, maxSessionMinutes: null };

/** Checks a partial quota, as the admin sets one: each a non-negative integer or null. */
export function parseComputeQuota(value: unknown): Partial<ComputeQuota> {
	if (!isObject(value)) throw new HttpError(400, "quota must be an object");
	const quota: Record<string, number | null> = {};
	for (const [name, limit] of Object.entries(value)) {
		if (!(QUOTA_NAMES as readonly string[]).includes(name)) throw new HttpError(400, `Unknown quota ${name}`);
		if (limit !== null && !(Number.isSafeInteger(limit) && (limit as number) >= 0)) throw new HttpError(400, `${name} must be a non-negative integer or null`);
		quota[name] = limit as number | null;
	}
	return quota as Partial<ComputeQuota>;
}

/** A person's quota: their own where the admin set it, the deployment's otherwise. */
export const resolveQuota = (deployment: ComputeQuota, own: Partial<ComputeQuota> | null): ComputeQuota => ({ ...deployment, ...(own ?? {}) });
