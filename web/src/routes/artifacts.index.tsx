import { createFileRoute, redirect } from "@tanstack/react-router";

/** Apps are a dialog now; the old address opens it over the home page. */
export const Route = createFileRoute("/artifacts/")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "artifacts" }, replace: true });
  },
});
