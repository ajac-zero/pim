"use client";

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

/**
 * Adapted from Vercel's AI Elements `Conversation`
 * (https://ai-sdk.dev/elements/components/conversation). Wraps
 * `use-stick-to-bottom` so the thread auto-scrolls while streaming, but
 * releases the lock as soon as the user scrolls away, and exposes a
 * "scroll to bottom" button when not pinned to the bottom. Resize tracking
 * is instant: large tool surfaces and several streamed items can otherwise
 * retarget the same spring before it settles and visibly stutter.
 */

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="instant"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-5 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="font-medium text-sm">{title}</h3>
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button> & {
  /**
   * Bottom offset in px, e.g. to clear a floating composer that overlaps
   * this conversation. Defaults to a plain `bottom-4` via `className` when
   * omitted.
   */
  bottomOffset?: number;
};

export const ConversationScrollButton = ({
  className,
  bottomOffset,
  style,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <Button
      className={cn(
        "absolute left-[50%] z-20 size-8 rounded-full shadow-md transition-all duration-200 ease-out",
        isAtBottom
          ? "pointer-events-none translate-x-[-50%] translate-y-2 scale-90 opacity-0"
          : "pointer-events-auto translate-x-[-50%] translate-y-0 scale-100 opacity-100",
        bottomOffset === undefined && "bottom-4",
        className,
      )}
      style={bottomOffset === undefined ? style : { bottom: bottomOffset, ...style }}
      onClick={handleScrollToBottom}
      size="icon"
      type="button"
      variant="outline"
      aria-hidden={isAtBottom}
      tabIndex={isAtBottom ? -1 : 0}
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
};
