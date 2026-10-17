import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentsQuery } from "~/lib/queries";

/**
 * Opens the majordomo's dashboard, keeping the search and fragment: an
 * open dialog (`?dialog=settings`) and a sign-in error (`#auth-error=…`).
 */
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const agents = await context.queryClient.fetchQuery(agentsQuery());
    const agent = agents.find((agent) => agent.majordomo) ?? agents[0];
    if (agent === undefined)
      throw redirect({ to: "/new", search: true, hash: true });
    throw redirect({
      to: "/agents/$agentId",
      params: { agentId: agent.id },
      search: true,
      hash: true,
    });
  },
});
