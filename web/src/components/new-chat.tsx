import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { AgentIcon } from "~/components/agent-icon";
import { Composer } from "~/components/chat/composer";
import { useI18n } from "~/components/i18n";
import { ChevronDown, X } from "~/components/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { Agent } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";

/**
 * New chat, over whatever page is open: a composer for the first message,
 * which makes the chat and opens it in the current tab. It talks with the
 * agent chosen in its footer: the one asked for, or the open chat's agent,
 * or the majordomo. What's typed stays as a draft when it closes.
 */
export function NewChatDialog({
  open,
  agent: asked,
  prompt,
  onOpenChange,
}: {
  open: boolean;
  agent?: string;
  prompt?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const { data: agents } = useQuery(agentsQuery());
  const { data: sessions } = useQuery(sessionsQuery());
  const chatAgent = sessions?.find((session) => session.id === sessionId)?.agent
    ?.id;
  const agent =
    agents?.find((choice) => choice.id === asked) ??
    agents?.find((choice) => choice.id === chatAgent) ??
    agents?.find((choice) => choice.majordomo);
  const { start, starting } = useStartChat(agent?.id);
  const choose = (id: string) =>
    navigate({
      to: ".",
      search: (prev) => ({ ...prev, agent: id }),
      replace: true,
    });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          // Escape in the menu of agents to mention closes that menu, not New chat.
          onEscapeKeyDown={(event) => {
            if (
              event.target instanceof Element &&
              event.target.hasAttribute("aria-controls")
            )
              event.preventDefault();
          }}
          // A sheet along the bottom on phones, within the thumb's reach; near the top, like the command palette, on wider screens.
          className="fixed inset-x-0 bottom-0 z-50 rounded-t-[18px] border-t bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 max-md:data-[state=open]:slide-in-from-bottom-4 md:inset-x-auto md:top-[15vh] md:bottom-auto md:left-1/2 md:w-[calc(100%-2rem)] md:max-w-3xl md:-translate-x-1/2 md:rounded-[18px] md:border md:pb-2 md:data-[state=open]:zoom-in-95"
        >
          <div className="flex items-center justify-between py-1 pr-1 pl-3">
            <Dialog.Title className="flex min-w-0 flex-1 text-[13px] text-muted-foreground">
              {agent ? (
                <AgentPicker
                  agent={agent}
                  others={(agents ?? []).filter(
                    (choice) => choice.id !== agent.id,
                  )}
                  onChoose={choose}
                />
              ) : (
                t("newChat")
              )}
            </Dialog.Title>
            <Dialog.Close
              aria-label={t("close")}
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          {agent && (
            <Composer
              key={prompt ?? ""}
              draftKey={`new-chat:${prompt ?? ""}`}
              initialInput={prompt}
              autoFocus
              onSend={start}
              busy={starting}
              disabled={starting}
              placeholder={t("messageAgent", { name: agent.name })}
              agent={agent}
              uploads
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The header's "New chat with" the agent, opening a menu of your other agents. */
function AgentPicker({
  agent,
  others,
  onChoose,
}: {
  agent: Agent;
  others: Agent[];
  onChoose: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={others.length === 0}
        className="-ml-1.5 flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent"
      >
        <span className="truncate">
          {t("newChatWith", { name: agent.name })}
        </span>
        {others.length > 0 && <ChevronDown className="size-4 shrink-0" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-48 max-w-[calc(100vw-2rem)]"
      >
        {others.map((choice) => (
          <DropdownMenuItem
            key={choice.id}
            onSelect={() => onChoose(choice.id)}
            className="min-h-9 pointer-coarse:min-h-11"
          >
            <AgentIcon agent={choice} tile className="size-6" />
            <span className="truncate">{choice.name}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
