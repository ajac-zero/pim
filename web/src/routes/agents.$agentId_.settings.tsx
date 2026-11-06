import { createFileRoute, redirect } from "@tanstack/react-router";

/** Older links to an agent's settings page now open them in Agents. */
export const Route = createFileRoute("/agents/$agentId_/settings")({
  loader: ({ params }) => {
    throw redirect({
      to: "/",
      search: { dialog: "agents", agent: params.agentId },
      replace: true,
    });
  },
});
