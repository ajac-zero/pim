import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { BrowserDialog } from "~/components/chat/browser-dialog";
import { TerminalDialog, useTerminal } from "~/components/chat/terminal-dialog";
import { useI18n } from "~/components/i18n";
import { AppWindow, Terminal } from "~/components/icons";
import { Action } from "~/components/ui/actions";
import { floatingButtonClass } from "~/components/ui/conversation";
import { browserQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** How often the chat looks at its browser while it works, for a window that opened or a page that changed. */
const BROWSER_REFRESH_MS = 4_000;

/** A live button, which fades in when it first has something to open, as the scroll to bottom button does. */
const liveButton = (visible: boolean) =>
  cn(
    floatingButtonClass(visible),
    "relative animate-in bg-background fade-in text-muted-foreground hover:text-foreground [&_svg]:size-4",
  );

/**
 * What the chat's agents are using on the person's computer, as buttons
 * floating in the row of the scroll to bottom button, each its icon alone
 * (what it shows is its tooltip): the chat's browser window while it's open,
 * and the terminal once they have run a command, with a dot while one runs.
 * Each opens over the page, as the Computer dialog does: the browser live, to
 * watch or take over, and the terminal's output.
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
  // The last page stays while its button fades out.
  const lastPage = useRef(browser?.page);
  if (browser?.page) lastPage.current = browser.page;
  const page = browser?.page;
  const shownPage = lastPage.current;
  const current = terminal.commands.findLast(
    (command) => command.endedAt === null,
  );
  const title = shownPage ? shownPage.title || hostOf(shownPage.url) : "";
  return (
    <>
      {shownPage && (
        <Action
          tooltip={t("openBrowser", { title })}
          className={liveButton(!!page)}
          variant="outline"
          aria-hidden={!page}
          tabIndex={page ? 0 : -1}
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
          className={liveButton(true)}
          variant="outline"
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
    </>
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
