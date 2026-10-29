import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AgentIcon } from "~/components/agent-icon";
import { ThinkingDot } from "~/components/chat/items";
import {
  ModelMark,
  ModelMenuItems,
  useAgentModel,
} from "~/components/chat/model-menu";
import { useI18n } from "~/components/i18n";
import { Lock, X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { type Agent, pim } from "~/lib/pim-api";
import { agentsQuery, sessionsQuery } from "~/lib/queries";

/**
 * Group chats (see src/rooms.ts): every chat is a room, with its host and any
 * other of the person's agents brought in by an @mention or from the header.
 * Each agent's messages say who wrote them, the
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

/** The agents of a group chat that are at work in it now, each with its icon. */
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
 * Who is in a chat, as their icons in the header. Each agent but the host
 * can be taken out of the chat from here, and any other agent brought in.
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
  const add = useMutation({
    mutationFn: (agent: string) => pim.addToRoom(sessionId, agent),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
    onError: (failure) => toast.error(failure.message),
  });
  const room = session?.room;
  if (!session?.agent || !room) return null;
  const host = session.agent;
  const people = [
    { id: host.id, name: host.name, host: true },
    ...room.members.map((member) => ({ ...member, host: false })),
  ];
  const absent = (agents ?? []).filter(
    (agent) => !people.some((person) => person.id === agent.id),
  );
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
        {people.map((person) => (
          <Person
            key={person.id}
            person={person}
            agent={look(person.id)}
            removing={remove.isPending}
            onRemove={() => remove.mutate(person.id)}
          />
        ))}
        {absent.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {t("addToChat")}
            </DropdownMenuLabel>
            {absent.map((agent) => (
              <DropdownMenuItem
                key={agent.id}
                disabled={add.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  add.mutate(agent.id);
                }}
              >
                <AgentIcon
                  agent={agent}
                  tile
                  className="size-5 shrink-0 rounded-md"
                />
                <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * One agent in the chat: its icon and name, and the model it runs on, which
 * opens a list to choose another for it. Any but the host can be taken out.
 */
function Person({
  person,
  agent,
  removing,
  onRemove,
}: {
  person: { id: string; name: string; host: boolean };
  agent: Agent | undefined;
  removing: boolean;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { settings, current, pinned, choose } = useAgentModel(person.id);
  return (
    <div className="flex items-center gap-2 px-1">
      <DropdownMenuSub>
        {/* The model is the button: its list opens to the left, where there is room, so it has no arrow. */}
        <DropdownMenuSubTrigger
          chevron={false}
          className="size-8 shrink-0 justify-center p-0"
          aria-label={t("chooseModel", { model: current?.name ?? "" })}
        >
          {settings && current && (
            <ModelMark
              settings={settings}
              model={current}
              className="size-4 text-muted-foreground"
            />
          )}
        </DropdownMenuSubTrigger>
        {/* Radix can't be told a side, so the right edge is made too crowded to open on: the list opens left of the menu and doesn't cover the rest of the row. */}
        {settings && current && (
          <DropdownMenuSubContent
            collisionPadding={{ right: 1000 }}
            className="w-72 max-w-[calc(100vw-2rem)]"
          >
            <DropdownMenuLabel className="font-normal text-muted-foreground text-xs">
              {t("modelForAgent", { name: person.name })}
            </DropdownMenuLabel>
            <ModelMenuItems
              settings={settings}
              current={current}
              pinned={pinned}
              choose={choose.mutate}
            />
          </DropdownMenuSubContent>
        )}
      </DropdownMenuSub>
      {agent && (
        <AgentIcon agent={agent} tile className="size-5 shrink-0 rounded-md" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{person.name}</span>
      {/* Both end in a box of the same size, so the models line up. */}
      {person.host ? (
        <span
          className="mr-1 p-1 text-muted-foreground"
          role="img"
          aria-label={t("roomHost")}
          title={t("roomHost")}
        >
          <Lock className="size-3.5" />
        </span>
      ) : (
        <button
          type="button"
          className="mr-1 rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          aria-label={t("removeFromChat", { name: person.name })}
          title={t("removeFromChat", { name: person.name })}
          disabled={removing}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
}
