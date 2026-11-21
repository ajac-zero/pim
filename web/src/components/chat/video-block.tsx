import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * A ```videos block's players. Each is a poster with a play button: nothing
 * of YouTube's, or of the site a video file is on, loads, and no request goes
 * to it, until the person chooses to play. A YouTube frame's address is built
 * here from a validated video id, never from the address the agent wrote, and
 * the original link stays beside it.
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

/** The address of a video file an `https` address names, by its extension, or null for any other address. The player loads it only when the person chooses. */
export function videoFileAddress(address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return /\.(?:mp4|webm|m4v|mov)$/i.test(url.pathname) ? url.href : null;
}

/**
 * A poster with a play button, and the original link beside it. Nothing of the
 * provider loads until the person plays: then `player` replaces the poster.
 */
function ClickToPlay({
  label,
  notice,
  href,
  linkText,
  player,
}: {
  label: string;
  notice: string;
  href: string;
  linkText: string;
  player: ReactNode;
}) {
  const [playing, setPlaying] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  // The button is gone once the player replaces it: keep keyboard focus in the page.
  useEffect(() => {
    if (playing)
      frame.current?.querySelector<HTMLElement>("iframe, video")?.focus();
  }, [playing]);
  return (
    <figure className="min-w-0">
      <div
        ref={frame}
        className="relative aspect-video w-full overflow-hidden rounded-2xl bg-muted"
      >
        {playing ? (
          player
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
            <span className="text-[13px] text-muted-foreground">{notice}</span>
          </button>
        )}
      </div>
      <figcaption className="mt-1.5 text-[13px] text-muted-foreground">
        {playing && "Not playing? "}
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
        >
          {linkText}
        </a>
      </figcaption>
    </figure>
  );
}

export function Video({ id, title }: { id: string; title?: string }) {
  const label = title || "YouTube video";
  return (
    <ClickToPlay
      label={label}
      notice="Playing loads this video from YouTube, which may collect data about you."
      href={watchAddress(id)}
      linkText="Open on YouTube"
      player={
        <iframe
          src={embedAddress(id)}
          title={label}
          className="absolute inset-0 size-full border-0"
          sandbox="allow-scripts allow-same-origin allow-presentation"
          allow="encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      }
    />
  );
}

/** A video file on the web, from an address `videoFileAddress` returned: the browser's own player, loaded only once played. */
export function FileVideo({
  address,
  title,
}: {
  address: string;
  title?: string;
}) {
  const host = new URL(address).hostname;
  const label = title || "Video";
  return (
    <ClickToPlay
      label={label}
      notice={`Playing loads this video from ${host}, which can see your address.`}
      href={address}
      linkText={`Open on ${host}`}
      player={
        // biome-ignore lint/a11y/useMediaCaption: a video an agent found has no caption track.
        <video
          src={address}
          title={label}
          controls
          autoPlay
          playsInline
          className="absolute inset-0 size-full bg-black"
        />
      }
    />
  );
}
