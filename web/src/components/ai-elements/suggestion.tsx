"use client";

import type { ComponentProps, MouseEvent } from "react";
import { useCallback } from "react";
import { Button } from "~/components/ui/button";
import { ScrollArea, ScrollBar } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";

export type SuggestionsProps = ComponentProps<typeof ScrollArea>;

export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <ScrollArea
    className={cn(
      "w-full overflow-x-auto whitespace-nowrap [mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%_-_1rem),transparent)] [-webkit-mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%_-_1rem),transparent)]",
      className,
    )}
    {...props}
  >
    {/* Room inside the scrolling viewport for the chips' shadows. */}
    <div className="flex w-max flex-nowrap items-center gap-2 px-1 py-3">
      {children}
    </div>
    <ScrollBar className="hidden" orientation="horizontal" />
  </ScrollArea>
);

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  /** Called with whether ⌘ or Ctrl was held, which asks to edit the text rather than send it. */
  onClick?: (suggestion: string, edit: boolean) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
  variant = "secondary",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = useCallback(
    (event: MouseEvent) => {
      onClick?.(suggestion, event.metaKey || event.ctrlKey);
    },
    [onClick, suggestion],
  );

  return (
    <Button
      className={cn("cursor-pointer rounded-full px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
};
