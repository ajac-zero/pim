import { useState } from "react";
import { cn } from "~/lib/utils";

/**
 * An app's logo, as it is, on whatever it sits on; its initial on a tile
 * when it has none or the image doesn't load. Size it with `className`.
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
      <img
        src={icon}
        alt=""
        referrerPolicy="no-referrer"
        className={cn("shrink-0 rounded-[22%] object-contain", className)}
        onError={() => setBroken(true)}
      />
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
