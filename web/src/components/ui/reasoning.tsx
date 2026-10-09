import { useControllableState } from "radix-ui/internal";
import type { ComponentProps, ReactNode } from "react";
import { createContext, memo, useContext, useEffect, useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { Markdown } from "~/components/chat/markdown";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { cn } from "~/lib/utils";
import { useI18n } from "~/components/i18n";

/**
 * Adapted from AI Elements' Reasoning
 * (https://ai-sdk.dev/elements/components/reasoning). Two changes from
 * upstream to fit this app:
 *
 * - useControllableState comes from "radix-ui/internal" instead of the
 *   standalone "@radix-ui/react-use-controllable-state" package: this app
 *   already depends on the unified "radix-ui" meta-package (see
 *   collapsible.tsx), which re-exports the same hook, so no new dependency
 *   is needed.
 * - ReasoningContent renders through this app's own Markdown component
 *   (~/components/chat/markdown) instead of Streamdown directly, so
 *   reasoning text gets the same themed/copyable CodeBlock rendering as
 *   every other markdown surface in this app (see markdown.tsx) rather
 *   than Streamdown's raw, un-styled defaults.
 * - The default "Thinking..." trigger label uses a plain animate-pulse
 *   span instead of upstream's Shimmer sub-component, which depends on
 *   the "motion" package — a real new dependency this app doesn't
 *   otherwise need, just for one label's animation.
 */

type ReasoningContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration: number | undefined;
};

const ReasoningContext = createContext<ReasoningContextValue | null>(null);

export const useReasoning = () => {
  const context = useContext(ReasoningContext);
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning");
  }
  return context;
};

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  duration?: number;
};

const MS_IN_S = 1000;

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen = true,
    onOpenChange,
    duration: durationProp,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen,
      onChange: onOpenChange,
    });
    const [duration, setDuration] = useControllableState({
      prop: durationProp,
      defaultProp: undefined as number | undefined,
    });

    const [startTime, setStartTime] = useState<number | null>(null);

    // Track duration when streaming starts and ends
    useEffect(() => {
      if (isStreaming) {
        if (startTime === null) {
          setStartTime(Date.now());
        }
      } else if (startTime !== null) {
        setDuration(Math.ceil((Date.now() - startTime) / MS_IN_S));
        setStartTime(null);
      }
    }, [isStreaming, startTime, setDuration]);

    // No auto-close: whether a block starts open or collapsed (via
    // `defaultOpen`) is its permanent state until the user manually
    // toggles it — see ReasoningBlock, which derives `defaultOpen` from
    // the "show reasoning" preference. Auto-closing after a fixed delay
    // used to fight with long-running reasoning (delay too short to
    // read) and fast ones (delay pointlessly outlives the rest of the
    // turn) alike, so the default state now simply is the desired state.

    return (
      <ReasoningContext.Provider
        value={{ isStreaming, isOpen: isOpen ?? true, setIsOpen, duration }}
      >
        <Collapsible
          className={cn("not-prose", className)}
          onOpenChange={setIsOpen}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    );
  },
);

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const { t } = useI18n();
    const { isStreaming, isOpen, duration } = useReasoning();
    const defaultThinkingMessage = (streaming: boolean, elapsed?: number) => {
      if (streaming || elapsed === 0) {
        return <span className="animate-pulse">{t("thinking")}</span>;
      }
      if (elapsed === undefined) return <span>{t("thoughtProcess")}</span>;
      return (
        <span>
          {t("thoughtForSeconds", {
            duration: elapsed,
            suffix: elapsed === 1 ? "" : "s",
          })}
        </span>
      );
    };

    return (
      <CollapsibleTrigger
        className={cn(
          "flex items-center gap-1.5 text-muted-foreground text-sm transition-colors hover:text-foreground",
          className,
        )}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-3.5" />
            {(getThinkingMessage ?? defaultThinkingMessage)(
              isStreaming,
              duration,
            )}
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                isOpen ? "rotate-180" : "rotate-0",
              )}
            />
          </>
        )}
      </CollapsibleTrigger>
    );
  },
);

export type ReasoningContentProps = Omit<
  ComponentProps<typeof CollapsibleContent>,
  "children"
> & {
  children: string;
};

export const ReasoningContent = memo(
  ({ className, children, ...props }: ReasoningContentProps) => (
    <CollapsibleContent
      className={cn(
        "mt-2 border-border border-l-2 pl-4 text-muted-foreground text-sm",
        "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
        className,
      )}
      {...props}
    >
      <Markdown text={children} className="text-sm leading-6" />
    </CollapsibleContent>
  ),
);

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
