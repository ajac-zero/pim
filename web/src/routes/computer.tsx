import { createFileRoute, redirect } from "@tanstack/react-router";

/** The Computer page that was: its address opens the computer's dialog now. */
export const Route = createFileRoute("/computer")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { dialog: "computer" } });
  },
});
