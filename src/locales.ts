/**
 * The languages the web app is translated into (web/src/components/i18n.tsx).
 * The web app imports this module too, so it imports nothing of the server's.
 */
export const LOCALES = ["en", "es"] as const;

export type Locale = (typeof LOCALES)[number];
