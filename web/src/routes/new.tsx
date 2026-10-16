import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AgentIcon, PimMark } from "~/components/agent-icon";
import { Composer } from "~/components/chat/composer";
import { useI18n } from "~/components/i18n";
import { agentsQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";

/** An empty draft chat, with your default agent or another of yours. No session exists until the first message is sent. */
export const Route = createFileRoute("/new")({
  validateSearch: (search: Record<string, unknown>): { agent?: string } =>
    typeof search.agent === "string" ? { agent: search.agent } : {},
  component: NewChatPage,
});

function NewChatPage() {
  const { t } = useI18n();
  const { agent: agentId } = Route.useSearch();
  const { data: agents } = useQuery(agentsQuery());
  const agent = agents?.find((candidate) =>
    agentId === undefined ? candidate.default : candidate.id === agentId,
  );
  const { start, starting } = useStartChat(agent?.id);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-3xl">
        <div className="mb-5 flex justify-center">
          {agent ? (
            <AgentIcon agent={agent} className="size-18" />
          ) : (
            <PimMark className="size-18" />
          )}
        </div>
        <h1 className="mb-2 text-center font-semibold text-xl">
          {agent ? t("startChatWith", { name: agent.name }) : t("startNewChat")}
        </h1>
        <p className="mb-6 text-center text-muted-foreground text-[15px]">
          {t("emptyChatHint")}
        </p>
        <Composer
          onSend={start}
          busy={false}
          disabled={starting || (agentId !== undefined && !agents)}
          placeholder={
            agent ? t("messageAgent", { name: agent.name }) : undefined
          }
          autoFocus
        />
      </div>
    </main>
  );
}
