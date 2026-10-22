import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { AlertCircle, ChevronDown, RotateCcw } from "~/components/icons";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import {
  pim,
  type ToolPermission,
  type ToolPermissionInfo,
} from "~/lib/pim-api";
import { permissionsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * Off, Ask or On for each tool, grouped by app, Pim's own first: for you,
 * or, given `circle`, for the people in that circle.
 */
export function ToolPermissionList({ circle }: { circle?: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: tools } = useQuery(permissionsQuery(circle));
  const set = useMutation({
    mutationFn: ({
      info,
      permission,
    }: {
      info: ToolPermissionInfo;
      permission: ToolPermission | null;
    }) => pim.setPermission(circle ?? null, info.app, info.tool, permission),
    onSuccess: (next) =>
      queryClient.setQueryData<ToolPermissionInfo[]>(
        ["permissions", circle ?? null],
        (all) =>
          all?.map((info) =>
            info.app === next.app && info.tool === next.tool ? next : info,
          ),
      ),
    onError: (error) => toast.error(error.message),
  });

  if (!tools) return null;
  const groups = new Map<string, ToolPermissionInfo[]>();
  for (const info of tools) {
    const key = info.app ?? "";
    groups.set(key, [...(groups.get(key) ?? []), info]);
  }
  const busy = (info: ToolPermissionInfo) =>
    set.isPending &&
    set.variables?.info.app === info.app &&
    set.variables.info.tool === info.tool;

  return (
    <div className="space-y-3">
      {[...groups.entries()].map(([app, infos]) => (
        <Collapsible
          key={app}
          defaultOpen={infos.length <= 10}
          className="overflow-hidden rounded-2xl border bg-muted/20"
        >
          <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left">
            <span className="min-w-0 flex-1 truncate font-medium text-sm">
              {infos[0]?.appName ?? t("pimTools")}
            </span>
            <span className="text-muted-foreground text-xs">
              {t("toolCount", { count: infos.length })}
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul
              className="divide-y border-t"
              aria-label={infos[0]?.appName ?? t("pimTools")}
            >
              {infos.map((info) => (
                <ToolPermissionRow
                  key={info.tool}
                  info={info}
                  forCircle={circle !== undefined}
                  pending={busy(info)}
                  onChoose={(permission) => set.mutate({ info, permission })}
                />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

function ToolPermissionRow({
  info,
  forCircle,
  pending,
  onChoose,
}: {
  info: ToolPermissionInfo;
  forCircle: boolean;
  pending: boolean;
  onChoose: (permission: ToolPermission | null) => void;
}) {
  const { t } = useI18n();
  const labels: Record<ToolPermission, string> = {
    off: t("permissionOff"),
    ask: t("permissionAsk"),
    on: t("permissionOn"),
  };
  const label = info.tool;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <span className="min-w-0 flex-1 basis-48">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-sm">{label}</span>
          {info.readOnly && info.app !== null && (
            <span className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground">
              {t("readOnlyTool")}
            </span>
          )}
        </span>
        {info.description && (
          <span
            className="block truncate text-muted-foreground text-xs"
            title={info.description}
          >
            {info.description}
          </span>
        )}
        {info.changed && (
          <span className="mt-1 flex items-start gap-1.5 text-muted-foreground text-xs">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {t(forCircle ? "toolChangedCircle" : "toolChanged")}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1">
        {info.chosen !== null && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("useDefaultPermission", { tool: label })}
            title={t("useDefaultPermission", { tool: label })}
            onClick={() => onChoose(null)}
            disabled={pending}
          >
            <RotateCcw />
          </Button>
        )}
        <span
          role="group"
          aria-label={t("permissionFor", { tool: label })}
          className="inline-flex rounded-full border bg-background p-0.5"
        >
          {info.choices.map((choice) => {
            const selected = info.permission === choice;
            return (
              <button
                key={choice}
                type="button"
                aria-pressed={selected}
                disabled={pending}
                onClick={() =>
                  // Choosing the setting already shown confirms it: after a change, it trusts the new version.
                  (!selected || info.changed) && onChoose(choice)
                }
                className={cn(
                  "rounded-full px-3 py-1.5 text-[13px] transition-colors disabled:opacity-60",
                  selected
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {labels[choice]}
              </button>
            );
          })}
        </span>
      </span>
    </li>
  );
}
