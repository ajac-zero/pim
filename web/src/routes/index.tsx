import { createFileRoute, redirect } from "@tanstack/react-router";
import { sessionsQuery } from "~/lib/queries";

/** Opens the most recent conversation, or opens an empty draft. */
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const sessions = await context.queryClient.fetchQuery(sessionsQuery());
    const sessionId = sessions[0]?.id;
    if (sessionId === undefined) throw redirect({ to: "/new" });
    throw redirect({ to: "/chat/$sessionId", params: { sessionId } });
  },
});
