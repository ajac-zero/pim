import { createFileRoute, redirect } from "@tanstack/react-router";
import { agentsQuery } from "~/lib/queries";

/** Opens the default agent's dashboard. */
export const Route = createFileRoute("/")({
  loader: async ({ context }) => {
    const agents = await context.queryClient.fetchQuery(agentsQuery());
    const agent = agents.find((agent) => agent.default) ?? agents[0];
    if (agent === undefined) throw redirect({ to: "/new" });
    throw redirect({ to: "/agents/$agentId", params: { agentId: agent.id } });
  },
});
