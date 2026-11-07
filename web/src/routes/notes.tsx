import { createFileRoute, redirect } from "@tanstack/react-router";

/** Notes are in the Apps dialog; this address opens it over the home page. */
export const Route = createFileRoute("/notes")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "artifacts" }, replace: true });
  },
});
