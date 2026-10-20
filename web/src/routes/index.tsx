import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentsQuery } from "~/lib/queries";

/**
 * Opens the majordomo's dashboard, keeping the search and fragment: an
 * open dialog (`?dialog=settings`) and a sign-in error (`#auth-error=…`).
 */
export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): { prompt?: string } => ({
    ...(typeof search.prompt === "string" && { prompt: search.prompt }),
  }),
  loader: async ({ context }) => {
    // The agents already loaded will do: the majordomo stays the same one.
    const agents = await context.queryClient.ensureQueryData(agentsQuery());
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
