import { createFileRoute } from "@tanstack/react-router";
import { CodingPage } from "~/components/coding";

/** The space's coding threads, with the form to start one. */
export const Route = createFileRoute("/coding/")({
  component: CodingPage,
});
