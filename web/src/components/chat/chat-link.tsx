import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Globe, Link2, RefreshCw, X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { pim } from "~/lib/pim-api";
import { chatLinkQuery, sessionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** Copies a link, or shows it when the clipboard can't take it. */
function copyLink(url: string, done: string) {
  void navigator.clipboard.writeText(url).then(
    () => toast.success(done),
    () => toast(url),
  );
}

/**
 * The chat's public link: a copy of the chat as it is when the link is made,
 * which anyone with the link can read. Updating it copies the chat again
 * under the same address; turning it off ends it. Not offered in a visit,
 * whose agent is someone else's.
 */
export function ChatLinkMenu({ sessionId }: { sessionId: string }) {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const { data: sessions } = useQuery(sessionsQuery());
  const session = sessions?.find((candidate) => candidate.id === sessionId);
  const { data: link } = useQuery({
    ...chatLinkQuery(sessionId),
    enabled: !!session && !session.visit,
  });
  const change = useMutation({
    mutationFn: (on: boolean) =>
      on
        ? pim.shareChat(sessionId)
        : pim.unshareChat(sessionId).then(() => null),
    onSuccess: (made) => {
      if (!made) toast.success(t("chatLinkTurnedOff"));
      else if (link) toast.success(t("chatLinkUpdated"));
      else copyLink(made.url, t("chatLinkCopied"));
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["chat-link", sessionId] }),
    onError: (failure) => toast.error(failure.message),
  });
  if (!session || session.visit) return null;
  const label = t(link ? "chatLinkOn" : "chatLink");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 self-center"
          aria-label={label}
          title={label}
          disabled={link === undefined}
        >
          <Globe className={cn("size-4.5", link && "text-link")} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="font-normal text-muted-foreground text-xs leading-5">
          {link
            ? t("chatLinkSharedAt", {
                date: formatDate(new Date(link.sharedAt), {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })
            : t("chatLinkHint")}
        </DropdownMenuLabel>
        {link ? (
          <>
            <DropdownMenuItem
              onSelect={() => copyLink(link.url, t("chatLinkCopied"))}
            >
              <Link2 />
              {t("copyLink")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={change.isPending}
              onSelect={() => change.mutate(true)}
            >
              <RefreshCw />
              {t("chatLinkUpdate")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={change.isPending}
              onSelect={() => change.mutate(false)}
            >
              <X />
              {t("chatLinkTurnOff")}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            disabled={change.isPending}
            onSelect={() => change.mutate(true)}
          >
            <Globe />
            {t("chatLinkCreate")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
