import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Bot } from "lucide-react";
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
      <div className="mx-auto w-full max-w-4xl px-4 py-8 md:py-12">
        <header className="mb-6 flex items-center gap-3">
          {agent.icon === null ? (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 font-semibold text-lg text-primary">
              {agent.name.slice(0, 1).toUpperCase()}
            </span>
          ) : (
            <AgentIcon agent={agent} className="size-10 rounded-xl" />
          )}
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 font-semibold text-2xl">
              <span className="truncate">{agent.name}</span>
              {agent.default && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-normal text-primary text-xs">
                  {t("defaultAgent")}
                </span>
              )}
            </h1>
            {agent.description && (
              <p className="truncate text-muted-foreground text-sm">
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
          <div className="mt-8 flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
            <Bot className="size-5" />
            {t("noDashboard")}
            <Link
              to="/agents"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {t("yourAgents")}
            </Link>
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
