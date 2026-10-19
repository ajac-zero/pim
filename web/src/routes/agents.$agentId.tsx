import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { AgentIcon, tileClass } from "~/components/agent-icon";
import { ArtifactPreview } from "~/components/artifact";
import { Composer } from "~/components/chat/composer";
import { useI18n } from "~/components/i18n";
import { Bot, ChevronDown, Maximize2, X } from "~/components/icons";
import { RouteError } from "~/components/route-error";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { WidgetCard, WidgetHeader } from "~/components/widgets";
import { type PinnedArtifact, pim } from "~/lib/pim-api";
import { agentsQuery, dashboardQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";
import { cn } from "~/lib/utils";

/**
 * An agent's dashboard: start a chat with it, above what it shows: widgets,
 * each loaded for this agent, and artifacts the agent pinned there, running
 * as their latest version. A pinned artifact's `pim.chat(text)` puts a
 * message about it in the composer, for the person to send.
 */
export const Route = createFileRoute("/agents/$agentId")({
  validateSearch: (search: Record<string, unknown>): { prompt?: string } => ({
    ...(typeof search.prompt === "string" && { prompt: search.prompt }),
  }),
  component: DashboardPage,
});

function DashboardPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { agentId } = Route.useParams();
  const { prompt } = Route.useSearch();
  const { data: agents } = useQuery(agentsQuery());
  const { data, error, refetch } = useQuery(dashboardQuery(agentId, locale));
  const { start, starting } = useStartChat(agentId);
  const queryClient = useQueryClient();

  if (error) {
    return <RouteError error={error} reset={() => refetch()} />;
  }
  if (!data) return null;
  const { agent, starters, widgets } = data;
  const otherAgents = (agents ?? []).filter((choice) => choice.id !== agentId);
  const remove = async (id: string) => {
    try {
      await pim.setDashboard(
        agentId,
        widgets.filter((item) => item.id !== id).map((item) => item.id),
      );
    } catch (failure) {
      toast.error((failure as Error).message);
    }
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const removeButton = (id: string, title: string) => (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 rounded-full text-muted-foreground"
      aria-label={t("dashboardRemove", { title })}
      title={t("dashboardRemove", { title })}
      onClick={() => void remove(id)}
    >
      <X className="size-4" />
    </Button>
  );
  // The message names the artifact, which the composer shows as a chip, so the agent knows what it's about.
  const draft = (pinned: PinnedArtifact) => (text: string) =>
    void navigate({
      to: "/agents/$agentId",
      params: { agentId },
      search: { prompt: `/artifacts/${pinned.artifact.id}\n\n${text}` },
      replace: true,
    });
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {/* Bottom room so the last card scrolls clear of the suggestions floating over it. */}
        <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-20 md:pt-12">
          <header className="mb-6 flex items-center gap-3">
            {agent.icon === null && agent.symbol === null ? (
              <span
                className={cn(
                  "flex size-10 shrink-0 items-center justify-center rounded-xl font-semibold text-lg",
                  tileClass(agent.color),
                )}
              >
                {agent.name.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <AgentIcon agent={agent} tile className="size-10 rounded-xl" />
            )}
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 font-semibold text-2xl">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      disabled={starting || otherAgents.length === 0}
                      className="flex min-h-11 min-w-0 items-center gap-2 rounded-full text-left outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="truncate">{agent.name}</span>
                      {otherAgents.length > 0 && (
                        <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-48 max-w-[calc(100vw-2rem)]"
                  >
                    {otherAgents.map((choice) => (
                      <DropdownMenuItem
                        key={choice.id}
                        onSelect={() => {
                          navigate({
                            to: "/agents/$agentId",
                            params: { agentId: choice.id },
                            search: (prev) => prev,
                          });
                        }}
                        className="min-h-9 pointer-coarse:min-h-11"
                      >
                        <AgentIcon agent={choice} tile className="size-6" />
                        <span className="truncate">{choice.name}</span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                {agent.majordomo && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-normal text-primary text-xs">
                    {t("majordomoBadge")}
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
          {widgets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
              <Bot className="size-5" />
              {t("noDashboard", { name: agent.name })}
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {widgets.map((item) =>
                "artifact" in item ? (
                  // Artifacts take the whole width: a chart or a feed needs it more than a list does.
                  <section
                    key={item.id}
                    className="group flex min-w-0 flex-col rounded-2xl bg-muted px-4 py-4 md:col-span-2"
                    aria-label={item.title}
                  >
                    <WidgetHeader
                      title={item.title}
                      actions={
                        <>
                          <Button
                            asChild
                            variant="ghost"
                            size="icon"
                            className="size-7 rounded-full text-muted-foreground"
                          >
                            <Link
                              to="/artifacts/$artifactId"
                              params={{ artifactId: item.artifact.id }}
                              aria-label={t("dashboardOpen", {
                                title: item.title,
                              })}
                              title={t("dashboardOpen", { title: item.title })}
                            >
                              <Maximize2 className="size-4" />
                            </Link>
                          </Button>
                          {removeButton(item.id, item.title)}
                        </>
                      }
                    />
                    <ArtifactPreview
                      id={item.artifact.id}
                      version={item.artifact.version}
                      kind={item.artifact.kind}
                      title={item.title}
                      maxHeight={480}
                      onDraft={draft(item)}
                    />
                  </section>
                ) : (
                  <WidgetCard
                    key={item.id}
                    widget={item}
                    actions={removeButton(item.id, item.title)}
                  />
                ),
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mr-2.5 flex shrink-0 justify-center px-4 pb-2">
        <div className="w-full max-w-3xl">
          <Composer
            key={`${agentId}:${prompt ?? ""}`}
            draftKey={`new-chat:${prompt ?? ""}`}
            initialInput={prompt}
            autoFocus={Boolean(prompt)}
            onSend={start}
            busy={false}
            disabled={starting}
            placeholder={t("messageAgent", { name: agent.name })}
            promptSuggestions={starters}
          />
        </div>
      </div>
    </main>
  );
}
