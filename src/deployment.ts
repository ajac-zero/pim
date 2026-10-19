import { SEARCH_PROVIDERS, type SearchProvider } from "./extensions/web";
import { APPROVAL_POLICIES, type ApprovalPolicy, validTimeZone } from "./settings";
import { LIMIT_NAMES, type Limits } from "./usage";

/**
 * How this deployment runs for everyone on it: its address, who may join,
 * which models people's agents use, what members may spend, and who answers
 * approvals for people who haven't chosen. Each is a variable set in the
 * Cloudflare dashboard (Workers & Pages → pim → Settings → Variables and
 * Secrets), not in wrangler.jsonc, whose `keep_vars` keeps them through
 * deploys. One left unset takes the default here, except the address, which
 * has none. The admin sees them all, and any that Pim can't read, in
 * Settings → Deployment.
 */
export type DeploymentSettings = {
	/** `PIM_REGISTRATION`: how people join once there is an admin. */
	readonly registration: "invite" | "open" | "closed";
	/** `PIM_MAX_ACCOUNTS`: accounts allowed in all, deleted ones not counted; null for no cap. */
	readonly maxAccounts: number | null;
	/** `PIM_REGISTRATIONS_PER_ADDRESS`: registrations one IP address may make in a day. */
	readonly registrationsPerAddress: number;
	/** `PIM_APPROVAL_POLICY`: who answers approvals for anyone who hasn't chosen. */
	readonly approvalPolicy: ApprovalPolicy;
	/** `PIM_TIME_ZONE`: the time zone of anyone who hasn't set theirs; joining sets the browser's. */
	readonly timeZone: string;
	/** `PIM_MODEL`: the model chats use unless the person chooses another, a Workers AI or AI Gateway catalog id. */
	readonly model: string;
	/** `PIM_MODELS`: models people may choose besides `model`; empty allows any. */
	readonly models: readonly string[];
	/** `PIM_UTILITY_MODEL`: small Workers AI model for side jobs, such as naming chats; null (`off`) turns them off. */
	readonly utilityModel: string | null;
	/** `PIM_MEMORY_MODEL`: model that compresses long-term memory; null uses `model`. */
	readonly memoryModel: string | null;
	/** `PIM_MEMORY_LINES`: lines of long-term memory in every prompt. */
	readonly memoryLines: number;
	/** `PIM_IMAGE_MODEL`: Workers AI text-to-image model that `generate_image` draws with; null (`off`) leaves agents without it. */
	readonly imageModel: string | null;
	/** `PIM_WEB_SEARCH`: provider of `web_search`, billed through AI Gateway; null leaves agents without it. */
	readonly webSearch: SearchProvider | null;
	/** `PIM_LIMIT_*`: members' limits; the admin has none. */
	readonly limits: Limits;
	/** `PIM_PUBLIC_URL`: the only address this Pim answers at; null, when unset or unreadable, and it answers nowhere. */
	readonly publicUrl: string | null;
	/** `PIM_CONTENT_ORIGIN`: another address, routed to this Worker, that serves published artifacts' public links and nothing else; null turns links off. */
	readonly contentOrigin: string | null;
	/** `PIM_EMAIL_FROM`: the address Pim emails from; null sends no email. */
	readonly emailFrom: string | null;
};

/** One variable as the deployment set it, and what's wrong with it, if anything. */
export type DeploymentVariable = { readonly name: string; readonly value: string | null; readonly problem: string | null };

export type Deployment = { readonly settings: DeploymentSettings; readonly variables: readonly DeploymentVariable[] };

/** The variable that sets each limit: `dailyTokens` is `PIM_LIMIT_DAILY_TOKENS`. */
export const limitVariable = (name: keyof Limits) => `PIM_LIMIT_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;

const MODEL_ID = /^@?[A-Za-z0-9][\w.:@/-]{0,199}$/;

function count(value: string): number {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("must be a whole number");
	return Number(value);
}

function model(value: string): string {
	if (!MODEL_ID.test(value)) throw new Error(`${JSON.stringify(value)} isn't a model id, such as @cf/zai-org/glm-5.3`);
	return value;
}

function origin(value: string): string {
	const url = URL.parse(value);
	if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new Error("must be a URL, such as https://pim.example.com");
	return url.origin;
}

function oneOf<T extends string>(choices: readonly T[]) {
	return (value: string): T => {
		if (!choices.includes(value as T)) throw new Error(`must be one of ${choices.join(", ")}`);
		return value as T;
	};
}

/**
 * Reads the deployment's variables. A variable Pim can't read is reported,
 * and counts as its default, except caps and limits, which count as 0, so
 * a typo never lifts them.
 */
export function readDeployment(env: object): Deployment {
	const vars = env as Record<string, unknown>;
	const variables: DeploymentVariable[] = [];
	function variable<T>(name: string, fallback: T, parse: (value: string) => T, unreadable: T = fallback, required = false): T {
		const given = vars[name];
		const text = given === undefined || given === null ? "" : (typeof given === "string" ? given : JSON.stringify(given)).trim();
		const value = text === "" ? null : text;
		if (value === null) {
			variables.push({ name, value, problem: required ? `${name} must be set` : null });
			return fallback;
		}
		try {
			const parsed = parse(value);
			variables.push({ name, value, problem: null });
			return parsed;
		} catch (error) {
			variables.push({ name, value, problem: `${name} ${error instanceof Error ? error.message : String(error)}` });
			return unreadable;
		}
	}

	const registration = variable("PIM_REGISTRATION", "invite", oneOf(["invite", "open", "closed"] as const));
	const maxAccounts = variable<number | null>("PIM_MAX_ACCOUNTS", null, count, 0);
	const registrationsPerAddress = variable("PIM_REGISTRATIONS_PER_ADDRESS", 3, count, 0);
	const approvalPolicy = variable<ApprovalPolicy>("PIM_APPROVAL_POLICY", "majordomo", oneOf(APPROVAL_POLICIES));
	const timeZone = variable("PIM_TIME_ZONE", "UTC", (value) => {
		if (!validTimeZone(value)) throw new Error("must be an IANA time zone, such as Europe/Lisbon");
		return value;
	});
	const defaultModel = variable("PIM_MODEL", "@cf/zai-org/glm-5.3", model);
	// A list Pim can't read allows only the default: an unreadable list never opens every model.
	const models = variable<readonly string[]>("PIM_MODELS", [], (value) => [...new Set(value.split(/[\s,]+/).filter(Boolean).map(model))], [defaultModel]);
	const utilityModel = variable<string | null>("PIM_UTILITY_MODEL", "@cf/ibm-granite/granite-4.0-h-micro", (value) => (value === "off" ? null : model(value)));
	const memoryModel = variable<string | null>("PIM_MEMORY_MODEL", null, model);
	const memoryLines = variable("PIM_MEMORY_LINES", 96, (value) => {
		const lines = count(value);
		if (lines < 8) throw new Error("must be at least 8");
		return lines;
	});
	const imageModel = variable<string | null>("PIM_IMAGE_MODEL", "@cf/black-forest-labs/flux-2-klein-4b", (value) => {
		if (value === "off") return null;
		if (!value.startsWith("@cf/")) throw new Error("must be a Workers AI text-to-image model, such as @cf/black-forest-labs/flux-2-klein-4b, or off");
		return model(value);
	});
	const webSearch = variable<SearchProvider | null>("PIM_WEB_SEARCH", null, oneOf(SEARCH_PROVIDERS));
	const limits = Object.fromEntries(LIMIT_NAMES.map((name) => [name, variable<number | null>(limitVariable(name), null, count, 0)])) as unknown as Limits;
	const publicUrl = variable<string | null>("PIM_PUBLIC_URL", null, origin, null, true);
	// Pages anyone can open must not share the app's origin, its cookies and its API.
	const contentOrigin = variable<string | null>("PIM_CONTENT_ORIGIN", null, (value) => {
		const content = origin(value);
		if (content === publicUrl) throw new Error("must be another address than PIM_PUBLIC_URL");
		return content;
	});
	const emailFrom = variable<string | null>("PIM_EMAIL_FROM", null, (value) => {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("must be an email address, such as pim@example.com");
		return value;
	});
	return {
		settings: {
			registration,
			maxAccounts,
			registrationsPerAddress,
			approvalPolicy,
			timeZone,
			model: defaultModel,
			models,
			utilityModel,
			memoryModel,
			memoryLines,
			imageModel,
			webSearch,
			limits,
			publicUrl,
			contentOrigin,
			emailFrom,
		},
		variables,
	};
}

/** The deployment's settings, from its variables. */
export const deploymentSettings = (env: object): DeploymentSettings => readDeployment(env).settings;
