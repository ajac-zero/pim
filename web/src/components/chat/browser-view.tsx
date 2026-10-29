import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { ChevronRight, ExternalLink, Power } from "~/components/icons";
import { Action } from "~/components/ui/actions";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { type BrowserStatus, browserScreenshotUrl, pim } from "~/lib/pim-api";

/**
 * The chat's window in the browser your agents share, in the box beside
 * the chat while it's open: expand its dropdown for a picture that keeps up
 * with them, and take it over, on a page of its own (routes/browser.tsx),
 * to sign in or finish something yourself.
 */
export function BrowserView({
  sessionId,
  page,
  updatedAt,
}: {
  sessionId: string;
  page: NonNullable<BrowserStatus["page"]>;
  /** When the status was last fetched: the picture is fetched again with it. */
  updatedAt: number;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const close = useMutation({
    mutationFn: () => pim.closeBrowser(sessionId),
    onSuccess: () => toast.success(t("browserClosed")),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["browser"] }),
  });
  const title = page.title || hostOf(page.url);
  return (
    <Collapsible asChild>
      <section aria-labelledby="browser-view" className="border-t">
        <h2 id="browser-view">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3.5 text-left text-[13px] text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            {t("browser")}
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="space-y-3 px-4 pb-4">
          <div className="min-w-0">
            <p className="truncate font-medium text-sm">{title}</p>
            <p className="truncate text-muted-foreground text-xs">
              {hostOf(page.url)}
            </p>
          </div>
          <img
            src={browserScreenshotUrl(sessionId, updatedAt)}
            alt={t("browserPicture", { title })}
            className="w-full rounded-lg border bg-background"
          />
          <div className="grid grid-cols-[3fr_1fr] gap-2">
            <Button className="w-full" asChild>
              {/* A page of its own, beside the chat, where the person uses the browser. */}
              <a
                href={`/browser?session=${encodeURIComponent(sessionId)}`}
                target="_blank"
                rel="noopener"
              >
                <ExternalLink className="size-4" />
                {t("takeOverBrowser")}
              </a>
            </Button>
            <Action
              tooltip={t("closeBrowser")}
              variant="destructive"
              size="default"
              className="w-full bg-destructive text-white hover:bg-destructive/85"
              disabled={close.isPending}
              onClick={() => close.mutate()}
            >
              <Power className="size-4" />
            </Action>
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

/** Where a page is from, as a person reads it. */
function hostOf(url: string): string {
  if (url.startsWith("data:")) return "HTML";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
