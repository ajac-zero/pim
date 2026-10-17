import { createFileRoute, redirect } from "@tanstack/react-router";

/** Discover is a dialog now; the old address opens it over the home page. */
export const Route = createFileRoute("/discover")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "discover" }, replace: true });
  },
});
