import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { useDisplayText } from "~/components/computer-display-chip";
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
import { allDisplays, defaultDisplay, showable } from "~/lib/computer-displays";
import {
  ComputerScreen,
  canPlayScreen,
  holdScreen,
  releaseScreen,
  type ScreenLatency,
  type ScreenState,
} from "~/lib/computer-screen";
import { type ComputerDisplay, type ComputerStatus, pim } from "~/lib/pim-api";
import { computerDisplaysQuery, computerQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * Your computer, to use yourself, over whatever page you're on: its
 * desktop, live, with your mouse and keyboard going to it, while your
 * agents work there too. For the computer Pim keeps for you, it also says
 * while it's being set up, and why it couldn't be. While the desktop has
 * the keyboard, every key goes to the computer, Escape too; ⌘⇧D (see the
 * command palette) or the close button closes it.
 *
 * Besides the primary desktop, which is yours, each chat whose agent works
 * on a display of its own has it listed: it opens on the display of the chat
 * you're in (`chat`), to watch only, until you take it over, which makes its
 * agent wait.
 */
export function ComputerDialog({
  open,
  chat,
  onOpenChange,
}: {
  open: boolean;
  chat?: string | undefined;
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
  const queryClient = useQueryClient();
  // A computer without displayd has no displays to list, so it fails and shows just its desktop.
  const displaysQuery = useQuery(computerDisplaysQuery(open && !!live));
  const displays = allDisplays(displaysQuery.data);
  // What you picked, or until you pick, the display of the chat you're in when it holds one.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const wanted =
    picked === undefined ? defaultDisplay(displaysQuery.data, chat) : picked;
  const selected = displays.find((one) => one.threadId === wanted);
  const choosing = !!live && displaysQuery.isPending;
  const control = useMutation({
    mutationFn: (mode: "user" | "agent") =>
      pim.controlDisplay(selected?.threadId ?? "", mode),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["computer", "displays"] }),
    onError: (error) => toast.error(error.message),
  });
  const [latency, setLatency] = useState<ScreenLatency | null>(null);

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
            {live && displays.length > 0 && (
              <DisplayList
                displays={displays}
                selected={selected?.threadId ?? null}
                onSelect={setPicked}
              />
            )}
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
          {live && displays.length > 0 && (
            // Always there, so the window is as tall for every display.
            <div className="flex h-10 items-center">
              {selected && (
                <TakeOver
                  display={selected}
                  pending={control.isPending}
                  onControl={(mode) => control.mutate(mode)}
                />
              )}
            </div>
          )}
          <div
            ref={frame}
            // The desktop as large as the window allows, always in the same shape whatever display it shows,
            // which is scaled to fit; the whole screen on a phone. Without one, just room for what it says.
            style={
              {
                "--desktop-width": `min(calc(100vw - 4rem), calc((100dvh - 8rem) * 1.6))`,
                "--desktop-ratio": "16 / 10",
              } as CSSProperties
            }
            className={cn(
              "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden",
              live
                ? "bg-black sm:w-(--desktop-width) sm:flex-none sm:aspect-(--desktop-ratio)"
                : "px-6 pt-10 pb-14 sm:w-md sm:flex-none",
            )}
          >
            {!status || choosing ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : live && selected && !showable(selected) ? (
              <p className="px-6 text-center text-muted-foreground text-sm">
                {selected.state === "queued"
                  ? t("computerDisplayQueuedHint")
                  : t("computerDisplayNotReady")}
              </p>
            ) : live ? (
              <Desktop
                display={selected?.threadId ?? null}
                input={!selected || selected.control === "user"}
                onLatency={setLatency}
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

/** The primary desktop and each chat's display as compact buttons, to pick what the view shows; each says what it is on hover. */
function DisplayList({
  displays,
  selected,
  onSelect,
}: {
  displays: ComputerDisplay[];
  selected: string | null;
  onSelect: (display: string | null) => void;
}) {
  const { t } = useI18n();
  const text = useDisplayText();
  const item = (
    active: boolean,
    key: string,
    name: string,
    onClick: () => void,
    children: ReactNode,
    badge?: ReactNode,
  ) => (
    <Tooltip key={key}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-pressed={active}
          aria-label={name}
          onClick={onClick}
          className={cn(
            "relative flex h-7 min-w-7 shrink-0 items-center justify-center rounded-full border px-2 text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active
              ? "border-foreground/30 bg-accent font-medium text-foreground"
              : "border-transparent text-muted-foreground hover:bg-accent/50",
          )}
        >
          {children}
          {badge}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{name}</TooltipContent>
    </Tooltip>
  );
  return (
    <TooltipProvider>
      <nav
        aria-label={t("computerDisplays")}
        className="flex min-w-0 items-center gap-1 overflow-x-auto px-1 py-1"
      >
        {item(
          selected === null,
          "primary",
          t("computerPrimary"),
          () => onSelect(null),
          <Monitor className="size-3.5" />,
        )}
        {displays.map((display, index) => {
          const state =
            display.control === "user"
              ? t("computerDisplayYours")
              : text(display);
          return item(
            selected === display.threadId,
            display.threadId,
            `${display.title || t("computerDisplayUntitled")}: ${state}`,
            () => onSelect(display.threadId),
            index + 1,
            display.state === "queued" ? (
              <span className="-top-1 -right-1 absolute rounded-full bg-muted px-1 text-[9px] text-muted-foreground leading-3.5">
                #{display.position ?? 0}
              </span>
            ) : display.control === "user" ? (
              <span className="-top-0.5 -right-0.5 absolute size-2 rounded-full bg-primary" />
            ) : null,
          );
        })}
      </nav>
    </TooltipProvider>
  );
}

/** Whether you have a chat's display, with the button to take it over, which pauses its agent, or hand it back. */
function TakeOver({
  display,
  pending,
  onControl,
}: {
  display: ComputerDisplay;
  pending: boolean;
  onControl: (mode: "user" | "agent") => void;
}) {
  const { t } = useI18n();
  const yours = display.control === "user";
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 px-4">
      <p className="min-w-0 flex-1 text-muted-foreground text-xs">
        {yours ? t("computerYouControl") : t("computerWatchOnly")}
      </p>
      {showable(display) && (
        <Button
          size="sm"
          variant={yours ? "secondary" : "default"}
          disabled={pending}
          onClick={() => onControl(yours ? "agent" : "user")}
        >
          {pending && <Loader2 className="animate-spin" />}
          {yours ? t("computerHandBack") : t("computerTakeOver")}
        </Button>
      )}
    </div>
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
  display,
  input,
  onLatency,
}: {
  /** The chat whose display it shows, or null for the primary desktop. */
  display: string | null;
  /** Whether what you do goes to it; a chat's display is watched only until you take it over. */
  input: boolean;
  onLatency: (latency: ScreenLatency | null) => void;
}) {
  const { t } = useI18n();
  const holder = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ScreenState>({ status: "connecting" });
  const [attempt, setAttempt] = useState(0);
  const shown = useRef<ComputerScreen | null>(null);
  const playable = canPlayScreen();
  const label = t("computerDesktop");

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt connects again.
  useEffect(() => {
    const host = holder.current;
    if (!host || !playable) return;
    const screen = holdScreen(
      display,
      () => new ComputerScreen(desktopCanvas(), display),
    );
    shown.current = screen;
    screen.setInput(input);
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
  }, [playable, attempt, display]);

  // Taking a display over, or handing it back, doesn't reconnect it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt or display is a new screen to tell.
  useEffect(() => {
    shown.current?.setInput(input);
  }, [input, attempt, display]);

  useEffect(() => {
    holder.current?.querySelector("canvas")?.setAttribute("aria-label", label);
  }, [label]);

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
