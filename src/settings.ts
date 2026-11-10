import { HttpError } from "./http";
import type { PimStore } from "./store";
import { LOCALES, type Locale } from "./locales";

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

/**
 * Which messages alert the person's devices: `important` ones only, which are
 * an agent mentioning them, an approval waiting for them, and an answer to
 * what they asked when they have left the chat; or `all`, every message an
 * agent sends them while they aren't looking, including its progress.
 */
export type DeviceAlerts = "important" | "all";

export const DEVICE_ALERTS: readonly DeviceAlerts[] = ["important", "all"];

/** Light, dark, or following the device. */
export type ColorMode = "light" | "dark" | "system";

export const COLOR_MODES: readonly ColorMode[] = ["light", "dark", "system"];

export type Settings = {
	/** IANA time zone the person lives in. */
	readonly timeZone: string;
	readonly approvalPolicy: ApprovalPolicy;
	readonly deviceAlerts: DeviceAlerts;
	/** How the app looks, on every device. Unset: each browser keeps its own choice, and then the system's mode, the deployment's default theme and the browser's language. */
	readonly colorMode?: ColorMode;
	/** The id of one of the deployment's themes (src/themes.ts). */
	readonly colorTheme?: string;
	readonly locale?: Locale;
};

/** The settings that have no default: unset until the person sets them. */
const OPTIONAL_SETTINGS = ["colorMode", "colorTheme", "locale"];

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

/** The person's settings, over `defaults` for those they never set. A setting Pim no longer has is ignored. */
export function readSettings(store: PimStore, defaults: Settings): Settings {
	const own = Object.entries(stored(store)).filter(([key]) => key in defaults || OPTIONAL_SETTINGS.includes(key));
	return { ...defaults, ...Object.fromEntries(own) };
}

/**
 * Applies a partial update from the API. `null` for a field goes back to the
 * default; anything invalid is refused before anything changes.
 */
export function updateSettings(store: PimStore, defaults: Settings, update: Record<string, unknown>, themeIds: readonly string[]): Settings {
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
			case "deviceAlerts":
				if (!DEVICE_ALERTS.includes(value as DeviceAlerts)) throw new HttpError(400, `deviceAlerts must be one of ${DEVICE_ALERTS.join(", ")}`);
				break;
			case "colorMode":
				if (!COLOR_MODES.includes(value as ColorMode)) throw new HttpError(400, `colorMode must be one of ${COLOR_MODES.join(", ")}`);
				break;
			case "colorTheme":
				if (typeof value !== "string" || !themeIds.includes(value)) throw new HttpError(400, `colorTheme must be one of ${themeIds.join(", ")}`);
				break;
			case "locale":
				if (!LOCALES.includes(value as Locale)) throw new HttpError(400, `locale must be one of ${LOCALES.join(", ")}`);
				break;
			default:
				throw new HttpError(400, `Unknown setting ${key}`);
		}
		next[key] = value;
	}
	store.setMeta(SETTINGS_KEY, JSON.stringify(next));
	return readSettings(store, defaults);
}
