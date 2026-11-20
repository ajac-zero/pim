import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
  type WheelEvent,
} from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Power,
  RefreshCw,
  X,
} from "~/components/icons";
import { Action } from "~/components/ui/actions";
import { Button } from "~/components/ui/button";
import {
  BROWSER_LIVE_PATH,
  type BrowserInput,
  type BrowserLiveMessage,
  pim,
} from "~/lib/pim-api";

type Frame = { url: string; width: number; height: number };
type Status = "connecting" | "live" | "closed";

/** DevTools' modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

const BUTTONS = ["left", "middle", "right"] as const;

/**
 * The chat's window in its agent's browser, over the page as the Computer
 * dialog is: the page it shows, streamed live from the person's computer as
 * pictures, to watch the agent work, with the person's mouse, keyboard and
 * address bar going to it, to sign in or get past a check. The agent goes on
 * in the same page after. A hidden text field takes the keyboard, so phones
 * bring theirs up when the page is tapped; while it has the keyboard, Escape
 * is the page's, and the close button closes the dialog. It streams only
 * while open.
 */
export function BrowserDialog({
  session,
  open,
  onOpenChange,
}: {
  session: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          // Nothing is focused as it opens, so no button's tooltip shows over the page.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (document.activeElement instanceof HTMLTextAreaElement)
              event.preventDefault();
          }}
          className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-t-2xl sm:border sm:shadow-xl"
        >
          <Dialog.Title className="sr-only">{t("browser")}</Dialog.Title>
          {open && (
            <LiveBrowser
              session={session}
              onClosed={() => onOpenChange(false)}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function LiveBrowser({
  session,
  onClosed,
}: {
  session: string;
  onClosed: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const turnOff = useMutation({
    mutationFn: () => pim.closeBrowser(session),
    onSuccess: () => {
      toast.success(t("browserClosed"));
      onClosed();
    },
    onError: (error) => toast.error(error.message),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["browser"] }),
  });
  const socket = useRef<WebSocket | null>(null);
  const keys = useRef<HTMLTextAreaElement | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [page, setPage] = useState<{ url: string; title: string } | null>(null);
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [error, setError] = useState<string | null>(null);
  const lastMove = useRef(0);

  useEffect(() => {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const live = new WebSocket(
      `${scheme}://${location.host}${BROWSER_LIVE_PATH}?session=${encodeURIComponent(session)}`,
    );
    socket.current = live;
    live.addEventListener("message", (event) => {
      const message = JSON.parse(event.data as string) as BrowserLiveMessage;
      if (message.type === "frame") {
        setStatus("live");
        setFrame({
          url: `data:image/jpeg;base64,${message.data}`,
          width: message.width,
          height: message.height,
        });
      } else if (message.type === "page") {
        setPage({ url: message.url, title: message.title });
      } else {
        setError(message.message);
      }
    });
    live.addEventListener("close", () => setStatus("closed"));
    return () => live.close();
  }, [session]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(null), 5_000);
    return () => clearTimeout(timer);
  }, [error]);

  useEffect(() => {
    if (!editing)
      setAddress(page?.url.startsWith("data:") ? "" : (page?.url ?? ""));
  }, [page, editing]);

  const send = (input: BrowserInput) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(input));
  };

  /** Where the pointer is on the page, in the page's own pixels. */
  const at = (
    event: { clientX: number; clientY: number; currentTarget: Element },
    shown: Frame,
  ) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((event.clientX - box.left) / box.width) * shown.width),
      y: Math.round(((event.clientY - box.top) / box.height) * shown.height),
    };
  };

  const pointer =
    (kind: "mousePressed" | "mouseReleased") =>
    (event: PointerEvent<HTMLImageElement>) => {
      if (!frame) return;
      event.preventDefault();
      if (kind === "mousePressed") keys.current?.focus({ preventScroll: true });
      send({
        type: "mouse",
        event: kind,
        ...at(event, frame),
        button: BUTTONS[event.button] ?? "left",
        clickCount: 1,
        modifiers: modifiers(event),
      });
    };

  const move = (event: PointerEvent<HTMLImageElement>) => {
    if (!frame || event.timeStamp - lastMove.current < 50) return;
    lastMove.current = event.timeStamp;
    send({
      type: "mouse",
      event: "mouseMoved",
      ...at(event, frame),
      button: event.buttons & 1 ? "left" : "none",
      modifiers: modifiers(event),
    });
  };

  const wheel = (event: WheelEvent<HTMLImageElement>) => {
    if (!frame) return;
    send({
      type: "mouse",
      event: "mouseWheel",
      ...at(event, frame),
      deltaX: event.deltaX,
      deltaY: event.deltaY,
      modifiers: modifiers(event),
    });
  };

  const key =
    (kind: "keyDown" | "keyUp") =>
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Phones' keyboards say little in key events; what they type comes as input.
      if (event.key === "Unidentified" || event.key === "Process") return;
      event.preventDefault();
      const printable =
        event.key.length === 1 && !event.ctrlKey && !event.metaKey;
      const text = printable
        ? event.key
        : event.key === "Enter"
          ? "\r"
          : undefined;
      send({
        type: "key",
        event: kind,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        modifiers: modifiers(event),
        ...(kind === "keyDown" && text ? { text } : {}),
      });
    };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const url = address.trim();
    if (!url) return;
    send({ type: "navigate", url });
    setEditing(false);
    (document.activeElement as HTMLElement | null)?.blur();
  };

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b pr-1.5 pl-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full text-muted-foreground"
          aria-label={t("browserBack")}
          title={t("browserBack")}
          disabled={status !== "live"}
          onClick={() => send({ type: "back" })}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full text-muted-foreground"
          aria-label={t("browserForward")}
          title={t("browserForward")}
          disabled={status !== "live"}
          onClick={() => send({ type: "forward" })}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 rounded-full text-muted-foreground"
          aria-label={t("browserReload")}
          title={t("browserReload")}
          disabled={status !== "live"}
          onClick={() => send({ type: "reload" })}
        >
          <RefreshCw className="size-4" />
        </Button>
        <form onSubmit={navigate} className="min-w-0 flex-1">
          <input
            aria-label={t("browserAddress")}
            className="h-8 w-full rounded-xl bg-muted px-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            placeholder={t("browserAddressPlaceholder")}
            value={address}
            disabled={status !== "live"}
            spellCheck={false}
            autoCapitalize="off"
            onFocus={(event) => {
              setEditing(true);
              event.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <Action
          tooltip={t("closeBrowser")}
          className="size-8 rounded-full text-muted-foreground hover:text-destructive"
          disabled={turnOff.isPending}
          onClick={() => turnOff.mutate()}
        >
          <Power className="size-4" />
        </Action>
        <Dialog.Close className="rounded-full p-2 text-muted-foreground hover:bg-accent hover:text-foreground">
          <X className="size-4" />
          <span className="sr-only">{t("close")}</span>
        </Dialog.Close>
      </header>
      <main
        // The page fills the window edge to edge: on a wider screen the dialog takes the page's own shape (its window's, 1280 by 800, until the first
        // picture says), as large as the screen allows below the 45px toolbar; a phone's whole screen shows it as large as it fits.
        style={
          {
            "--page-aspect": `${frame?.width ?? 1280} / ${frame?.height ?? 800}`,
            "--page-width": `min(calc(100vw - 4rem), calc((100dvh - 4rem - 45px) * ${(frame?.width ?? 1280) / (frame?.height ?? 800)}))`,
          } as CSSProperties
        }
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/40 sm:aspect-(--page-aspect) sm:w-(--page-width) sm:flex-none"
      >
        {frame && status !== "closed" ? (
          <>
            <img
              src={frame.url}
              alt={t("browserPicture", { title: page?.title || "" })}
              draggable={false}
              className="max-h-full max-w-full cursor-default touch-none select-none bg-background sm:size-full"
              onPointerDown={pointer("mousePressed")}
              onPointerUp={pointer("mouseReleased")}
              onPointerMove={move}
              onWheel={wheel}
              onContextMenu={(event) => event.preventDefault()}
            />
            <textarea
              ref={keys}
              aria-label={t("browserKeyboard")}
              className="pointer-events-none absolute size-px opacity-0"
              autoCapitalize="off"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={key("keyDown")}
              onKeyUp={key("keyUp")}
              onPaste={(event) => {
                event.preventDefault();
                send({
                  type: "text",
                  text: event.clipboardData.getData("text"),
                });
              }}
              onInput={(event) => {
                const field = event.currentTarget;
                if (field.value) send({ type: "text", text: field.value });
                field.value = "";
              }}
            />
          </>
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            {status === "closed" ? (
              t("browserGone")
            ) : (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("browserConnecting")}
              </>
            )}
          </p>
        )}
        {error && (
          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-background px-4 py-2 text-destructive text-sm shadow">
            {error}
          </p>
        )}
      </main>
    </>
  );
}
