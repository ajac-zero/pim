import { createFileRoute, redirect } from "@tanstack/react-router";

/** Skills are listed in the sidebar; this address shows them there, beside the home page. */
export const Route = createFileRoute("/skills/")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { panel: "skills" }, replace: true });
  },
});
