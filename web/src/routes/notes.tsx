import { createFileRoute, redirect } from "@tanstack/react-router";

/** Notes are in the sidebar; this address shows them there, beside the home page. */
export const Route = createFileRoute("/notes")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { panel: "notes" }, replace: true });
  },
});
