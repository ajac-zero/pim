import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { ExternalLink, X } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { BROWSER_SCREENSHOT_URL, type BrowserStatus, pim } from "~/lib/pim-api";

/**
 * The browser your agents share, in the box beside a chat while it's open:
 * the page it shows, as a picture that keeps up with them, and taking it
 * over to sign in or finish something yourself.
 */
export function BrowserView({
  page,
  updatedAt,
}: {
  page: NonNullable<BrowserStatus["page"]>;
  /** When the status was last fetched: the picture is fetched again with it. */
  updatedAt: number;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const takeOver = useMutation({
    // The tab opens on the click, so no popup blocker stops it; the link comes after.
    mutationFn: async (tab: Window | null) => {
      try {
        const { url } = await pim.takeOverBrowser();
        if (tab) tab.location.href = url;
        else window.open(url, "_blank", "noopener");
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const close = useMutation({
    mutationFn: pim.closeBrowser,
    onSuccess: () => toast.success(t("browserClosed")),
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["browser"] }),
  });
  const title = page.title || hostOf(page.url);
  return (
    <section aria-labelledby="browser-view" className="border-t">
      <div className="flex items-center gap-2 px-4 pt-2.5">
        <h2 id="browser-view" className="text-[13px] text-muted-foreground">
          {t("browser")}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto size-7 rounded-full text-muted-foreground"
          aria-label={t("closeBrowser")}
          title={t("closeBrowser")}
          disabled={close.isPending}
          onClick={() => close.mutate()}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="space-y-3 px-4 pb-4">
        <div className="min-w-0">
          <p className="truncate font-medium text-sm">{title}</p>
          <p className="truncate text-muted-foreground text-xs">
            {hostOf(page.url)}
          </p>
        </div>
        <img
          src={`${BROWSER_SCREENSHOT_URL}?at=${updatedAt}`}
          alt={t("browserPicture", { title })}
          className="w-full rounded-lg border bg-background"
        />
        <Button
          className="w-full"
          disabled={takeOver.isPending}
          onClick={() => {
            const tab = window.open("", "_blank");
            if (tab) tab.opener = null;
            takeOver.mutate(tab);
          }}
        >
          <ExternalLink className="size-4" />
          {t("takeOverBrowser")}
        </Button>
        <p className="text-muted-foreground text-xs">{t("takeOverHint")}</p>
      </div>
    </section>
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
