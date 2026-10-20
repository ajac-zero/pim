import { createContext, type ReactNode, useContext } from "react";
import { cn } from "~/lib/utils";

/**
 * Blocks an agent's message draws with the app's own components instead of
 * as code: a ```cards fence is a JSON array of things it found. Pim checks
 * each block when the message is sent and keeps copies of its images; the
 * send's result maps each image's address on the web to its copy here.
 */

/** Something a message shows it found, as the agent wrote it. */
type Card = {
  title: string;
  url?: string;
  image?: string;
  meta?: string;
  text?: string;
};

/** The languages of the fences drawn here. */
export const REPLY_BLOCKS = new Set(["cards"]);

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

function isCard(value: unknown): value is Card {
  const card = value as Card | null;
  return (
    typeof card === "object" &&
    card !== null &&
    typeof card.title === "string" &&
    (["url", "image", "meta", "text"] as const).every(
      (key) => card[key] === undefined || typeof card[key] === "string",
    )
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
  source,
  fallback,
}: {
  source: string;
  fallback: ReactNode;
}) {
  const { images, streaming } = useContext(Reply);
  const cards = arrayItems(source)?.filter(isCard) ?? [];
  if (cards.length === 0) return streaming ? <Placeholder /> : fallback;
  return (
    <div className="my-4 divide-y divide-border/60">
      {cards.map((card, index) => (
        // Cards have no ids: their order is all a block gives.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <CardRow key={index} card={card} images={images} />
      ))}
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
  card: Card;
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
