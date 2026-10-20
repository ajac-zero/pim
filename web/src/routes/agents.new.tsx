import { createFileRoute } from "@tanstack/react-router";
import { NewAgentPage } from "~/components/agent-settings";

/** Making an agent, from + beside the sidebar's Agents. */
export const Route = createFileRoute("/agents/new")({
  component: NewAgentPage,
});
