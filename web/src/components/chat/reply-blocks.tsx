import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTheme } from "~/components/theme";
import { cn } from "~/lib/utils";

/**
 * Blocks an agent's message draws instead of showing as code. ```cards
 * and ```gallery fences are JSON arrays, drawn with the app's own
 * components: things it found, as rows with their images, and images in a
 * grid. A ```mermaid fence is a diagram, drawn in a sandboxed frame. Pim checks each block when the
 * message is sent and keeps copies of its images; the send's result maps
 * each image's address on the web to its copy here.
 */

/** Something a block shows, as the agent wrote it. */
type Item = {
  title?: string;
  url?: string;
  image?: string;
  meta?: string;
  text?: string;
  caption?: string;
};

/** The fences drawn here, and the field each of their items needs. */
const KINDS = { cards: "title", gallery: "image" } as const;
type Kind = keyof typeof KINDS;

export function isReplyBlock(language: string): language is Kind {
  return Object.hasOwn(KINDS, language);
}

type ReplyContext = {
  /** Each image's copy by its address on the web; null until the send's result comes. */
  images: Readonly<Record<string, string>> | null;
  streaming: boolean;
};

const Reply = createContext<ReplyContext>({ images: {}, streaming: false });

export function ReplyImages({
  images,
  streaming = false,
  children,
}: ReplyContext & { children: ReactNode }) {
  return (
    <Reply.Provider value={{ images, streaming }}>{children}</Reply.Provider>
  );
}

/** Where each image's copy is, from a `send_to_user` result. */
export function sentImages(output: unknown): Record<string, string> {
  if (typeof output !== "string") return {};
  try {
    const { images } = JSON.parse(output) as { images?: unknown };
    if (typeof images !== "object" || images === null) return {};
    return Object.fromEntries(
      Object.entries(images).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === "string" &&
          /^\/api\/images\/[\w-]+$/.test(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

const WEB_ADDRESS = /^https?:\/\//i;

function isItem(kind: Kind, value: unknown): value is Item {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item[KINDS[kind]] === "string" &&
    Object.values(item).every((field) => typeof field === "string")
  );
}

/**
 * The items of a JSON array, or of as much of one as is whole while it
 * streams in: each item shows once it's complete.
 */
function arrayItems(source: string): unknown[] | null {
  const whole = (text: string) => {
    try {
      const value: unknown = JSON.parse(text);
      return Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const done = whole(source);
  if (done) return done;
  for (
    let end = source.lastIndexOf("}");
    end > 0;
    end = source.lastIndexOf("}", end - 1)
  ) {
    const items = whole(`${source.slice(0, end + 1)}]`);
    if (items) return items;
  }
  return source.trimStart().startsWith("[") ? [] : null;
}

/** A fenced block drawn here; `fallback`, its code, when its source isn't one. */
export function ReplyBlock({
  kind,
  source,
  fallback,
}: {
  kind: Kind;
  source: string;
  fallback: ReactNode;
}) {
  const { images, streaming } = useContext(Reply);
  const items = arrayItems(source)?.filter((item) => isItem(kind, item)) ?? [];
  if (items.length === 0) return streaming ? <Placeholder /> : fallback;
  if (kind === "gallery") return <Gallery items={items} images={images} />;
  return (
    <div className="my-4 divide-y divide-border/60">
      {items.map((card, index) => (
        // Items have no ids: their order is all a block gives.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <CardRow key={index} card={card} images={images} />
      ))}
    </div>
  );
}

/** Images in a grid, two across, each with its caption, linking to the page it's from. */
function Gallery({
  items,
  images,
}: {
  items: Item[];
  images: ReplyContext["images"];
}) {
  // Once the copies are kept, an image Pim couldn't load is left out.
  const shown = images
    ? items.filter((item) => item.image && images[item.image])
    : items;
  if (shown.length === 0) return null;
  return (
    <div className={cn("my-4 grid gap-3", shown.length > 1 && "grid-cols-2")}>
      {shown.map((item, index) => {
        const copy = item.image ? images?.[item.image] : undefined;
        const picture = copy ? (
          <img
            src={copy}
            alt={item.caption ?? ""}
            className="aspect-[5/4] w-full rounded-2xl bg-muted object-cover"
          />
        ) : (
          <div className="aspect-[5/4] w-full animate-pulse rounded-2xl bg-muted" />
        );
        const link = item.url && WEB_ADDRESS.test(item.url) ? item.url : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: as for cards
          <figure key={index} className="min-w-0">
            {link ? (
              <a
                href={link}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={item.caption ?? new URL(link).hostname}
                className="block"
              >
                {picture}
              </a>
            ) : (
              picture
            )}
            {item.caption && (
              <figcaption className="mt-1.5 truncate text-[13px] text-muted-foreground">
                {item.caption}
              </figcaption>
            )}
          </figure>
        );
      })}
    </div>
  );
}

function Placeholder() {
  return <div className="my-4 h-24 animate-pulse rounded-2xl bg-muted" />;
}

function CardRow({
  card,
  images,
}: {
  card: Item;
  images: ReplyContext["images"];
}) {
  const link = card.url && WEB_ADDRESS.test(card.url) ? card.url : undefined;
  const host = link ? new URL(link).hostname.replace(/^www\./, "") : null;
  const image = card.image ? images?.[card.image] : undefined;
  const meta = [card.meta, host].filter(Boolean).join(" · ");
  return (
    <div className="flex gap-4 py-4 first:pt-0 last:pb-0">
      {image ? (
        <img
          src={image}
          alt=""
          className="size-20 shrink-0 rounded-xl bg-muted object-cover sm:size-24"
        />
      ) : (
        card.image &&
        images === null && (
          <div className="size-20 shrink-0 animate-pulse rounded-xl bg-muted sm:size-24" />
        )
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {link ? (
            <a
              href={link}
              target="_blank"
              rel="noreferrer noopener"
              className={cn(
                "underline decoration-muted-foreground/50 underline-offset-4 transition-colors",
                "hover:decoration-foreground",
              )}
            >
              {card.title}
            </a>
          ) : (
            card.title
          )}
        </p>
        {meta && (
          <p className="truncate text-[13px] text-muted-foreground">{meta}</p>
        )}
        {card.text && <p className="mt-1">{card.text}</p>}
      </div>
    </div>
  );
}

/** The page diagrams are drawn in (see `diagramPage` in src/artifacts.ts). */
const DIAGRAM_PAGE = "/api/diagram";
const MAX_DIAGRAM_HEIGHT = 2000;
/** At most this many height messages a second are taken, as for artifacts. */
const MAX_MESSAGES_PER_SECOND = 20;

/**
 * A ```mermaid block, drawn in a sandboxed frame of its own as Mermaid
 * artifacts are, never in the app's page: the app posts the frame its source
 * once the message is whole. One Mermaid can't draw shows as its source.
 */
export function Diagram({
  source,
  fallback,
}: {
  source: string;
  fallback: ReactNode;
}) {
  const { streaming } = useContext(Reply);
  const { resolved } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let windowStart = 0;
    let count = 0;
    const onMessage = (event: MessageEvent) => {
      // The origin of a sandboxed page is "null": only the source tells.
      if (!frame.current || event.source !== frame.current.contentWindow) {
        return;
      }
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (data?.type === "pim:diagram-failed") setFailed(true);
      if (
        data?.type !== "pim:diagram-height" ||
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
      setHeight(
        Math.min(Math.max(Math.ceil(data.height), 1), MAX_DIAGRAM_HEIGHT),
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const dark = resolved === "dark";
  const draw = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      { type: "pim:diagram", source, dark },
      "*",
    );
  }, [source, dark]);
  const loaded = useRef(false);
  // Drawn again in the other mode; the first time, once the page loads.
  useEffect(() => {
    if (loaded.current) draw();
  }, [draw]);

  if (streaming) return <Placeholder />;
  if (failed) return fallback;
  return (
    <iframe
      ref={frame}
      src={DIAGRAM_PAGE}
      sandbox="allow-scripts"
      title="Diagram"
      onLoad={() => {
        loaded.current = true;
        draw();
      }}
      // The page's background is transparent only in the app's own mode.
      style={{
        height: height ?? undefined,
        colorScheme: dark ? "dark" : "light",
      }}
      className={cn(
        "my-4 block w-full border-0",
        height === null && "h-24 animate-pulse rounded-2xl bg-muted",
      )}
    />
  );
}
