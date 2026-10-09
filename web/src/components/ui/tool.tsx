import {
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps } from "react";
import { Badge } from "~/components/ui/badge";
import { useI18n } from "~/components/i18n";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { CodeBlock } from "~/components/ui/code-block";
import { cn } from "~/lib/utils";

/**
 * Adapted from AI Elements' Tool
 * (https://ai-sdk.dev/elements/components/tool). Upstream types this
 * around the "ai" package's ToolUIPart (state: "input-streaming" |
 * "input-available" | "approval-requested" | ... | "output-error" |
 * "output-denied"), which doesn't apply here -- this app's OR function
 * calls (see FunctionCallItem/FunctionCallOutputItem in
 * ~/lib/openresponses) only ever reach "pending" (no output yet, not
 * currently streaming), "running" (streaming, no output yet),
 * "completed" (output present) or "error" (the tool failed), so ToolState
 * below is a plain 4-value
 * union derived from that instead of the imported "ai" type. This also
 * means no new dependency on the "ai" package. ToolInput/ToolOutput
 * render through this app's own CodeBlock (~/components/ui/code-block)
 * rather than a duplicate copy of AI Elements' code-block.
 */

export type ToolState = "pending" | "running" | "completed" | "error";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "w-full overflow-hidden rounded-xl border bg-card",
      className,
    )}
    {...props}
  />
);

export type ToolHeaderProps = {
  title: string;
  state: ToolState;
  className?: string;
};

const stateBadge: Record<
  ToolState,
  { labelKey: "pending" | "running" | "completed" | "failed"; icon: React.ReactNode }
> =
  {
    pending: {
      labelKey: "pending",
      icon: <ClockIcon className="size-3.5" />,
    },
    running: {
      labelKey: "running",
      icon: <ClockIcon className="size-3.5 animate-pulse" />,
    },
    completed: {
      labelKey: "completed",
      icon: <CheckCircleIcon className="size-3.5 text-green-600" />,
    },
    error: {
      labelKey: "failed",
      icon: <XCircleIcon className="size-3.5 text-destructive" />,
    },
  };

export const ToolHeader = ({ className, title, state }: ToolHeaderProps) => {
  const { t } = useI18n();
  const badge = stateBadge[state];
  return (
    <CollapsibleTrigger
      className={cn(
        "group flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-sm transition-colors hover:bg-accent/50",
        className,
      )}
    >
      <WrenchIcon
        className={cn(
          "size-4 text-muted-foreground",
          state === "running" && "animate-pulse",
        )}
      />
      <span className="font-mono font-medium">{title}</span>
      <Badge className="gap-1 rounded-full text-xs" variant="secondary">
        {badge.icon}
        {t(badge.labelKey)}
      </Badge>
      <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "space-y-3 border-t px-3.5 py-3",
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: string;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const { t } = useI18n();
  return (
    <div className={cn(className)} {...props}>
      <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t("arguments")}
      </div>
      <div className="overflow-hidden rounded-lg bg-muted">
        <CodeBlock code={input} language="json" />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: string | null;
};

export const ToolOutput = ({
  className,
  output,
  ...props
}: ToolOutputProps) => {
  const { t } = useI18n();
  if (output === null) return null;

  return (
    <div className={cn(className)} {...props}>
      <div className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t("result")}
      </div>
      <div className="max-h-64 overflow-auto rounded-lg bg-muted">
        <CodeBlock code={output} language="json" />
      </div>
    </div>
  );
};
