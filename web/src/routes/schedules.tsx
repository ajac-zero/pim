import { createFileRoute, redirect } from "@tanstack/react-router";

/** Schedules are among the triggers now, those that moved and those that haven't; the old address shows them there. */
export const Route = createFileRoute("/schedules")({
  beforeLoad: () => {
    throw redirect({ to: "/triggers", replace: true });
  },
});
