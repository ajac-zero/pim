import amp from "~/assets/harness/amp.svg";
import claudeCode from "~/assets/harness/claude-code.svg";
import codex from "~/assets/harness/codex.svg";
import mistralVibe from "~/assets/harness/mistral-vibe.svg";
import pi from "~/assets/harness/pi.svg";
import { type CodingHarness, HARNESS_NAMES } from "~/lib/coding";
import { cn } from "~/lib/utils";

/* Each harness's own logo; their sources and licenses are in `assets/harness/README.md`. */
const LOGOS: Record<CodingHarness, string> = {
  pi,
  "claude-code": claudeCode,
  codex,
  "mistral-vibe": mistralVibe,
  amp,
};

/**
 * A coding harness's logo on a rounded tile, framed like an agent's icon in
 * the sidebar. The tile stays light in both themes, so the logos, which have
 * fixed brand colors, read the same in each.
 */
export function HarnessIcon({
  harness,
  className,
}: {
  harness: CodingHarness;
  className?: string;
}) {
  return (
    <span
      data-harness={harness}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-black/10",
        className,
      )}
    >
      <img
        src={LOGOS[harness]}
        alt={HARNESS_NAMES[harness]}
        className="size-[68%] object-contain"
      />
    </span>
  );
}
