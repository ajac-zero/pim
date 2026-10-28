import { type ReactNode, useEffect, useState } from "react";
import type { AuthSession } from "~/lib/auth";

/** The banner is 1.75rem (h-7) tall; the calc() classes below take that from the pages' full-height layouts. */
const HEIGHT = "1.75rem";

/**
 * What the banner says. The mode's name is not translated: the warning
 * must read the same to everyone, and to an agent reading the page.
 */
export function agentPreviewText(
  preview: AuthSession["agentPreview"],
  now: number,
): string | null {
  if (!preview?.enabled) return null;
  const base = "UNSAFE PREVIEW — agent access enabled";
  if (typeof preview.expiresAt !== "number") return base;
  if (preview.expiresAt <= now) return `${base} · automation session expired`;
  const ends = new Date(preview.expiresAt).toISOString().slice(11, 16);
  return `${base} · automation session ends ${ends} UTC`;
}

/**
 * Shows the unsafe agent-driven preview's banner over every page, signed in
 * or not, while the Worker says the mode is on, and leaves everything else
 * exactly as it is when it doesn't. The page below gives up the banner's
 * height, so nothing is covered.
 */
export function AgentPreviewBanner({
  preview,
  now,
  children,
}: {
  preview: AuthSession["agentPreview"];
  /** Unix milliseconds; the current time unless a test sets it. */
  now?: number;
  children: ReactNode;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const expires = typeof preview?.expiresAt === "number";
  useEffect(() => {
    if (!expires) return;
    const timer = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [expires]);
  const text = agentPreviewText(preview, now ?? tick);
  if (!text) return children;
  return (
    <div className="flex h-svh flex-col [&_.h-dvh]:h-[calc(100dvh-1.75rem)] [&_.h-svh]:h-[calc(100svh-1.75rem)] [&_.min-h-svh]:min-h-[calc(100svh-1.75rem)]">
      <div
        role="alert"
        data-agent-preview-banner
        className="flex shrink-0 items-center justify-center bg-destructive px-3 text-center font-semibold text-white text-xs tracking-wide"
        style={{ height: HEIGHT }}
      >
        {text}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
