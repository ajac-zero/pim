import { HttpError } from "./http";
import type { PimStore } from "./store";

/**
 * The person's own settings, kept in their agent's database. Each falls back
 * to the deployment's variable, so a self-hosted Pim configured in
 * `wrangler.jsonc` behaves as before until its owner changes something.
 */

/**
 * What a pending approval becomes when nobody answers: `auto` approves it
 * after 30 seconds, so autonomous jobs never block; `explicit` waits longer
 * and then denies it, so nothing acts on the world without a yes.
 */
export type ApprovalPolicy = "auto" | "explicit";

export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["auto", "explicit"];

export type Settings = {
	/** IANA time zone the person lives in. */
	readonly timeZone: string;
	readonly approvalPolicy: ApprovalPolicy;
	/** URL that receives notifications as JSON POSTs, or null. */
	readonly notifyWebhook: string | null;
};

const SETTINGS_KEY = "settings";

export function validTimeZone(zone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: zone });
		return true;
	} catch {
		return false;
	}
}

function defaults(env: Env): Settings {
	const policy: string | undefined = env.PIM_APPROVAL_POLICY;
	return {
		timeZone: env.PIM_TIME_ZONE && validTimeZone(env.PIM_TIME_ZONE) ? env.PIM_TIME_ZONE : "UTC",
		approvalPolicy: policy === "explicit" ? "explicit" : "auto",
		notifyWebhook: env.PIM_NOTIFY_WEBHOOK || null,
	};
}

function stored(store: PimStore): Partial<Settings> {
	const json = store.meta(SETTINGS_KEY);
	return json === undefined ? {} : (JSON.parse(json) as Partial<Settings>);
}

export function readSettings(store: PimStore, env: Env): Settings {
	return { ...defaults(env), ...stored(store) };
}

/**
 * Applies a partial update from the API. `null` for a field goes back to the
 * deployment's default; anything invalid is refused before anything changes.
 */
export function updateSettings(store: PimStore, env: Env, update: Record<string, unknown>): Settings {
	const next: Record<string, unknown> = { ...stored(store) };
	for (const [key, value] of Object.entries(update)) {
		if (value === null) {
			delete next[key];
			continue;
		}
		switch (key) {
			case "timeZone":
				if (typeof value !== "string" || !validTimeZone(value)) throw new HttpError(400, "timeZone must be an IANA time zone, such as Europe/Lisbon");
				break;
			case "approvalPolicy":
				if (!APPROVAL_POLICIES.includes(value as ApprovalPolicy)) throw new HttpError(400, `approvalPolicy must be one of ${APPROVAL_POLICIES.join(", ")}`);
				break;
			case "notifyWebhook":
				if (typeof value !== "string" || !/^https:\/\/[^\s]+$/.test(value) || value.length > 2048) {
					throw new HttpError(400, "notifyWebhook must be an https URL");
				}
				break;
			default:
				throw new HttpError(400, `Unknown setting ${key}`);
		}
		next[key] = value;
	}
	store.setMeta(SETTINGS_KEY, JSON.stringify(next));
	return readSettings(store, env);
}
