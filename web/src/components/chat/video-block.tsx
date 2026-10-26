import { useState } from "react";

/**
 * A ```videos block's players. Each is a poster with a play button: nothing
 * of YouTube's loads, and no request goes to it, until the person chooses to
 * play. The frame's address is built here from a validated video id, never
 * from the address the agent wrote, and the original link stays beside it.
 */

const YOUTUBE_ID = /^[\w-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

/** The id of the video a YouTube watch, youtu.be or shorts address names; else null. */
export function youtubeId(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.port
  ) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = /^\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    id =
      url.pathname === "/watch"
        ? url.searchParams.get("v")
        : (/^\/shorts\/([^/]+)\/?$/.exec(url.pathname)?.[1] ?? null);
  }
  return id !== null && YOUTUBE_ID.test(id) ? id : null;
}

/** The player's address, from an id `youtubeId` returned. */
export function embedAddress(id: string): string {
  return `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`;
}

/** The video's page, from an id `youtubeId` returned. */
function watchAddress(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

export function Video({ id, title }: { id: string; title?: string }) {
  const [playing, setPlaying] = useState(false);
  const label = title || "YouTube video";
  return (
    <figure className="min-w-0">
      <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-muted">
        {playing ? (
          <iframe
            src={embedAddress(id)}
            title={label}
            className="absolute inset-0 size-full border-0"
            sandbox="allow-scripts allow-same-origin allow-presentation"
            allow="encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        ) : (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={`Play video: ${label}`}
            className="absolute inset-0 flex size-full flex-col items-center justify-center gap-2 px-4 text-center transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span
              aria-hidden
              className="flex size-12 items-center justify-center rounded-full bg-foreground text-background"
            >
              ▶
            </span>
            <span className="line-clamp-2 font-medium">{label}</span>
            <span className="text-[13px] text-muted-foreground">
              Playing loads this video from YouTube, which may collect data
              about you.
            </span>
          </button>
        )}
      </div>
      <figcaption className="mt-1.5 text-[13px] text-muted-foreground">
        {playing && "Not playing? "}
        <a
          href={watchAddress(id)}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
        >
          Open on YouTube
        </a>
      </figcaption>
    </figure>
  );
}
