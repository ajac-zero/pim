import { createFileRoute, redirect } from "@tanstack/react-router";

/** Schedules are in the sidebar now; the old address shows them there, beside the home page. */
export const Route = createFileRoute("/schedules")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { panel: "schedules" }, replace: true });
  },
});
