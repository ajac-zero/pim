import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Loader2, Maximize2, Monitor, X } from "~/components/icons";
import { Action } from "~/components/ui/actions";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import {
  ComputerScreen,
  canPlayScreen,
  holdScreen,
  releaseScreen,
  type ScreenLatency,
  type ScreenState,
} from "~/lib/computer-screen";
import { type ComputerStatus, pim } from "~/lib/pim-api";
import { computerQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * Your computer, to use yourself, over whatever page you're on: its
 * desktop, live, with your mouse and keyboard going to it, while your
 * agents work there too. For the computer Pim keeps for you, it also says
 * while it's being set up, and why it couldn't be. While the desktop has
 * the keyboard, every key goes to the computer, Escape too; ⌘⇧D (see the
 * command palette) or the close button closes it.
 */
export function ComputerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement | null>(null);
  const { data: status } = useQuery({
    ...computerQuery(),
    // While it's being set up, look now and then too, in case the socket missed it connecting.
    refetchInterval: (query) =>
      open && query.state.data?.managed && query.state.data.state !== "online"
        ? 5_000
        : false,
  });
  const live = status?.state === "online" && status.computer?.screen;
  const [latency, setLatency] = useState<ScreenLatency | null>(null);
  const [size, setSize] = useState({ width: 16, height: 10 });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          // Escape on the desktop is the computer's.
          onEscapeKeyDown={(event) => {
            if (document.activeElement instanceof HTMLCanvasElement)
              event.preventDefault();
          }}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:shadow-xl"
        >
          <header className="flex items-center gap-2 py-1.5 pr-1.5 pl-4">
            <Dialog.Title className="min-w-0 flex-1 truncate font-medium text-[15px]">
              {t("computer")}
            </Dialog.Title>
            {live && latency && <Latency latency={latency} />}
            {live && (
              <Action
                tooltip={t("computerFullScreen")}
                className="size-8 rounded-full text-muted-foreground"
                onClick={() => void frame.current?.requestFullscreen()}
              >
                <Maximize2 className="size-4" />
              </Action>
            )}
            <Dialog.Close className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
              <X className="size-4" />
              <span className="sr-only">{t("close")}</span>
            </Dialog.Close>
          </header>
          <div
            ref={frame}
            // The desktop as large as the window allows, in its own shape, below the header; the whole screen on a phone.
            // Without one, just room for what it says.
            style={
              {
                "--desktop-width": `min(calc(100vw - 4rem), calc((100dvh - 7rem) * ${size.width / size.height}))`,
                "--desktop-ratio": `${size.width} / ${size.height}`,
              } as CSSProperties
            }
            className={cn(
              "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden",
              live
                ? "bg-black sm:w-(--desktop-width) sm:flex-none sm:aspect-(--desktop-ratio)"
                : "px-6 pt-10 pb-14 sm:w-md sm:flex-none",
            )}
          >
            {!status ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : live ? (
              <Desktop
                onLatency={setLatency}
                onSize={(width, height) => setSize({ width, height })}
              />
            ) : (
              <NotLive status={status} />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The round trip to the computer, which the desktop's stream times, with its two parts on hover or focus. */
function Latency({ latency }: { latency: ScreenLatency }) {
  const { t } = useI18n();
  const detail =
    latency.computer === null
      ? t("computerLatencyNoAnswerDetail")
      : t("computerLatencyDetail", {
          pim: Math.max(0, latency.total - latency.computer),
          computer: latency.computer,
        });
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="shrink-0 cursor-default rounded-full px-1 text-muted-foreground text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {latency.computer === null
              ? t("computerLatencyNoAnswer")
              : t("computerLatency", { total: latency.total })}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">
          <p>{detail}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
  if (status.state === "offline" && status.managed)
    return (
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        {line(t("computerOfflineManaged"))}
        <Button
          variant="secondary"
          onClick={() => retry.mutate()}
          disabled={retry.isPending}
        >
          {retry.isPending && <Loader2 className="animate-spin" />}
          {t("computerSetUpAgain")}
        </Button>
      </div>
    );
  if (status.state === "offline") return line(t("computerOfflineHint"));
  return line(t("computerNoScreen"));
}

/**
 * The desktop, live; it connects again when the stream drops, unless the
 * computer said why it can't show it. Its stream outlives the dialog for a
 * while (`holdScreen`), with the canvas it draws on, which is put here.
 */
function Desktop({
  onLatency,
  onSize,
}: {
  onLatency: (latency: ScreenLatency | null) => void;
  onSize: (width: number, height: number) => void;
}) {
  const { t } = useI18n();
  const holder = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ScreenState>({ status: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const playable = canPlayScreen();
  const label = t("computerDesktop");

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt connects again.
  useEffect(() => {
    const host = holder.current;
    if (!host || !playable) return;
    const screen = holdScreen(() => new ComputerScreen(desktopCanvas()));
    host.append(screen.canvas);
    screen.observe(setState, onLatency);
    screen.canvas.focus({ preventScroll: true });
    return () => {
      screen.observe(
        () => {},
        () => {},
      );
      screen.releaseKeys();
      screen.canvas.remove();
      onLatency(null);
      releaseScreen(screen);
    };
  }, [playable, attempt]);

  useEffect(() => {
    holder.current?.querySelector("canvas")?.setAttribute("aria-label", label);
  }, [label]);

  const width = state.status === "live" ? state.width : 0;
  const height = state.status === "live" ? state.height : 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the size, not the callback, changes.
  useEffect(() => {
    if (width && height) onSize(width, height);
  }, [width, height]);

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
      <div
        ref={holder}
        className={cn("size-full", state.status !== "live" && "opacity-0")}
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

/** The canvas the desktop is drawn on, made outside React so it can outlive the dialog with its stream. */
function desktopCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.width = 1280;
  canvas.height = 800;
  canvas.className =
    "size-full object-contain cursor-default touch-none select-none bg-black outline-none";
  return canvas;
}
