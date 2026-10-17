import { createFileRoute, redirect } from "@tanstack/react-router";

/** Sharing is a dialog now; the old address opens it over the home page. */
export const Route = createFileRoute("/sharing")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "sharing" }, replace: true });
  },
});
