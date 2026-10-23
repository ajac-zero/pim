import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { ThinkingDot } from "~/components/chat/items";
import { useI18n } from "~/components/i18n";
import { X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { type Agent, pim } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery } from "~/lib/queries";

/**
 * Group chats (see src/rooms.ts): a chat another of the person's agents was
 * brought into by an @mention. Each agent's messages say who wrote them, the
 * header lists who is in the chat, and the transcript shows who is at work.
 */

/** Who wrote an agent's message in a group chat: its icon and name, above the message. */
export function Speaker({ name, agent }: { name: string; agent?: Agent }) {
  return (
    <div className="mb-1.5 flex min-w-0 items-center gap-2 text-muted-foreground text-[13px]">
      {agent && (
        <AgentIcon agent={agent} tile className="size-5 shrink-0 rounded-md" />
      )}
      <span className="truncate">{name}</span>
    </div>
  );
}

/** The agents of a group chat other than its host that are at work in it now. */
export function MembersWorking({
  members,
  agents,
}: {
  members: readonly { id: string; name: string }[];
  agents: readonly Agent[] | undefined;
}) {
  const { t } = useI18n();
  return members.map((member) => {
    const agent = agents?.find((candidate) => candidate.id === member.id);
    return (
      <div
        key={member.id}
        data-thinking
        className="flex items-center gap-2 text-muted-foreground text-[13px]"
      >
        {agent && (
          <AgentIcon
            agent={agent}
            tile
            className="size-5 shrink-0 rounded-md"
          />
        )}
        <span className="truncate">
          {t("agentWorking", { name: member.name })}
        </span>
        <ThinkingDot />
      </div>
    );
  });
}

/**
 * Who is in a group chat, as their icons in the header. Each agent but the
 * host can be taken out of the chat from here. Nothing for a chat with one
 * agent.
 */
export function RoomMenu({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const remove = useMutation({
    mutationFn: (agent: string) => pim.removeFromRoom(sessionId, agent),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (failure) => toast.error(failure.message),
  });
  const room = session?.room;
  if (!session?.agent || !room || room.members.length === 0) return null;
  const host = session.agent;
  const people = [
    { id: host.id, name: host.name, host: true },
    ...room.members.map((member) => ({ ...member, host: false })),
  ];
  const look = (id: string) => agents?.find((agent) => agent.id === id);
  const label = t("inThisChat");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="h-8 shrink-0 gap-0 self-center rounded-full px-1.5"
          aria-label={`${label}: ${people.map((person) => person.name).join(", ")}`}
          title={label}
        >
          {people.slice(0, 4).map((person, index) => {
            const agent = look(person.id);
            return agent ? (
              <span
                key={person.id}
                className={
                  index > 0
                    ? "-ml-1.5 rounded-md bg-background ring-2 ring-background"
                    : "rounded-md bg-background ring-2 ring-background"
                }
              >
                {/* Too small here for the majordomo's crown. */}
                <AgentIcon
                  agent={{ ...agent, majordomo: false }}
                  tile
                  className="size-5 rounded-md"
                />
              </span>
            ) : null;
          })}
          {people.length > 4 && (
            <span className="ml-1 text-muted-foreground text-xs">
              +{people.length - 4}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
          {label}
        </DropdownMenuLabel>
        {people.map((person) => {
          const agent = look(person.id);
          return (
            <div
              key={person.id}
              className="flex items-center gap-2 px-2 py-1.5 text-sm"
            >
              {agent && (
                <AgentIcon
                  agent={agent}
                  tile
                  className="size-5 shrink-0 rounded-md"
                />
              )}
              <span className="min-w-0 flex-1 truncate">{person.name}</span>
              {person.host ? (
                <span className="text-muted-foreground text-xs">
                  {t("roomHost")}
                </span>
              ) : (
                <button
                  type="button"
                  className="-my-1 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  aria-label={t("removeFromChat", { name: person.name })}
                  title={t("removeFromChat", { name: person.name })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(person.id)}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
