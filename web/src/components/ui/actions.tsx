import type { ComponentProps } from "react";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Adapted from AI Elements' Message component
 * (https://ai-sdk.dev/elements/components/message), which bundles
 * MessageActions/MessageAction alongside Message, MessageBranch*,
 * MessageAttachment*, and MessageResponse.
 *
 * Only the actions-row pieces are pulled out here (renamed Actions/Action,
 * dropping the Message- prefix since we don't use the rest of that bundle):
 * this app has its own message bubble components in items.tsx that don't
 * match AI Elements' avatar-bearing Message shape, and the full bundle
 * depends on the "ai" package for UIMessage/FileUIPart types we've
 * deliberately avoided adding elsewhere in this app.
 */

export type ActionsProps = ComponentProps<"div">;

export const Actions = ({ className, children, ...props }: ActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type ActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const Action = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon",
  ...props
}: ActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};
