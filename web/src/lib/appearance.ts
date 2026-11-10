import type { QueryClient } from "@tanstack/react-query";
import { authSessionQuery } from "~/lib/auth";
import { pim } from "~/lib/pim-api";
import { settingsQuery } from "~/lib/queries";

/** The person's signed-in state and settings, once loaded: what the look of the app follows. */
export function appearanceQueries(signedIn: boolean) {
  return { ...settingsQuery(), enabled: signedIn };
}

export const signedInQuery = () => ({
  ...authSessionQuery(),
  select: (session: { signedIn: boolean }) => session.signedIn,
});

/**
 * Keeps a change of the app's look in the person's settings, so it follows
 * them to their other devices and agents can see it. This browser already
 * shows it; a failure to save leaves it that way.
 */
export function saveAppearance(
  queryClient: QueryClient,
  update: Parameters<typeof pim.updateSettings>[0],
) {
  if (!queryClient.getQueryData(authSessionQuery().queryKey)?.signedIn) return;
  pim.updateSettings(update).then(
    (next) => queryClient.setQueryData(settingsQuery().queryKey, next),
    (error) => console.error(error),
  );
}
