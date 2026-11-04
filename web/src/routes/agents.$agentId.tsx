import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AgentIcon, tileClass } from "~/components/agent-icon";
import { Composer } from "~/components/chat/composer";
import { ChatTabs } from "~/components/chat/tabs";
import { Thread } from "~/components/chat/thread";
import { useI18n } from "~/components/i18n";
import { ChevronDown } from "~/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { UserContent } from "~/lib/pim-api";
import { EMPTY_STREAM } from "~/lib/pim-view";
import { agentsQuery, suggestionsQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";
import { useTabs } from "~/lib/tabs";
import { cn } from "~/lib/utils";

/** Starts a chat with an agent: its first message, written here, makes the chat. */
export const Route = createFileRoute("/agents/$agentId")({
  validateSearch: (search: Record<string, unknown>): { prompt?: string } => ({
    ...(typeof search.prompt === "string" && { prompt: search.prompt }),
  }),
  component: NewChatPage,
});

function NewChatPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const { agentId } = Route.useParams();
  const { prompt } = Route.useSearch();
  const { data: agents } = useQuery(agentsQuery());
  const { data: suggestions } = useQuery(suggestionsQuery(agentId, locale));
  const { start, sent } = useStartChat(agentId);
  const shelf = useTabs().length > 0;

  // The header and composer show as soon as the agent is known, from the agents the sidebar already has; suggestions follow when written.
  const agent = agents?.find((choice) => choice.id === agentId);
  if (!agent) return null;
  const otherAgents = (agents ?? []).filter((choice) => choice.id !== agentId);
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col">
      {(shelf || sent !== null) && (
        <header
          className={cn(
            "hidden h-13 shrink-0 pr-4 md:flex",
            shelf && "bg-sidebar",
          )}
        >
          <ChatTabs activeId="" />
        </header>
      )}
      {sent !== null && <StartingChat content={sent} />}
      {/* Kept while the chat starts, in case it can't. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto scrollbar-thin",
          sent !== null && "hidden",
        )}
      >
        <div className="mx-auto w-full max-w-4xl px-4 pt-8 pb-24 md:pt-12">
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
                      disabled={otherAgents.length === 0}
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
              </h1>
              {agent.description && (
                <p className="truncate text-muted-foreground text-sm">
                  {agent.description}
                </p>
              )}
            </div>
          </header>
        </div>
      </div>
      <div className="flex shrink-0 justify-center pb-2">
        <div className="w-full max-w-4xl px-4">
          <Composer
            key={`${agentId}:${prompt ?? ""}`}
            draftKey={`new-chat:${prompt ?? ""}`}
            initialInput={prompt}
            autoFocus={Boolean(prompt)}
            onSend={start}
            busy={sent !== null}
            disabled={sent !== null}
            placeholder={t("messageAgent", { name: agent.name })}
            promptSuggestions={suggestions}
            agent={agent}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * A chat Pim is still making, showing its first message where the chat's
 * page will, so the message shows the moment it is sent. The chat's page
 * takes its place once the chat exists, adding the chat's tab to the open
 * ones shown here.
 */
function StartingChat({ content }: { content: UserContent }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Thread
        sessionId=""
        synced={false}
        view={EMPTY_STREAM.view}
        pending={content}
        composerHeight={0}
      />
    </div>
  );
}
