import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { AgentIcon } from "~/components/agent-icon";
import { AgentSettings, NewAgent } from "~/components/agent-settings";
import { useI18n } from "~/components/i18n";
import { Plus, X } from "~/components/icons";
import type { Agent } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * Your agents, as a dialog over whatever is open, so changing one never
 * leaves the chat: the list down the side, the majordomo first, and the
 * chosen agent's settings beside it. It shows the agent asked for
 * (`?dialog=agents&agent=<id>`, or `agent=new` to make one), or the open
 * chat's agent, or the majordomo.
 */
export function AgentsDialog({
  open,
  agent: asked,
  onOpenChange,
}: {
  open: boolean;
  agent?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const { data: agents } = useQuery(agentsQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const chatAgent = sessions?.find((session) => session.id === sessionId)?.agent
    ?.id;
  const making = asked === "new";
  const agent = making
    ? undefined
    : (agents?.find((choice) => choice.id === asked) ??
      agents?.find((choice) => choice.id === chatAgent) ??
      agents?.find((choice) => choice.majordomo));
  const choose = (id?: string) =>
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, agent: id }),
      replace: true,
    });
  const majordomo = agents?.find((choice) => choice.majordomo);
  const others = agents?.filter((choice) => !choice.majordomo) ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-clip bg-background data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(760px,calc(100dvh-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:flex-row sm:rounded-2xl sm:border sm:shadow-xl"
        >
          {/* On narrow screens the agents scroll sideways above the settings. */}
          <nav
            aria-label={t("agents")}
            className="flex shrink-0 gap-1 overflow-x-auto bg-sidebar p-3 pr-14 sm:w-60 sm:flex-col sm:overflow-y-auto sm:pr-3 sm:scrollbar-thin"
          >
            <div className="contents sm:flex sm:items-center sm:justify-between sm:pt-1 sm:pr-1 sm:pb-3 sm:pl-3">
              <Dialog.Title className="sr-only font-semibold text-xl sm:not-sr-only">
                {t("agents")}
              </Dialog.Title>
              <button
                type="button"
                aria-label={t("newAgent")}
                title={t("newAgent")}
                aria-current={making ? "page" : undefined}
                onClick={() => choose("new")}
                className={cn(
                  "hidden rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground sm:block",
                  making && "bg-sidebar-accent text-foreground",
                )}
              >
                <Plus className="size-4.5" />
              </button>
            </div>
            {majordomo && (
              <AgentChoice
                agent={majordomo}
                selected={agent?.id === majordomo.id}
                onChoose={choose}
              />
            )}
            {others.length > 0 && (
              <div className="mx-3 my-1 hidden h-px shrink-0 bg-border sm:block" />
            )}
            {others.map((choice) => (
              <AgentChoice
                key={choice.id}
                agent={choice}
                selected={agent?.id === choice.id}
                onChoose={choose}
              />
            ))}
            {/* The header's + is out of sight on narrow screens. */}
            <button
              type="button"
              aria-current={making ? "page" : undefined}
              onClick={() => choose("new")}
              className={cn(CHOICE_CLASS, "sm:hidden", making && SELECTED)}
            >
              <Plus className="size-8 shrink-0 rounded-[10px] bg-background p-2 text-muted-foreground" />
              {t("newAgent")}
            </button>
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 scrollbar-thin sm:px-8">
            {making ? (
              <NewAgent onCreated={(created) => choose(created.id)} />
            ) : (
              agent && (
                // Keyed so another agent's settings start afresh.
                <AgentSettings
                  key={agent.id}
                  agent={agent}
                  onDeleted={() => choose(undefined)}
                />
              )
            )}
          </div>
          <Dialog.Close className="absolute top-4 right-4 rounded-md bg-sidebar p-1 text-muted-foreground ring-8 ring-sidebar hover:bg-accent hover:text-foreground sm:bg-transparent sm:ring-0">
            <X className="size-4" />
            <span className="sr-only">{t("close")}</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const CHOICE_CLASS =
  "flex shrink-0 items-center gap-3 rounded-xl px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent";
const SELECTED = "bg-sidebar-accent text-foreground";

/** An agent in the dialog's list, with its icon and name; its role or description below it on wider screens. */
function AgentChoice({
  agent,
  selected,
  onChoose,
}: {
  agent: Agent;
  selected: boolean;
  onChoose: (id: string) => void;
}) {
  const meta =
    agent.role.toLowerCase() === agent.name.toLowerCase()
      ? agent.description
      : agent.role;
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      onClick={() => onChoose(agent.id)}
      className={cn(CHOICE_CLASS, selected && SELECTED)}
    >
      <AgentIcon
        agent={agent}
        tile
        className="size-8 shrink-0 rounded-[10px]"
      />
      <span className="min-w-0 sm:flex-1">
        <span className="block truncate">{agent.name}</span>
        {meta && (
          <span className="hidden truncate text-muted-foreground text-xs sm:block">
            {meta}
          </span>
        )}
      </span>
    </button>
  );
}
