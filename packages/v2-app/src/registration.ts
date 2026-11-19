/**
 * Who may join this Pim and under which names: the username rules, and the deployment's registration policy that
 * `PIM_REGISTRATION`, `PIM_MAX_ACCOUNTS` and `PIM_REGISTRATIONS_PER_ADDRESS` set, as v1 read them. An account that no passkey was
 * made for lapses after `PENDING_MS`, and gives its username, its invite and its place under the cap back.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;
export const PENDING_MS = 24 * 3600_000;

/** Letters, digits and single hyphens between them. Two hyphens in a row would be for the platform's own names, and rule out `xn--` lookalikes. */
const USERNAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/** Names the service or its operators might need, and names that look official. */
const RESERVED = new Set(
	`about abuse account accounts admin administrator api app apps assets auth billing blog callback cdn console contact dashboard
	dev dns docs download email events ftp help hostmaster imap internal legal login logout mail mcp me news noreply no-reply ns1 ns2
	oauth official owner pim pimling pimlings postmaster preview pricing privacy register root security settings signin signout signup
	smtp staff staging static status support system team terms test user users webmaster www`.split(/\s+/),
);

/** Why `name` can't be a username on a new account, or null when it can. Names already taken stay as they are. */
export function usernameProblem(name: string): string | null {
	if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return `A username has ${USERNAME_MIN} to ${USERNAME_MAX} characters.`;
	if (!USERNAME.test(name)) return "A username has lowercase letters, digits, and single hyphens between them.";
	if (RESERVED.has(name)) return "That username is reserved.";
	return null;
}

export type RegistrationMode = "invite" | "open" | "closed";
export type RegistrationPolicy = {
	mode: RegistrationMode;
	/** Whether `PIM_REGISTRATION` sets the mode: then the admin's switch (`instance_settings.registration_open`) does not. */
	fixed: boolean;
	maxAccounts: number | null;
	perAddressPerDay: number;
	/** What could not be read, by variable. A cap that cannot be read counts as 0, so a typo never lifts it. */
	problems: Record<string, string>;
};

type Env = Readonly<Record<string, string | undefined>>;
const text = (env: Env, name: string) => env[name]?.trim() || undefined;

/** The deployment's policy: the variables first, the admin's switch for the mode when `PIM_REGISTRATION` is not set. */
export function registrationPolicy(env: Env, adminOpen?: boolean): RegistrationPolicy {
	const problems: Record<string, string> = {};
	const count = (name: string, fallback: number | null, unreadable: number): number | null => {
		const value = text(env, name);
		if (value === undefined) return fallback;
		if (/^\d+$/.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
		problems[name] = `${name} must be a whole number`;
		return unreadable;
	};
	const given = text(env, "PIM_REGISTRATION");
	let mode: RegistrationMode = adminOpen ? "open" : "invite";
	if (given !== undefined) {
		if (given === "invite" || given === "open" || given === "closed") mode = given;
		else problems.PIM_REGISTRATION = "PIM_REGISTRATION must be one of invite, open, closed";
	}
	return { mode, fixed: given === "invite" || given === "open" || given === "closed", maxAccounts: count("PIM_MAX_ACCOUNTS", null, 0), perAddressPerDay: count("PIM_REGISTRATIONS_PER_ADDRESS", 3, 0) ?? 3, problems };
}
