import { createFileRoute, redirect } from "@tanstack/react-router";

/** Settings is a dialog now; the old address opens it over the home page. */
export const Route = createFileRoute("/settings")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "settings" }, replace: true });
  },
});
