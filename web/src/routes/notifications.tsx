import { createFileRoute, redirect } from "@tanstack/react-router";

/** Notifications are in the sidebar now; the old address shows them there, beside the home page. */
export const Route = createFileRoute("/notifications")({
  beforeLoad: () => {
    throw redirect({
      to: "/",
      search: { panel: "notifications" },
      replace: true,
    });
  },
});
