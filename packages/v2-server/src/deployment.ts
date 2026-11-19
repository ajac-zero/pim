/**
 * How a deployment runs, from its variables, as v1's `readDeployment` read them: each variable is trimmed, an empty one is unset, and one that cannot be read is
 * reported with why and counts as its default, except caps and limits, which count as 0 so that a typo never lifts them. The admin's Deployment screen shows
 * exactly this, never a value made up for it.
 */
import { LIMIT_NAMES, type Limits, limitVariable } from "@pim/v2-app/quota";
import { registrationPolicy, type RegistrationMode } from "@pim/v2-app/registration";

type Env = Readonly<Record<string, string | undefined>>;
export type DeploymentVariable = { name: string; value: string | null; problem: string | null };
export type ApprovalPolicy = "majordomo" | "auto" | "explicit";
export type DeploymentSettings = {
	registration: RegistrationMode;
	maxAccounts: number | null;
	registrationsPerAddress: number;
	approvalPolicy: ApprovalPolicy;
	timeZone: string;
	model: string;
	/** The models of the AI gateway people may choose; the deployment's own default is always among them. Empty: any. */
	models: string[];
	utilityModel: string | null;
	memoryModel: string | null;
	memoryLines: number;
	imageModel: string | null;
	limits: Limits;
	publicUrl: string | null;
	contentOrigin: string | null;
	appsOrigin: string | null;
	emailFrom: string | null;
};

/** The memory lines a prompt holds when `PIM_MEMORY_LINES` says nothing. */
export const MEMORY_LINES = 96;

/** The memory lines a prompt lists: `PIM_MEMORY_LINES`, at least 8, else 96. */
export const memoryLinesOf = (env: Env): number => {
	const lines = Number(text(env, "PIM_MEMORY_LINES"));
	return Number.isSafeInteger(lines) && lines >= 8 ? lines : MEMORY_LINES;
};

const MODEL_ID = /^[\w.@:/-]{1,200}$/;
const text = (env: Env, name: string) => env[name]?.trim() || undefined;
const validTimeZone = (zone: string) => {
	try {
		new Intl.DateTimeFormat("en", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
};

/** The ids a comma or space separated list names. */
const list = (value: string | undefined) => [...new Set((value ?? "").split(/[\s,]+/).filter(Boolean))];

/**
 * The AI gateway's models that people may choose: `PIM_AI_GATEWAY_MODELS`, narrowed by the allow-list `PIM_MODELS` when there is one (the default model,
 * `PIM_DEFAULT_MODEL`, always stays), as in v1. An allow-list that cannot be read allows only the default, so a typo never opens every model.
 */
export function offeredModels(env: Env): string[] {
	const gateway = list(env.PIM_AI_GATEWAY_MODELS);
	const given = text(env, "PIM_MODELS");
	if (given === undefined) return gateway;
	const readable = list(given).every((id) => MODEL_ID.test(id));
	const allowed = new Set([...(readable ? list(given) : []), ...(text(env, "PIM_DEFAULT_MODEL") ? [text(env, "PIM_DEFAULT_MODEL")!] : [])]);
	return gateway.filter((id) => allowed.has(id));
}

export function readDeployment(env: Env, origin: string, appsOrigin: string | undefined, adminOpen: boolean | undefined): { settings: DeploymentSettings; variables: DeploymentVariable[] } {
	const variables: DeploymentVariable[] = [];
	function variable<T>(name: string, fallback: T, parse: (value: string) => T, unreadable: T = fallback): T {
		const value = text(env, name) ?? null;
		if (value === null) {
			variables.push({ name, value, problem: null });
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
	const count = (value: string) => {
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("must be a whole number");
		return Number(value);
	};
	const model = (value: string) => {
		if (!MODEL_ID.test(value)) throw new Error(`${JSON.stringify(value)} isn't a model id, such as openai/gpt-5`);
		return value;
	};
	const url = (value: string) => {
		const parsed = URL.parse(value);
		if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) throw new Error("must be a URL, such as https://pim.example.com");
		return parsed.origin;
	};

	// The registration variables are read by `registrationPolicy`, which the account service enforces; this reports what it read.
	const policy = registrationPolicy(env, adminOpen);
	for (const name of ["PIM_REGISTRATION", "PIM_MAX_ACCOUNTS", "PIM_REGISTRATIONS_PER_ADDRESS"]) variables.push({ name, value: text(env, name) ?? null, problem: policy.problems[name] ?? null });
	const approvalPolicy = variable<ApprovalPolicy>("PIM_APPROVAL_POLICY", "majordomo", (value) => {
		if (value !== "majordomo" && value !== "auto" && value !== "explicit") throw new Error("must be one of majordomo, auto, explicit");
		return value;
	});
	const timeZone = variable("PIM_TIME_ZONE", env.TZ?.trim() || "UTC", (value) => {
		if (!validTimeZone(value)) throw new Error("must be an IANA time zone, such as Europe/Lisbon");
		return value;
	});
	const defaultModel = variable("PIM_DEFAULT_MODEL", "", model);
	const allowed = variable<string[]>("PIM_MODELS", [], (value) => list(value).map(model), defaultModel ? [defaultModel] : []);
	variable("PIM_AI_GATEWAY_URL", null as string | null, (value) => (URL.parse(value) ? value : (() => { throw new Error("must be a URL"); })()));
	variable("PIM_AI_GATEWAY_MODELS", [] as string[], (value) => list(value).map(model));
	const utilityModel = variable<string | null>("PIM_UTILITY_MODEL", null, (value) => (value === "off" ? null : model(value)));
	const memoryModel = variable<string | null>("PIM_MEMORY_MODEL", null, model);
	const memoryLines = variable("PIM_MEMORY_LINES", MEMORY_LINES, (value) => {
		const lines = count(value);
		if (lines < 8) throw new Error("must be at least 8");
		return lines;
	});
	const imageModel = variable<string | null>("PIM_IMAGE_MODEL", null, (value) => (value === "off" ? null : model(value)));
	const limits = Object.fromEntries(LIMIT_NAMES.map((name) => [name, variable<number | null>(limitVariable(name), null, count, 0)])) as unknown as Limits;
	const publicUrl = variable<string | null>("PIM_PUBLIC_URL", null, url);
	const contentOrigin = variable<string | null>("PIM_CONTENT_ORIGIN", null, (value) => {
		const content = url(value);
		if (content === (publicUrl ?? origin)) throw new Error("must be another address than PIM_PUBLIC_URL");
		return content;
	});
	const apps = variable<string | null>("PIM_APPS_ORIGIN", null, (value) => {
		const found = url(value);
		if (found === (publicUrl ?? origin) || found === contentOrigin) throw new Error("must be another address than PIM_PUBLIC_URL and PIM_CONTENT_ORIGIN");
		return found;
	});
	// Email is not built: the address is shown so that an operator moving from v1 sees it was read, and Settings shows email as unavailable.
	const emailFrom = variable<string | null>("PIM_EMAIL_FROM", null, (value) => {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("must be an email address, such as pim@example.com");
		return value;
	});
	for (const name of ["PIM_RATE_AUTH", "PIM_RATE_API", "PIM_RATE_PUBLIC"]) variable<number | null>(name, null, count, 0);

	return {
		settings: {
			registration: policy.mode, maxAccounts: policy.maxAccounts, registrationsPerAddress: policy.perAddressPerDay, approvalPolicy, timeZone, model: defaultModel, models: allowed, utilityModel, memoryModel,
			memoryLines, imageModel, limits, publicUrl: publicUrl ?? origin, contentOrigin: contentOrigin ?? appsOrigin ?? null, appsOrigin: apps, emailFrom,
		},
		variables,
	};
}
