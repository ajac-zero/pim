import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentIcon } from "~/components/agent-icon";
import { Composer } from "~/components/chat/composer";
import { useI18n } from "~/components/i18n";
import { RouteError } from "~/components/route-error";
import { WidgetCard } from "~/components/widgets";
import { dashboardQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";

/**
 * An agent's dashboard: start a chat with it, and the widgets of the
 * blueprint it is based on, each loaded for this agent.
 */
export const Route = createFileRoute("/agents/$agentId")({
  component: DashboardPage,
});

function DashboardPage() {
  const { t, locale } = useI18n();
  const { agentId } = Route.useParams();
  const { data, error, refetch } = useQuery(dashboardQuery(agentId, locale));
  const { start, starting } = useStartChat(agentId);

  if (error) {
    return <RouteError error={error} reset={() => refetch()} />;
  }
  if (!data) return null;
  const { agent, starters, widgets } = data;
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 md:py-12">
        <header className="mb-6 flex flex-col items-center gap-4 text-center">
          <AgentIcon agent={agent} className="size-20" />
          <div className="min-w-0">
            <h1 className="flex items-center justify-center gap-2 font-semibold text-xl">
              <span className="truncate">{agent.name}</span>
              {agent.default && (
                <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-normal text-muted-foreground text-[13px]">
                  {t("defaultAgent")}
                </span>
              )}
            </h1>
            {agent.description && (
              <p className="mt-2 text-muted-foreground text-[15px]">
                {agent.description}
              </p>
            )}
          </div>
        </header>
        <Composer
          onSend={start}
          busy={false}
          disabled={starting}
          placeholder={t("messageAgent", { name: agent.name })}
          promptSuggestions={starters}
          disclaimer={null}
        />
        {widgets.length === 0 ? (
          <div className="mt-8 px-4 py-10 text-center text-muted-foreground text-sm">
            {t("noDashboard")}
          </div>
        ) : (
          <div className="mt-8 grid gap-3 md:grid-cols-2">
            {widgets.map((widget) => (
              <WidgetCard key={widget.id} widget={widget} />
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
