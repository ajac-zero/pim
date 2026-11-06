"use client";

import { ArrowDownRight } from "lucide-react";
import type { ComponentProps, MouseEvent } from "react";
import { useCallback } from "react";
import { cn } from "~/lib/utils";

export type SuggestionsProps = ComponentProps<"div">;

/** A short list of follow-ups, one per line, in the style of Grok's. */
export const Suggestions = ({
  className,
  children,
  ...props
}: SuggestionsProps) => (
  <div className={cn("-mt-4 flex flex-col items-start", className)} {...props}>
    {children}
  </div>
);

export type SuggestionProps = Omit<ComponentProps<"button">, "onClick"> & {
  suggestion: string;
  /** Called with whether ⌘ or Ctrl was held, which asks to edit the text rather than send it. */
  onClick?: (suggestion: string, edit: boolean) => void;
};

export const Suggestion = ({
  suggestion,
  onClick,
  className,
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
    <button
      className={cn(
        "-ml-2 flex max-w-full text-[15px] cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-muted-foreground transition-colors hover:text-foreground",
        className,
      )}
      onClick={handleClick}
      type="button"
      {...props}
    >
      <ArrowDownRight className="size-4 shrink-0 opacity-60" />
      <span className="truncate">{children || suggestion}</span>
    </button>
  );
};
