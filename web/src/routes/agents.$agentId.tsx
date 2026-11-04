import { createFileRoute, redirect } from "@tanstack/react-router";

/** Older links to an agent's page now open New chat with it, keeping a message to start from. */
export const Route = createFileRoute("/agents/$agentId")({
  loaderDeps: ({ search }) => ({ prompt: search.prompt }),
  loader: ({ params, deps }) => {
    throw redirect({
      to: "/",
      search: {
        dialog: "new-chat",
        agent: params.agentId,
        prompt: deps.prompt,
      },
      replace: true,
    });
  },
});
