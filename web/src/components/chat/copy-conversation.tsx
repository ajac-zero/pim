import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Copy, Link2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { usePimClient } from "~/lib/pim-client";
import { conversationMarkdown } from "~/lib/pim-view";
import { agentsQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** Copies every message in the open conversation, including those above the viewport. */
export function CopyConversation({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const state = usePimClient((state) => state);
  const { data: sessions } = useQuery(sessionsQuery());
  const { data: agents } = useQuery(agentsQuery());
  const session = sessions?.find((session) => session.id === sessionId);
  const agent = session?.visit
    ? `@${session.visit.username}`
    : (session?.agent?.name ?? agents?.find((agent) => agent.majordomo)?.name);
  const label = t("copyConversation");
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 self-center"
      aria-label={label}
      title={label}
      disabled={
        state.session !== sessionId ||
        !state.synced ||
        state.view.running ||
        state.pending !== null ||
        state.view.entries.length === 0 ||
        !agent
      }
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(
            conversationMarkdown(state.view.entries, agent ?? "Pim"),
          );
          toast.success(t("copied"));
        } catch {
          toast.error(t("couldNotCopyConversation"));
        }
      }}
    >
      <Copy className="size-4.5" />
    </Button>
  );
}

/** Copies the chat's id, which an agent can read the chat by (the `read_chat` tool), to hand off to a new chat. */
export function CopyChatId({
  sessionId,
  className,
}: {
  sessionId: string;
  className?: string;
}) {
  const { t } = useI18n();
  const label = t("copyChatId");
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("shrink-0 self-center", className)}
      aria-label={label}
      title={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(sessionId);
          toast.success(t("copied"));
        } catch {
          toast.error(t("couldNotCopyChatId"));
        }
      }}
    >
      <Link2 className="size-4.5" />
    </Button>
  );
}
