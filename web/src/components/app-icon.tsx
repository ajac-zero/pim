import { useState } from "react";
import { cn } from "~/lib/utils";

/**
 * An app's logo on a white tile, as brands draw theirs for light
 * backgrounds; its initial when it has none or the image doesn't load.
 * Size it with `className`; the tile rounds, and the logo fills it, in proportion.
 */
export function AppIcon({
  name,
  icon,
  className,
}: {
  name: string;
  icon: string | null | undefined;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  if (icon && !broken) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-[22%] border bg-white",
          className,
        )}
      >
        <img
          src={icon}
          alt=""
          referrerPolicy="no-referrer"
          className="size-[66%] object-contain"
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[22%] bg-muted font-medium text-muted-foreground uppercase",
        className,
      )}
    >
      {name.trim().charAt(0)}
    </span>
  );
}
