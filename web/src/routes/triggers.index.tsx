import { createFileRoute } from "@tanstack/react-router";
import { TriggersPage } from "~/components/triggers";

/** Every trigger of the space; where its triggers are off, a line saying so. */
export const Route = createFileRoute("/triggers/")({
  component: TriggersPage,
});
