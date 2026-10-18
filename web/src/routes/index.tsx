import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentsQuery } from "~/lib/queries";

/**
 * Opens the majordomo's dashboard, keeping the search and fragment: an
 * open dialog (`?dialog=settings`) and a sign-in error (`#auth-error=…`).
 */
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const agents = await context.queryClient.fetchQuery(agentsQuery());
    // Pim makes the majordomo the first time its agents are listed.
    const majordomo = agents.find((agent) => agent.majordomo);
    if (majordomo === undefined) throw new Error("No majordomo");
    throw redirect({
      to: "/agents/$agentId",
      params: { agentId: majordomo.id },
      search: true,
      hash: true,
    });
  },
});
