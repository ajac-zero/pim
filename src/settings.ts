import { HttpError } from "./http";
import type { PimStore } from "./store";

/**
 * The person's own settings, kept in their space's database. Until the person
 * changes them, the approval policy is the one the admin chose for everyone
 * (see ./instance.ts), and the time zone is the Pim's default.
 */

/**
 * Who answers a pending approval, and what it becomes when nobody does:
 * `majordomo` sends other agents' requests to the person's majordomo first,
 * which decides those it is sure about and asks the person about the rest,
 * and waits for the person however long; `auto` approves it after 30
 * seconds, so autonomous jobs never stall; `explicit` waits for the person's
 * answer however long, so nothing acts on the world without their yes.
 */
export type ApprovalPolicy = "majordomo" | "auto" | "explicit";

export const APPROVAL_POLICIES: readonly ApprovalPolicy[] = ["majordomo", "auto", "explicit"];

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

function stored(store: PimStore): Partial<Settings> {
	const json = store.meta(SETTINGS_KEY);
	return json === undefined ? {} : (JSON.parse(json) as Partial<Settings>);
}

/** The person's settings, over `defaults` for those they never set. */
export function readSettings(store: PimStore, defaults: Settings): Settings {
	return { ...defaults, ...stored(store) };
}

/**
 * Applies a partial update from the API. `null` for a field goes back to the
 * default; anything invalid is refused before anything changes.
 */
export function updateSettings(store: PimStore, defaults: Settings, update: Record<string, unknown>): Settings {
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
	return readSettings(store, defaults);
}
