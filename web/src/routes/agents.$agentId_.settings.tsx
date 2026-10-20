import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentSettingsPage } from "~/components/agent-settings";
import { useI18n } from "~/components/i18n";
import { RouteError } from "~/components/route-error";
import { agentsQuery } from "~/lib/queries";

/** An agent's settings, opened from the sidebar's Agents. */
export const Route = createFileRoute("/agents/$agentId_/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const { t } = useI18n();
  const { agentId } = Route.useParams();
  const { data: agents, error, refetch } = useQuery(agentsQuery());
  if (error) return <RouteError error={error} reset={() => refetch()} />;
  if (!agents) return null;
  const agent = agents.find((choice) => choice.id === agentId);
  if (!agent) {
    return (
      <main className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        {t("agentNotFound")}
      </main>
    );
  }
  // Keyed so another agent's page starts afresh.
  return <AgentSettingsPage key={agent.id} agent={agent} />;
}
