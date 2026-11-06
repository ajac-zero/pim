import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { useNewChat } from "~/components/app-sidebar";
import type { Session } from "~/lib/pim-api";
import { sessionsQuery } from "~/lib/queries";

/**
 * The app opens on the chat last used, so there is no home page to land on:
 * `/` goes to the most recently active chat, keeping any dialog or panel in
 * the URL. A space with no chats stays here, with New chat open over it.
 */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const sessions: Session[] = await context.queryClient.ensureQueryData(
      sessionsQuery(),
    );
    const last = sessions.reduce<Session | undefined>(
      (latest, session) =>
        (session.updatedAt ?? 0) > (latest?.updatedAt ?? -1) ? session : latest,
      undefined,
    );
    if (last) {
      throw redirect({
        to: "/chat/$sessionId",
        params: { sessionId: last.id },
        search: true,
        replace: true,
      });
    }
  },
  component: Home,
});

/** A space with no chats: New chat opens over an empty page, once. */
function Home() {
  const newChat = useNewChat();
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the page opens, so closing New chat leaves it closed.
  useEffect(newChat, []);
  return <main className="min-h-0 min-w-0 flex-1" />;
}
