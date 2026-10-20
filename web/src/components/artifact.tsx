import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import {
  Code,
  FileCode2,
  FileText,
  ImageIcon,
  ShieldAlert,
  Workflow,
} from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  ApiError,
  ARTIFACT_KINDS,
  type ArtifactFrom,
  type ArtifactKind,
  type ArtifactReference,
  artifactFrameUrl,
  pim,
} from "~/lib/pim-api";
import { artifactQuery, artifactVersionQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The one message an artifact may send: its height. Anything else is ignored. */
const HEIGHT_MESSAGE = "pim:artifact-height";
const MIN_HEIGHT = 80;
/** At most this many height messages a second are taken; a page that sends more is left as it is. */
const MAX_MESSAGES_PER_SECOND = 20;

/** `pim.chat(text)`: a message for the person to send, answered here, never by Pim. */
const DRAFT_OP = "chat.draft";
const MAX_DRAFT = 2000;
/** `pim.open()`: from a dashboard's widget, opens the full artifact, answered here too. */
const OPEN_OP = "app.open";

/** A call the page makes through its bridge (`window.pim`), and the answer it's sent. */
const CALL_MESSAGE = "pim:call";
const REPLY_MESSAGE = "pim:reply";
/** At most this many bridge calls a second are taken; more are dropped, unanswered. */
const MAX_CALLS_PER_SECOND = 20;

type Needs = { capability: string; label: string };
type Asking = Needs & { answer: (allowed: boolean) => void };

/**
 * The app's side of an artifact's bridge. The page's calls go to Pim as
 * this version's; what needs the person's permission (the model, an app's
 * tool) is asked here first, once per thing per version: Pim keeps the
 * answer when it's yes, and this frame remembers a no until it's reloaded.
 */
function useBridge(id: string, version: number, from?: ArtifactFrom) {
  const [asking, setAsking] = useState<Asking[]>([]);
  const answers = useRef(new Map<string, Promise<boolean>>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: another version asks anew
  useEffect(() => {
    answers.current = new Map();
    setAsking([]);
  }, [id, version]);

  const ask = (needs: Needs) => {
    let answer = answers.current.get(needs.capability);
    if (!answer) {
      answer = new Promise<boolean>((resolve) =>
        setAsking((queue) => [
          ...queue,
          {
            ...needs,
            answer: (allowed) => {
              setAsking((rest) =>
                rest.filter((item) => item.capability !== needs.capability),
              );
              // A yes is kept by Pim; asking again after a yes only happens on a new version.
              if (allowed) answers.current.delete(needs.capability);
              resolve(allowed);
            },
          },
        ]),
      );
      answers.current.set(needs.capability, answer);
    }
    return answer;
  };

  const call = async (op: string, args: unknown): Promise<unknown> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const answer = await pim.artifactBridge(id, version, op, args, from);
      if ("value" in answer) return answer.value;
      if (!(await ask(answer.needs))) {
        throw new Error("The person didn't allow it.");
      }
      await pim.grantArtifact(id, version, answer.needs.capability, from);
    }
    throw new Error("The person didn't allow it.");
  };

  return { call, asking: asking[0] ?? null };
}

/**
 * An HTML artifact's version, in a sandboxed frame. The page it loads gets an
 * opaque origin from its own response (and from `sandbox`, again here): it
 * can't reach this app's cookies, storage or API. The frame listens only to
 * this frame's window: for the page's height, and for calls through its
 * bridge, which it makes to Pim for the page (asking the person when they
 * must allow something) and answers. If the page navigates itself away, it's
 * taken down: that's how an artifact could send what it shows, or what
 * someone typed, elsewhere.
 */
export function ArtifactFrame({
  id,
  version,
  title,
  maxHeight = 360,
  fill = false,
  className,
  eager = false,
  from,
  onDraft,
  widget = false,
  onOpen,
}: {
  id: string;
  version: number;
  title: string;
  /** Whose it is, when it isn't yours: shared with you, or published. */
  from?: ArtifactFrom;
  /**
   * Where the page's `pim.chat(text)` goes: a message the person may send.
   * Without it, as everywhere but a dashboard, the call fails.
   */
  onDraft?: (text: string) => void;
  /** Shows the version's widget, its small view for a dashboard, instead of the artifact. */
  widget?: boolean;
  /** What the page's `pim.open()` does; without it, the call fails. */
  onOpen?: () => void;
  /** The tallest it grows to its page's height; ignored when `fill`. */
  maxHeight?: number;
  /** Fills its container instead of following its page's height. */
  fill?: boolean;
  className?: string;
  /** Loads at once, even out of view, as a copy to print must. */
  eager?: boolean;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [left, setLeft] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Loads of the frame now shown; a new version or a retry starts again.
  const loads = useRef({ key: "", count: 0 });
  const key = `${id}:${version}:${widget}:${attempt}`;
  const bridge = useBridge(id, version, from);
  // The bridge as it is now, for the listener, which stays the same.
  const call = useRef(bridge.call);
  call.current = async (op, args) => {
    if (op === OPEN_OP) {
      if (!onOpen)
        throw new Error("pim.open works only in a dashboard's widget.");
      onOpen();
      return null;
    }
    if (op !== DRAFT_OP) return bridge.call(op, args);
    if (!onDraft) throw new Error("pim.chat works only on a dashboard.");
    const text = (args as { text?: unknown }).text;
    if (typeof text !== "string" || !text.trim() || text.length > MAX_DRAFT) {
      throw new Error(`pim.chat needs text, at most ${MAX_DRAFT} characters`);
    }
    onDraft(text.trim());
    return null;
  };
  // The page now shown; a call is answered only while it still is.
  const shownKey = useRef(key);
  shownKey.current = key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version is a new page, not one that left
  useEffect(() => {
    setLeft(false);
  }, [id, version]);

  useEffect(() => {
    let windowStart = 0;
    let count = 0;
    let callStart = 0;
    let calls = 0;
    const onMessage = (event: MessageEvent) => {
      // The origin of a sandboxed page is "null" whoever sent it: only the source tells.
      if (!frame.current || event.source !== frame.current.contentWindow) {
        return;
      }
      const page = event.source as Window;
      const message = event.data as {
        type?: unknown;
        id?: unknown;
        op?: unknown;
        args?: unknown;
      } | null;
      if (
        typeof message === "object" &&
        message !== null &&
        message.type === CALL_MESSAGE &&
        typeof message.id === "number" &&
        typeof message.op === "string"
      ) {
        const now = Date.now();
        if (now - callStart > 1000) {
          callStart = now;
          calls = 0;
        }
        if (++calls > MAX_CALLS_PER_SECOND) return;
        const shown = shownKey.current;
        const reply = (body: { value: unknown } | { error: string }) => {
          // Only to the page that asked: not one it navigated to since, nor after a retry or a new version.
          const left = loads.current.key === shown && loads.current.count > 1;
          if (shownKey.current !== shown || left) return;
          page.postMessage(
            { type: REPLY_MESSAGE, id: message.id, ...body },
            "*",
          );
        };
        call.current(message.op, message.args ?? {}).then(
          (value) => reply({ value }),
          (failure: unknown) =>
            reply({
              error: failure instanceof Error ? failure.message : "failed",
            }),
        );
        return;
      }
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (
        typeof data !== "object" ||
        data === null ||
        data.type !== HEIGHT_MESSAGE ||
        typeof data.height !== "number" ||
        !Number.isFinite(data.height)
      ) {
        return;
      }
      const now = Date.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        count = 0;
      }
      if (++count > MAX_MESSAGES_PER_SECOND) return;
      setHeight(Math.min(Math.max(Math.ceil(data.height), MIN_HEIGHT), 20_000));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (left) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center text-sm",
          fill && "h-full",
          className,
        )}
      >
        <ShieldAlert className="size-5 text-muted-foreground" />
        <p className="max-w-sm text-muted-foreground">
          {t("artifactNavigated")}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setLeft(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t("artifactShowAgain")}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("relative", fill && "h-full")}>
      {bridge.asking && (
        <div
          role="alertdialog"
          aria-label={title}
          className="absolute inset-x-2 top-2 z-10 flex flex-wrap items-center gap-3 rounded-xl border bg-background p-3 text-sm shadow-lg"
        >
          <ShieldAlert className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1">
            {bridge.asking.capability === "model"
              ? t("artifactWantsModel", { title })
              : t("artifactWantsTool", { title, tool: bridge.asking.label })}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => bridge.asking?.answer(false)}
            >
              {t("artifactDeny")}
            </Button>
            <Button size="sm" onClick={() => bridge.asking?.answer(true)}>
              {t("artifactAllow")}
            </Button>
          </div>
        </div>
      )}
      <iframe
        key={key}
        ref={frame}
        title={title}
        src={artifactFrameUrl(id, version, from, widget)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading={eager ? "eager" : "lazy"}
        onLoad={() => {
          // The first load is the artifact; another is the page navigating itself somewhere.
          if (loads.current.key !== key) loads.current = { key, count: 0 };
          loads.current.count += 1;
          if (loads.current.count > 1) setLeft(true);
        }}
        className={cn(
          "block w-full rounded-lg border bg-white",
          fill && "h-full",
          className,
        )}
        // The page's height, plus the frame's border.
        style={fill ? undefined : { height: Math.min(height + 2, maxHeight) }}
      />
    </div>
  );
}

/** A version of an artifact, shown as it runs or draws in a frame, or as it reads (Markdown). */
export function ArtifactPreview({
  id,
  version,
  kind,
  title,
  fill,
  maxHeight,
  eager,
  from,
  onDraft,
}: {
  id: string;
  version: number;
  kind: ArtifactKind;
  title: string;
  fill?: boolean;
  maxHeight?: number;
  eager?: boolean;
  /** Whose it is, when it isn't yours: shared with you, or published. */
  from?: ArtifactFrom;
  /** Where a framed page's `pim.chat(text)` goes; see `ArtifactFrame`. */
  onDraft?: (text: string) => void;
}) {
  if (kind !== "markdown") {
    return (
      <ArtifactFrame
        id={id}
        version={version}
        title={title}
        fill={fill}
        maxHeight={maxHeight}
        eager={eager}
        from={from}
        onDraft={onDraft}
      />
    );
  }
  return (
    <MarkdownArtifact
      id={id}
      version={version}
      fill={fill}
      maxHeight={maxHeight}
      from={from}
    />
  );
}

function MarkdownArtifact({
  id,
  version,
  fill,
  maxHeight = 360,
  from,
}: {
  id: string;
  version: number;
  fill?: boolean;
  maxHeight?: number;
  from?: ArtifactFrom;
}) {
  const { t } = useI18n();
  const { data, error } = useQuery(artifactVersionQuery(id, version, from));
  if (error) {
    return <p className="text-muted-foreground text-sm">{error.message}</p>;
  }
  if (!data) {
    return <p className="text-muted-foreground text-sm">{t("loading")}</p>;
  }
  return (
    <div
      className={cn(
        "overflow-y-auto rounded-lg border px-4 py-3 scrollbar-thin",
        fill && "h-full",
      )}
      style={fill ? undefined : { maxHeight }}
    >
      <Markdown text={data.content ?? ""} untrusted />
    </div>
  );
}

/**
 * Prints a version (or saves it as a PDF, from the browser's print dialog):
 * a full-height copy of it, the only thing the page prints, which is taken
 * away once printing ends. It waits for a framed page to report its height.
 */
export function ArtifactPrint({
  id,
  version,
  kind,
  title,
  onDone,
  from,
}: {
  id: string;
  version: number;
  kind: ArtifactKind;
  title: string;
  onDone: () => void;
  from?: ArtifactFrom;
}) {
  useEffect(() => {
    window.addEventListener("afterprint", onDone);
    const timer = window.setTimeout(() => window.print(), 1200);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", onDone);
    };
  }, [onDone]);
  return createPortal(
    <div className="print-area" aria-hidden="true">
      <ArtifactPreview
        id={id}
        version={version}
        kind={kind}
        title={title}
        maxHeight={100_000}
        eager
        from={from}
      />
    </div>,
    document.body,
  );
}

export function ArtifactIcon({
  kind,
  className,
}: {
  kind: ArtifactKind;
  className?: string;
}) {
  const Icon = {
    html: FileCode2,
    markdown: FileText,
    svg: ImageIcon,
    mermaid: Workflow,
    jsx: Code,
  }[kind];
  return <Icon className={className} />;
}

/** What each kind is called, short, next to an artifact's name. */
export const ARTIFACT_KIND_NAMES: Record<ArtifactKind, string> = {
  html: "HTML",
  markdown: "Markdown",
  svg: "SVG",
  mermaid: "Mermaid",
  jsx: "React",
};

/** The language an artifact's source is highlighted as. */
export const ARTIFACT_LANGUAGES = {
  html: "html",
  markdown: "markdown",
  svg: "xml",
  mermaid: "mermaid",
  jsx: "tsx",
} as const satisfies Record<ArtifactKind, string>;

/**
 * An artifact version the agent made in a chat, as a block that opens it in
 * the canvas beside the chat. The version stays the one this call made, so
 * a chat shows how the artifact changed. One made while the person watches
 * (`live`) opens by itself.
 */
export function ArtifactCard({
  reference,
  sessionId,
  live = false,
}: {
  reference: ArtifactReference;
  sessionId: string;
  live?: boolean;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data, error } = useQuery(artifactQuery(reference.id));
  // The canvas shows the latest version when it names none.
  const open = useSearch({
    strict: false,
    select: (search: { artifact?: string; v?: number }) =>
      search.artifact === reference.id &&
      (search.v ?? data?.version) === reference.version,
  });
  const deleted = error instanceof ApiError && error.status === 404;
  const opened = useRef(false);
  useEffect(() => {
    if (!live || deleted || opened.current) return;
    opened.current = true;
    void navigate({
      to: "/chat/$sessionId",
      params: { sessionId },
      search: { artifact: reference.id, v: reference.version },
    });
  }, [live, deleted, navigate, sessionId, reference.id, reference.version]);
  const body = (
    <>
      <ArtifactIcon
        kind={reference.kind}
        className="size-10 shrink-0 rounded-lg bg-muted p-2.5 text-muted-foreground"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-sm">
          {data?.title ?? reference.title}
        </span>
        <span className="truncate text-muted-foreground text-xs">
          {deleted
            ? t("artifactDeleted")
            : `${ARTIFACT_KIND_NAMES[reference.kind]} · ${t("artifactVersion", { version: reference.version })}`}
        </span>
      </span>
    </>
  );
  const className = cn(
    "mb-4 flex w-full max-w-sm items-center gap-3 rounded-2xl border bg-background px-3 py-2.5 text-left",
    open && "border-ring/60 bg-muted/60",
  );
  if (deleted) return <div className={className}>{body}</div>;
  return (
    <Link
      to="/chat/$sessionId"
      params={{ sessionId }}
      search={{ artifact: reference.id, v: reference.version }}
      aria-current={open || undefined}
      className={cn(className, "transition-colors hover:bg-muted/60")}
    >
      {body}
    </Link>
  );
}

/** The artifact an artifact tool's answer names, or null for any other answer (an error). */
export function artifactReference(output: unknown): ArtifactReference | null {
  if (typeof output !== "string") return null;
  try {
    const parsed = JSON.parse(output) as {
      artifact?: Partial<ArtifactReference>;
    };
    const artifact = parsed.artifact;
    if (
      artifact &&
      typeof artifact.id === "string" &&
      typeof artifact.title === "string" &&
      ARTIFACT_KINDS.includes(artifact.kind as ArtifactKind) &&
      typeof artifact.version === "number"
    ) {
      return artifact as ArtifactReference;
    }
  } catch {
    // Not JSON: an error the tool reported.
  }
  return null;
}

/** A size for people: bytes, kB or MB. */
export function formatBytes(
  bytes: number,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
): string {
  if (bytes < 1000) return `${formatNumber(bytes)} B`;
  if (bytes < 1_000_000) {
    return `${formatNumber(bytes / 1000, { maximumFractionDigits: 1 })} kB`;
  }
  return `${formatNumber(bytes / 1_000_000, { maximumFractionDigits: 1 })} MB`;
}
