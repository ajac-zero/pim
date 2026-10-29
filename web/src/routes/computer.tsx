import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Loader2, Maximize2, Monitor } from "~/components/icons";
import { Action } from "~/components/ui/actions";
import { Button } from "~/components/ui/button";
import {
  ComputerScreen,
  canPlayScreen,
  type ScreenState,
} from "~/lib/computer-screen";
import { type ComputerStatus, pim } from "~/lib/pim-api";
import { computerQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/computer")({
  component: ComputerPage,
});

/**
 * Your computer, to use yourself: its desktop, live, with your mouse and
 * keyboard going to it, while your agents work there too. For the
 * computer Pim keeps for you, it also says while it's being set up, and
 * why it couldn't be.
 */
function ComputerPage() {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement | null>(null);
  const { data: status } = useQuery({
    ...computerQuery(),
    // While it's being set up, look now and then too, in case the socket missed it connecting.
    refetchInterval: (query) =>
      query.state.data?.managed && query.state.data.state !== "online"
        ? 5_000
        : false,
  });
  const live = status?.state === "online" && status.computer?.screen;

  useEffect(() => {
    document.title = t("computer");
  }, [t]);

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{t("computer")}</h1>
          <p className="truncate text-muted-foreground text-xs">
            {status ? summary(status, t) : "\u00a0"}
          </p>
        </div>
        {live && (
          <Action
            tooltip={t("computerFullScreen")}
            className="size-8 rounded-full text-muted-foreground"
            onClick={() => void frame.current?.requestFullscreen()}
          >
            <Maximize2 className="size-4" />
          </Action>
        )}
      </header>
      <div
        ref={frame}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/40 p-3 [&:fullscreen]:bg-black [&:fullscreen]:p-0"
      >
        {!status ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : live ? (
          <Desktop />
        ) : (
          <NotLive status={status} />
        )}
      </div>
    </main>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

/** The line under the title: what the computer is, and whether it's there. */
function summary(status: ComputerStatus, t: Translate): string {
  const machine = status.computer;
  const state =
    status.state === "online"
      ? t("computerOnline")
      : status.error
        ? t("computerNotSetUp")
        : status.managed && !machine
          ? t("computerSettingUp")
          : t("computerOffline");
  return [machine?.hostname, state].filter(Boolean).join(" · ");
}

/** Why the desktop isn't showing, and what to do about it. */
function NotLive({ status }: { status: ComputerStatus }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: pim.setUpComputer,
    onSuccess: (next) => queryClient.setQueryData(["computer"], next),
    onError: (error) => toast.error(error.message),
  });
  const line = (text: string, spinning = false) => (
    <p className="flex max-w-md items-center gap-2 text-center text-muted-foreground text-sm">
      {spinning && <Loader2 className="size-4 shrink-0 animate-spin" />}
      {text}
    </p>
  );
  if (status.error)
    return (
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <p className="text-sm">{t("computerSetupFailed")}</p>
        <p className="text-muted-foreground text-xs">{status.error}</p>
        <Button onClick={() => retry.mutate()} disabled={retry.isPending}>
          {retry.isPending && <Loader2 className="animate-spin" />}
          {t("tryAgain")}
        </Button>
      </div>
    );
  if (status.state === "none")
    return (
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <Monitor className="size-6 text-muted-foreground" />
        {line(t("computerNone"))}
        <Button variant="secondary" asChild>
          <Link
            to="."
            search={(prev) => ({
              ...prev,
              dialog: "settings",
              tab: "computer",
            })}
          >
            {t("settings")}
          </Link>
        </Button>
      </div>
    );
  if (status.managed && !status.computer)
    return line(t("computerSettingUpHint"), true);
  if (status.state === "offline")
    return line(
      t(status.managed ? "computerOfflineManaged" : "computerOfflineHint"),
    );
  return line(t("computerNoScreen"));
}

/** The desktop, live; it connects again when the stream drops, unless the computer said why it can't show it. */
function Desktop() {
  const { t } = useI18n();
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<ScreenState>({ status: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const playable = canPlayScreen();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt connects again.
  useEffect(() => {
    if (!canvas.current || !playable) return;
    const screen = new ComputerScreen(canvas.current, setState);
    canvas.current.focus({ preventScroll: true });
    return () => screen.close();
  }, [playable, attempt]);

  useEffect(() => {
    // 4004: the space said why it can't show it; anything else is a drop, so it tries again.
    if (state.status !== "closed" || state.code === 4004 || state.code === 1000)
      return;
    const timer = setTimeout(() => setAttempt((count) => count + 1), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  if (!playable)
    return (
      <p className="text-muted-foreground text-sm">{t("computerCantPlay")}</p>
    );
  return (
    <>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={t("computerDesktop")}
        width={1280}
        height={800}
        className={cn(
          "max-h-full max-w-full cursor-default touch-none select-none rounded-lg bg-black outline-none [:fullscreen_&]:rounded-none",
          state.status !== "live" && "opacity-0",
        )}
        style={
          state.status === "live"
            ? { aspectRatio: `${state.width} / ${state.height}` }
            : undefined
        }
      />
      {state.status !== "live" && (
        <p className="absolute flex items-center gap-2 text-muted-foreground text-sm">
          {state.status === "closed" && state.code === 4004 ? (
            state.reason || t("computerOffline")
          ) : (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t("computerConnecting")}
            </>
          )}
        </p>
      )}
    </>
  );
}
