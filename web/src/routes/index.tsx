import { createFileRoute, redirect } from "@tanstack/react-router";
import { pim } from "~/lib/pim-api";
import { sessionsQuery } from "~/lib/queries";

/** Opens the most recent conversation, or starts the first one. */
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const sessions = await context.queryClient.fetchQuery(sessionsQuery());
    let sessionId = sessions[0]?.id;
    if (sessionId === undefined) {
      sessionId = (await pim.createSession()).id;
      context.queryClient.invalidateQueries({ queryKey: ["sessions"] });
    }
    throw redirect({ to: "/chat/$sessionId", params: { sessionId } });
  },
});
