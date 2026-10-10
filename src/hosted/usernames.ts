/**
 * Usernames name a person's Pimling, as `<username>.<domain>`. They are one
 * DNS label, lowercase, and never reused: a username's hostname is where its
 * owner's apps send sign-ins and events.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

/**
 * Letters, digits and single hyphens between them. Two hyphens in a row are
 * kept for the platform's own names (and rule out `xn--` punycode lookalikes).
 */
const USERNAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;

/** Names the service or its operators might need, and names that look official. */
const RESERVED = new Set(
	`about abuse account accounts admin administrator api app apps assets auth billing blog callback cdn console contact dashboard
	dev dns docs download email events ftp help hostmaster imap internal legal login logout mail mcp me news noreply no-reply ns1 ns2
	oauth official owner pim pimling pimlings postmaster preview pricing privacy register root security settings signin signout signup
	smtp staff staging static status support system team terms test user users webmaster www`.split(/\s+/),
);

/** Why `name` can't be a username, or null when it can. */
export function usernameProblem(name: string): string | null {
	if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) {
		return `A username has ${USERNAME_MIN} to ${USERNAME_MAX} characters.`;
	}
	if (!USERNAME.test(name)) {
		return "A username has lowercase letters, digits, and single hyphens between them.";
	}
	if (RESERVED.has(name)) return "That username is reserved.";
	return null;
}
