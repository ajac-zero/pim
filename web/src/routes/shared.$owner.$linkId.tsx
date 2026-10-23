import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AgentIcon } from "~/components/agent-icon";
import { PimMark } from "~/components/app-sidebar";
import { AssistantMessage, UserMessage } from "~/components/chat/items";
import { Speaker } from "~/components/chat/room";
import { useI18n } from "~/components/i18n";
import { Loader2 } from "~/components/icons";
import { SentWidgets } from "~/components/widgets";
import { ApiError, pim } from "~/lib/pim-api";

export const Route = createFileRoute("/shared/$owner/$linkId")({
  component: SharedChatPage,
});

/**
 * A chat's public link: the copy of the chat its owner shared, for anyone,
 * signed in or not. The root shows it alone, without the app or a sign-in.
 * Everything in it is shown as untrusted text: no images, no raw HTML, and
 * links only to web and mail addresses.
 */
function SharedChatPage() {
  const { owner, linkId } = Route.useParams();
  const { t, formatDate } = useI18n();
  const { data: chat, error } = useQuery({
    queryKey: ["shared-chat", owner, linkId],
    queryFn: () => pim.sharedChat(owner, linkId),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const title = chat ? (chat.title ?? chat.agent.name) : null;
  useEffect(() => {
    if (title) document.title = `${title} · Pim`;
  }, [title]);

  if (error) {
    return (
      <main className="flex min-h-svh items-center justify-center px-6 text-center text-muted-foreground">
        {error instanceof ApiError && error.status === 404
          ? t("sharedChatGone")
          : error.message}
      </main>
    );
  }
  if (!chat) {
    return (
      <main className="flex min-h-svh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }
  // A group chat's copy says who wrote each agent's message.
  const grouped = chat.messages.some(
    (message) => message.role === "agent" && message.from !== undefined,
  );
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-10 border-border border-b bg-background">
        <div className="mx-auto flex h-13 w-full max-w-3xl items-center gap-2 px-4">
          <AgentIcon
            agent={{ id: "", icon: null, ...chat.agent }}
            tile
            className="size-6 shrink-0 rounded-md"
          />
          <h1 className="min-w-0 truncate text-[15px]">{title}</h1>
          <span className="ml-auto shrink-0 text-[13px] text-muted-foreground">
            {t("sharedChatAt", {
              date: formatDate(new Date(chat.sharedAt), {
                dateStyle: "medium",
              }),
            })}
          </span>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-5 px-4 py-8 [&>[data-speaker=assistant]+[data-speaker=assistant]]:-mt-2 [&>[data-speaker=assistant]+[data-speaker=assistant]]:border-border/60 [&>[data-speaker=assistant]+[data-speaker=assistant]]:border-t [&>[data-speaker=assistant]+[data-speaker=assistant]]:pt-4 [&>[data-speaker=user]+[data-speaker=user]]:-mt-3">
        {chat.messages.map((message, index) =>
          message.role === "user" ? (
            <UserMessage
              // biome-ignore lint/suspicious/noArrayIndexKey: a copy never changes, so its order is its identity.
              key={index}
              at={message.at}
              item={{
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text:
                      message.images > 0
                        ? [
                            message.text,
                            `_${t("sharedChatImages", { count: message.images })}_`,
                          ]
                            .filter(Boolean)
                            .join("\n\n")
                        : message.text,
                  },
                ],
              }}
            />
          ) : (
            <AssistantMessage
              // biome-ignore lint/suspicious/noArrayIndexKey: as above
              key={index}
              at={message.at}
              untrusted
              speaker={
                grouped ? (
                  <Speaker name={message.from ?? chat.agent.name} />
                ) : undefined
              }
              item={{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: message.text }],
              }}
              attachments={
                message.widgets.length > 0 ? (
                  <SentWidgets
                    requested={message.widgets.length}
                    widgets={message.widgets}
                  />
                ) : null
              }
            />
          ),
        )}
      </main>
      <footer className="flex flex-col items-center gap-3 px-6 pt-4 pb-10 text-center text-[13px] text-muted-foreground">
        <PimMark className="h-4" />
        {t("sharedChatFooter")}
      </footer>
    </div>
  );
}
