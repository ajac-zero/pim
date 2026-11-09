import type { ComponentProps, ReactNode } from "react";
import { ChevronRight } from "~/components/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";

/** The classes of a plain row in the options box: a muted line that darkens on hover. */
export const BOX_ROW =
  "flex w-full items-center gap-2 px-4 py-3 text-left text-[13px] text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

/** A part of the options box that folds: a muted line that ends in a chevron, and what it holds below. */
export function BoxSection({
  label,
  children,
  ...props
}: { label: ReactNode } & Omit<
  ComponentProps<typeof Collapsible>,
  "children"
> & { children: ReactNode }) {
  return (
    <Collapsible {...props}>
      <h2>
        <CollapsibleTrigger className={`group ${BOX_ROW}`}>
          {label}
          <ChevronRight className="ml-auto transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
      </h2>
      <CollapsibleContent className="px-4 pb-4 text-sm">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
