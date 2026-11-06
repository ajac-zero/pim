import { createFileRoute, redirect } from "@tanstack/react-router";

/** Older links to making an agent now open Agents, ready to make one. */
export const Route = createFileRoute("/agents/new")({
  loader: () => {
    throw redirect({
      to: "/",
      search: { dialog: "agents", agent: "new" },
      replace: true,
    });
  },
});
