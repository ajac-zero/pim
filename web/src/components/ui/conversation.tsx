"use client";

import { ArrowDownIcon, AtSign } from "~/components/icons";
import type { ComponentProps, ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
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
    // Scrollable from its first render, rather than once `StickToBottom`'s
    // own effect runs, so effects inside it can set where it's scrolled to.
    scrollClassName="overflow-auto"
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
  /** A button beside this one, shown only while it has somewhere to go. */
  mention?: ReactNode;
};

export const ConversationScrollButton = ({
  className,
  bottomOffset,
  style,
  mention,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <div
      className={cn(
        "pointer-events-none absolute left-[50%] z-20 flex translate-x-[-50%] gap-2",
        bottomOffset === undefined && "bottom-4",
      )}
      style={bottomOffset === undefined ? undefined : { bottom: bottomOffset }}
    >
      {mention}
      <Button
        className={cn(
          "size-8 rounded-full shadow-md transition-all duration-200 ease-out",
          isAtBottom
            ? "pointer-events-none translate-y-2 scale-90 opacity-0"
            : "pointer-events-auto translate-y-0 scale-100 opacity-100",
          // Out of the row while hidden, so a mention button alone is centered.
          isAtBottom && "absolute",
          className,
        )}
        style={style}
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
    </div>
  );
};

/** The mentions the person has had in view on this page, by the key their messages carry. */
const seenMentions = new Set<string>();

/**
 * Goes to the next message that mentions the person (the conversation's
 * `[data-mention]` elements) below what is on screen, as a mention button
 * does in a messaging app. A mention that has been on screen is read: it no
 * longer counts. `changes` is anything that changes what the conversation
 * holds, so the button looks again.
 */
export const ConversationMentionButton = ({
  label,
  changes,
}: {
  label: string;
  changes: unknown;
}) => {
  const { scrollRef, contentRef } = useStickToBottomContext();
  const [target, setTarget] = useState<HTMLElement | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `changes` is what makes it look again.
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller) return;
    const look = () => {
      const view = scroller.getBoundingClientRect();
      let next: HTMLElement | null = null;
      for (const element of scroller.querySelectorAll<HTMLElement>(
        "[data-mention]",
      )) {
        const key = element.dataset.mention ?? "";
        const box = element.getBoundingClientRect();
        if (box.bottom > view.top && box.top < view.bottom) {
          seenMentions.add(key);
        } else if (box.top >= view.bottom && !seenMentions.has(key)) {
          next ??= element;
        }
      }
      setTarget(next);
    };
    look();
    scroller.addEventListener("scroll", look, { passive: true });
    const resize = new ResizeObserver(look);
    if (content) resize.observe(content);
    resize.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", look);
      resize.disconnect();
    };
  }, [scrollRef, contentRef, changes]);

  if (!target) return null;
  return (
    <Button
      className="pointer-events-auto size-8 rounded-full shadow-md"
      onClick={() => target.scrollIntoView({ behavior: "smooth", block: "center" })}
      size="icon"
      type="button"
      variant="outline"
      aria-label={label}
      title={label}
    >
      <AtSign className="size-4" />
    </Button>
  );
};
