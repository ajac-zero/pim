import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BrowserDialog } from "~/components/chat/browser-dialog";
import { TerminalDialog, useTerminal } from "~/components/chat/terminal-dialog";
import { useI18n } from "~/components/i18n";
import { AppWindow, Terminal } from "~/components/icons";
import { Action } from "~/components/ui/actions";
import { browserQuery } from "~/lib/queries";

/** How often the chat looks at its browser while it works, for a window that opened or a page that changed. */
const BROWSER_REFRESH_MS = 4_000;

/** The classes of a button floating above the composer. */
const LIVE_BUTTON =
  "relative size-9 animate-in rounded-full border bg-background text-muted-foreground shadow-[0_2px_10px_-4px_rgb(0_0_0/0.18)] duration-150 fade-in hover:bg-accent hover:text-foreground [&_svg]:size-4";

/**
 * What the chat's agents are using on the person's computer, as buttons
 * floating above the composer, each its icon alone (what it shows is its
 * tooltip): the chat's browser window while it's open, and the terminal once
 * they have run a command, with a dot while one runs. Each opens over the page, as the Computer dialog
 * does: the browser live, to watch or take over, and the terminal's output.
 */
export function LiveButtons({
  sessionId,
  working,
}: {
  sessionId: string;
  /** Whether the chat's agents are working now, when either may change. */
  working: boolean;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState<"browser" | "terminal" | null>(null);
  const { data: browser } = useQuery({
    ...browserQuery(sessionId),
    refetchInterval: working ? BROWSER_REFRESH_MS : false,
  });
  const terminal = useTerminal(sessionId, working);
  const page = browser?.page;
  const current = terminal.commands.findLast(
    (command) => command.endedAt === null,
  );
  if (!page && terminal.commands.length === 0) return null;
  const title = page ? page.title || hostOf(page.url) : "";
  return (
    <div className="flex gap-2 px-3 pb-2">
      {page && (
        <Action
          tooltip={t("openBrowser", { title })}
          className={LIVE_BUTTON}
          onClick={() => setShown("browser")}
        >
          <AppWindow />
        </Action>
      )}
      {terminal.commands.length > 0 && (
        <Action
          tooltip={
            current
              ? t("openTerminalRunning", {
                  command:
                    current.command.length > 60
                      ? `${current.command.slice(0, 60)}…`
                      : current.command,
                })
              : t("openTerminal")
          }
          className={LIVE_BUTTON}
          onClick={() => setShown("terminal")}
        >
          <Terminal />
          {terminal.running && (
            // A command runs now.
            <span className="absolute top-1 right-1 size-2 animate-pulse rounded-full bg-primary" />
          )}
        </Action>
      )}
      <BrowserDialog
        session={sessionId}
        open={shown === "browser"}
        onOpenChange={(open) => setShown(open ? "browser" : null)}
      />
      <TerminalDialog
        commands={terminal.commands}
        open={shown === "terminal"}
        onOpenChange={(open) => setShown(open ? "terminal" : null)}
      />
    </div>
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
