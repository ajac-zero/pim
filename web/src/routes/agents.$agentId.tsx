import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { AgentIcon, tileClass } from "~/components/agent-icon";
import { ArtifactFrame, ArtifactIcon } from "~/components/artifact";
import { Composer } from "~/components/chat/composer";
import { ChatTabs } from "~/components/chat/tabs";
import { Thread } from "~/components/chat/thread";
import { useI18n } from "~/components/i18n";
import { Bot, ChevronDown, MoreHorizontal, X } from "~/components/icons";
import { RouteError } from "~/components/route-error";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { WidgetCard } from "~/components/widgets";
import {
  type PinnedArtifact,
  pim,
  type UserContent,
  WIDGET_SIZES,
  type WidgetSize,
} from "~/lib/pim-api";
import { EMPTY_STREAM } from "~/lib/pim-view";
import { agentsQuery, dashboardQuery } from "~/lib/queries";
import { useStartChat } from "~/lib/start-chat";
import { useTabs } from "~/lib/tabs";
import { cn } from "~/lib/utils";

/**
 * An agent's dashboard: start a chat with it, above what it shows: widgets,
 * each loaded for this agent, and artifacts the agent pinned there, each as
 * the widget of its latest version. A pinned artifact's `pim.chat(text)` puts
 * a message about it in the composer, for the person to send.
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
  const { start, sent } = useStartChat(agentId);
  const queryClient = useQueryClient();

  if (error) {
    return <RouteError error={error} reset={() => refetch()} />;
  }
  // The header and composer show as soon as the agent is known, from the
  // agents the sidebar already has; widgets and starters follow when loaded.
  const agent = data?.agent ?? agents?.find((choice) => choice.id === agentId);
  if (!agent) return null;
  const widgets = data?.widgets ?? [];
  const otherAgents = (agents ?? []).filter((choice) => choice.id !== agentId);
  const change = async (
    items: string[],
    sizes: Record<string, WidgetSize> = {},
  ) => {
    try {
      await pim.setDashboard(agentId, items, sizes);
    } catch (failure) {
      toast.error((failure as Error).message);
    }
    await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };
  const remove = (id: string) =>
    change(widgets.filter((item) => item.id !== id).map((item) => item.id));
  const resize = (id: string, size: WidgetSize) =>
    change(
      widgets.map((item) => item.id),
      { [id]: size },
    );
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
      {sent !== null && <StartingChat content={sent} />}
      {/* Kept while the chat starts, in case it can't. */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto scrollbar-thin",
          sent !== null && "hidden",
        )}
      >
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
          {!data ? null : widgets.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
              <Bot className="size-5" />
              {t("noDashboard", { name: agent.name })}
            </div>
          ) : (
            // Two columns on phones and four from a wide enough dashboard, as a phone's home screen
            // has: `--cell` is a column's width, which a small widget's tile is as tall as.
            <div className="@container">
              <div className="grid grid-flow-row-dense grid-cols-2 gap-3 [--cell:calc((100cqw-0.75rem)/2)] @2xl:grid-cols-4 @2xl:[--cell:calc((100cqw-2.25rem)/4)]">
                {widgets.map((item) =>
                  "artifact" in item ? (
                    <PinnedWidget
                      key={item.id}
                      pinned={item}
                      actions={
                        <>
                          <SizeMenu
                            title={item.title}
                            size={item.size}
                            onChange={(size) => void resize(item.id, size)}
                          />
                          {removeButton(item.id, item.title)}
                        </>
                      }
                      onDraft={draft(item)}
                    />
                  ) : (
                    <WidgetCard
                      key={item.id}
                      widget={item}
                      className="col-span-2"
                      actions={removeButton(item.id, item.title)}
                    />
                  ),
                )}
              </div>
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
            busy={sent !== null}
            disabled={sent !== null}
            placeholder={t("messageAgent", { name: agent.name })}
            promptSuggestions={data?.starters}
          />
        </div>
      </div>
    </main>
  );
}

/**
 * Where each size of widget goes in the grid, and how tall its tile is: a
 * small one a square cell, a medium one two cells wide, and a large one two
 * cells wide and two rows tall, as tall as two small ones with their titles
 * (1.75rem, with 0.375rem above) and the gap between them.
 */
const SIZE_CLASSES: Record<WidgetSize, { cell: string; tile: string }> = {
  small: { cell: "col-span-1", tile: "h-(--cell)" },
  medium: { cell: "col-span-2", tile: "h-(--cell)" },
  large: {
    cell: "col-span-2 row-span-2",
    tile: "h-[calc(2*var(--cell)+2.875rem)]",
  },
};

/**
 * A pinned artifact, as a phone's home screen shows an app: its widget, a
 * small view that runs live in a tile of the size it's pinned at, with its
 * title under it, and the whole artifact a tap away, from the title or the widget's
 * `pim.open()`. One without a widget, pinned before artifacts had them, is a
 * tile that opens it.
 */
function PinnedWidget({
  pinned,
  actions,
  onDraft,
}: {
  pinned: PinnedArtifact;
  actions: ReactNode;
  onDraft: (text: string) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { artifact, title } = pinned;
  const open = () =>
    void navigate({
      to: "/artifacts/$artifactId",
      params: { artifactId: artifact.id },
    });
  return (
    <section
      className={cn(
        "group flex min-w-0 flex-col gap-1.5",
        SIZE_CLASSES[pinned.size].cell,
      )}
      aria-label={title}
    >
      <div
        className={cn(
          "overflow-hidden rounded-2xl bg-muted",
          SIZE_CLASSES[pinned.size].tile,
        )}
      >
        {artifact.widget ? (
          <ArtifactFrame
            id={artifact.id}
            version={artifact.version}
            title={title}
            widget={pinned.size}
            fill
            className="rounded-none border-0"
            onDraft={onDraft}
            onOpen={open}
          />
        ) : (
          <Link
            to="/artifacts/$artifactId"
            params={{ artifactId: artifact.id }}
            className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground transition-colors hover:bg-secondary"
          >
            <ArtifactIcon kind={artifact.kind} className="size-6" />
            <span className="text-center text-[13px]">
              {t("dashboardNoWidget")}
            </span>
          </Link>
        )}
      </div>
      <div className="flex min-h-7 items-center gap-2 px-1">
        <Link
          to="/artifacts/$artifactId"
          params={{ artifactId: artifact.id }}
          title={t("dashboardOpen", { title })}
          className="min-w-0 flex-1 truncate rounded-full text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {title}
        </Link>
        <div className="-my-1 -mr-1.5 flex shrink-0 items-center transition-opacity focus-within:opacity-100 group-hover:opacity-100 has-data-[state=open]:opacity-100 [@media(hover:hover)]:opacity-0">
          {actions}
        </div>
      </div>
    </section>
  );
}

/** Chooses the size of a pinned artifact's widget. */
function SizeMenu({
  title,
  size,
  onChange,
}: {
  title: string;
  size: WidgetSize;
  onChange: (size: WidgetSize) => void;
}) {
  const { t } = useI18n();
  const names: Record<WidgetSize, string> = {
    small: t("widgetSmall"),
    medium: t("widgetMedium"),
    large: t("widgetLarge"),
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-full text-muted-foreground"
          aria-label={t("widgetSize", { title })}
          title={t("widgetSize", { title })}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        <DropdownMenuRadioGroup
          value={size}
          onValueChange={(value) => onChange(value as WidgetSize)}
        >
          {WIDGET_SIZES.map((choice) => (
            <DropdownMenuRadioItem
              key={choice}
              value={choice}
              className="min-h-9 pointer-coarse:min-h-11"
            >
              {names[choice]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A chat Pim is still making, showing its first message where the chat's
 * page will, so the message shows the moment it is sent. The chat's page
 * takes its place once the chat exists, adding the chat's tab to the open
 * ones shown here.
 */
function StartingChat({ content }: { content: UserContent }) {
  const shelf = useTabs().length > 0;
  return (
    <>
      <header
        className={cn(
          "hidden h-13 shrink-0 pr-4 md:flex",
          shelf && "bg-sidebar",
        )}
      >
        <ChatTabs activeId="" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <Thread
          sessionId=""
          synced={false}
          view={EMPTY_STREAM.view}
          pending={content}
          composerHeight={0}
        />
      </div>
    </>
  );
}
