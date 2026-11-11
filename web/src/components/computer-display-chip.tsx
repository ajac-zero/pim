import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useI18n } from "~/components/i18n";
import { Monitor } from "~/components/icons";
import { displayOf, idleFor } from "~/lib/computer-displays";
import type { ComputerDisplay } from "~/lib/pim-api";
import { computerDisplaysQuery, computerQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** How a display is doing, in a few words: queued #2, starting, active, idle 4m. */
export function useDisplayText(): (display: ComputerDisplay) => string {
  const { t } = useI18n();
  return (display) => {
    if (display.state === "queued")
      return t("computerDisplayQueued", { position: display.position ?? 0 });
    if (display.state === "starting") return t("computerDisplayStarting");
    if (display.state === "idle")
      return t("computerDisplayIdle", { time: idleFor(display.idleSec) });
    return t("computerDisplayActive");
  };
}

/**
 * In a chat's header: how the display its agent works on is doing, which
 * opens the Computer view on it. Nothing where the chat has no display, or
 * the computer has none to give.
 */
export function ComputerDisplayChip({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const text = useDisplayText();
  const { data: status } = useQuery(computerQuery());
  const { data } = useQuery(
    computerDisplaysQuery(status?.state === "online" && !!status.computer),
  );
  const display = displayOf(data, sessionId);
  if (!display) return null;
  return (
    <Link
      to="."
      search={(prev) => ({ ...prev, dialog: "computer" })}
      className={cn(
        "flex shrink-0 items-center gap-1.5 self-center rounded-full border px-2.5 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground",
        display.state === "active" && "text-foreground",
      )}
    >
      <Monitor className="size-3.5" />
      {t("computerChip", { state: text(display) })}
    </Link>
  );
}
