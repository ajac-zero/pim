import { createFileRoute, redirect } from "@tanstack/react-router";

/** Artifacts are in the sidebar now; the old address shows them there, beside the home page. */
export const Route = createFileRoute("/artifacts/")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { panel: "artifacts" }, replace: true });
  },
});
