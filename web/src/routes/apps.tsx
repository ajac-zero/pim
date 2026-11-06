import { createFileRoute, redirect } from "@tanstack/react-router";

/** Connectors is a dialog now; the old address opens it over the home page. */
export const Route = createFileRoute("/apps")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "apps" }, replace: true });
  },
});
