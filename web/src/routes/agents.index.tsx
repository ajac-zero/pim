import { createFileRoute, redirect } from "@tanstack/react-router";

/** Older links to agent management now open the home dashboard. */
export const Route = createFileRoute("/agents/")({
  loader: () => {
    throw redirect({ to: "/" });
  },
});
