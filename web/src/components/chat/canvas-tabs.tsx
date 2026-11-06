import { useQuery } from "@tanstack/react-query";
import { isFilePath } from "~/lib/canvas";
import { baseName } from "~/lib/files";
import { artifactQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

function TabName({ tab }: { tab: string }) {
  const { data } = useQuery({
    ...artifactQuery(tab),
    enabled: !isFilePath(tab),
  });
  return isFilePath(tab) ? baseName(tab) : (data?.title ?? "…");
}

/** The files and apps open in the canvas together, as tabs that take the place of a title. */
export function CanvasTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: string[];
  active: string;
  onSelect: (tab: string) => void;
}) {
  return (
    <div
      role="tablist"
      className="flex min-w-0 flex-1 overflow-x-auto scrollbar-thin"
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={tab === active}
          title={isFilePath(tab) ? tab : undefined}
          onClick={() => onSelect(tab)}
          className={cn(
            "h-12 max-w-48 shrink-0 truncate border-b-2 px-3 pt-0.5 text-sm",
            tab === active
              ? "border-foreground font-medium"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          <TabName tab={tab} />
        </button>
      ))}
    </div>
  );
}
