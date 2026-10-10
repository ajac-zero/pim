import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Download,
  FileCode2,
  FileText,
  Maximize2,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import {
  ApiError,
  type ArtifactKind,
  type ArtifactReference,
  artifactDownloadUrl,
  artifactFrameUrl,
} from "~/lib/pim-api";
import { artifactQuery, artifactVersionQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The one message an artifact may send: its height. Anything else is ignored. */
const HEIGHT_MESSAGE = "pim:artifact-height";
const MIN_HEIGHT = 80;
/** At most this many height messages a second are taken; a page that sends more is left as it is. */
const MAX_MESSAGES_PER_SECOND = 20;

/**
 * An HTML artifact's version, in a sandboxed frame. The page it loads gets an
 * opaque origin from its own response (and from `sandbox`, again here): it
 * can't reach this app's cookies, storage or API. The frame only listens for
 * the page's height, from this frame and no other window, and sends it
 * nothing. If the page navigates itself away, it's taken down: that's how an
 * artifact could send what it shows, or what someone typed, elsewhere.
 */
export function ArtifactFrame({
  id,
  version,
  title,
  maxHeight = 360,
  fill = false,
  className,
}: {
  id: string;
  version: number;
  title: string;
  /** The tallest it grows to its page's height; ignored when `fill`. */
  maxHeight?: number;
  /** Fills its container instead of following its page's height. */
  fill?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const [left, setLeft] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Loads of the frame now shown; a new version or a retry starts again.
  const loads = useRef({ key: "", count: 0 });
  const key = `${id}:${version}:${attempt}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version is a new page, not one that left
  useEffect(() => {
    setLeft(false);
  }, [id, version]);

  useEffect(() => {
    let windowStart = 0;
    let count = 0;
    const onMessage = (event: MessageEvent) => {
      // The origin of a sandboxed page is "null" whoever sent it: only the source tells.
      if (!frame.current || event.source !== frame.current.contentWindow) {
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
    <iframe
      key={key}
      ref={frame}
      title={title}
      src={artifactFrameUrl(id, version)}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      loading="lazy"
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
  );
}

/** A version of an artifact, shown as it runs (HTML) or reads (Markdown). */
export function ArtifactPreview({
  id,
  version,
  kind,
  title,
  fill,
  maxHeight,
}: {
  id: string;
  version: number;
  kind: ArtifactKind;
  title: string;
  fill?: boolean;
  maxHeight?: number;
}) {
  if (kind === "html") {
    return (
      <ArtifactFrame
        id={id}
        version={version}
        title={title}
        fill={fill}
        maxHeight={maxHeight}
      />
    );
  }
  return (
    <MarkdownArtifact
      id={id}
      version={version}
      fill={fill}
      maxHeight={maxHeight}
    />
  );
}

function MarkdownArtifact({
  id,
  version,
  fill,
  maxHeight = 360,
}: {
  id: string;
  version: number;
  fill?: boolean;
  maxHeight?: number;
}) {
  const { t } = useI18n();
  const { data, error } = useQuery(artifactVersionQuery(id, version));
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
      <Markdown text={data.content} untrusted />
    </div>
  );
}

/** Says, next to an artifact, who made it and what it can still do. */
export function ArtifactCaution({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-muted-foreground text-xs",
        className,
      )}
    >
      <ShieldAlert className="mt-px size-3.5 shrink-0" />
      {t("artifactCaution")}
    </p>
  );
}

export function ArtifactIcon({
  kind,
  className,
}: {
  kind: ArtifactKind;
  className?: string;
}) {
  return kind === "html" ? (
    <FileCode2 className={className} />
  ) : (
    <FileText className={className} />
  );
}

/**
 * An artifact version the agent made in a chat: its title and version, a
 * preview, and ways to open or download it. The version stays the one this
 * call made, so a chat shows how the artifact changed.
 */
export function ArtifactCard({ reference }: { reference: ArtifactReference }) {
  const { t } = useI18n();
  const { data, error } = useQuery(artifactQuery(reference.id));
  const deleted = error instanceof ApiError && error.status === 404;
  return (
    <div className="mb-4 w-full overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ArtifactIcon
          kind={reference.kind}
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {data?.title ?? reference.title}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs">
          {t("artifactVersion", { version: reference.version })}
        </span>
        {!deleted && (
          <>
            <Button asChild size="icon" variant="ghost" className="size-8">
              <a
                href={artifactDownloadUrl(reference.id, reference.version)}
                download
                aria-label={t("download")}
              >
                <Download className="size-4" />
              </a>
            </Button>
            <Button asChild size="sm" variant="outline" className="h-8">
              <Link
                to="/artifacts/$artifactId"
                params={{ artifactId: reference.id }}
                search={{ v: reference.version }}
              >
                <Maximize2 className="size-3.5" />
                {t("open")}
              </Link>
            </Button>
          </>
        )}
      </div>
      <div className="p-3">
        {deleted ? (
          <p className="text-muted-foreground text-sm">
            {t("artifactDeleted")}
          </p>
        ) : (
          <>
            <ArtifactPreview
              id={reference.id}
              version={reference.version}
              kind={reference.kind}
              title={reference.title}
            />
            <ArtifactCaution className="mt-2" />
          </>
        )}
      </div>
    </div>
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
      (artifact.kind === "html" || artifact.kind === "markdown") &&
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
