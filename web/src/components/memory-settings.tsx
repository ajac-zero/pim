import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  type Agent,
  type Circle,
  type MemoryScopeInfo,
  pim,
} from "~/lib/pim-api";
import { agentsQuery } from "~/lib/queries";

export const memoryQuery = () => ({
  queryKey: ["memory"],
  queryFn: pim.memory,
});

function useScopeLabel() {
  const { t } = useI18n();
  const { data: agents = [] } = useQuery(agentsQuery());
  const majordomo = agents.find((agent) => agent.majordomo);
  return (scope: MemoryScopeInfo) =>
    scope.kind === "private"
      ? t("memoryOnly", { name: majordomo?.name ?? "Pim" })
      : scope.kind === "everyone"
        ? t("memoryEveryone")
        : scope.kind === "former"
          ? t("memoryFormer")
          : scope.kind === "agent"
            ? t("memoryAgentOwn", { names: scope.name ?? scope.key })
            : (scope.name ?? scope.key);
}

/** Scopes an agent reads are saved together with its other details. */
export function AgentMemoryField({
  agent,
  value,
  onChange,
}: {
  agent: Agent;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const { t } = useI18n();
  const { data, error } = useQuery(memoryQuery());
  return (
    <fieldset className="space-y-3">
      <legend>{t("memory")}</legend>
      {agent.majordomo ? (
        <p className="text-muted-foreground text-sm">{t("memoryEveryScope")}</p>
      ) : (
        <>
          <ScopeChecks
            scopes={[
              { key: agent.memoryScope, name: t("memoryItsOwn") },
              { key: "everyone", name: t("memoryEveryone") },
            ]}
            value={[agent.memoryScope, "everyone"]}
            disabled
          />
          {error ? (
            <p role="alert">{error.message}</p>
          ) : !data ? (
            <p>{t("loading")}</p>
          ) : (
            <>
              <ScopeChecks
                scopes={data.scopes.filter((scope) => scope.kind === "named")}
                value={value}
                onChange={onChange}
              />
              {!data.scopes.some((scope) => scope.kind === "named") && (
                <p className="text-muted-foreground text-sm">
                  {t("memoryNoNamed")}
                </p>
              )}
            </>
          )}
        </>
      )}
    </fieldset>
  );
}

function ScopeChecks({
  scopes,
  value,
  disabled,
  onChange,
}: {
  scopes: { key: string; name: string | null }[];
  value: string[];
  disabled?: boolean;
  onChange?: (value: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {scopes.map((scope) => (
        <label key={scope.key} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.includes(scope.key)}
            disabled={disabled}
            onChange={(event) =>
              onChange?.(
                event.target.checked
                  ? [...value, scope.key]
                  : value.filter((key) => key !== scope.key),
              )
            }
          />
          {scope.name}
        </label>
      ))}
    </div>
  );
}

export function CircleMemoryField({ circle }: { circle: Circle }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const { data, error } = useQuery(memoryQuery());
  const save = useMutation({
    mutationFn: (memoryScopes: string[]) =>
      pim.updateCircle(circle.id, { memoryScopes }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["circles"] }),
    onError: (error) => toast.error(error.message),
  });
  return (
    <section className="space-y-2 py-3">
      <h3 className="text-muted-foreground text-sm">{t("memory")}</h3>
      <p className="text-muted-foreground text-xs">{t("memoryCircleHint")}</p>
      {error ? (
        <p role="alert">{error.message}</p>
      ) : !data ? (
        <p>{t("loading")}</p>
      ) : (
        <ScopeChecks
          scopes={data.scopes
            .filter(
              (scope) => scope.kind === "everyone" || scope.kind === "named",
            )
            .map((scope) => ({
              ...scope,
              name:
                scope.kind === "everyone" ? t("memoryEveryone") : scope.name,
            }))}
          value={circle.memoryScopes ?? []}
          disabled={save.isPending}
          onChange={(value) => save.mutate(value)}
        />
      )}
    </section>
  );
}

export function MemorySection() {
  const { t, formatDate } = useI18n();
  const client = useQueryClient();
  const label = useScopeLabel();
  const { data, error } = useQuery(memoryQuery());
  const { data: agents = [] } = useQuery(agentsQuery());
  const [scope, setScope] = useState("all");
  const [name, setName] = useState("");
  const log = useInfiniteQuery({
    queryKey: ["memory-log", scope],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      pim.memoryLog(scope === "all" ? "" : scope, pageParam),
    getNextPageParam: (page) =>
      page.entries.length === 30 ? page.entries.at(-1)?.id : undefined,
  });
  const change = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ["memory"] });
      client.invalidateQueries({ queryKey: ["memory-log"] });
      client.invalidateQueries({ queryKey: ["agents"] });
      client.invalidateQueries({ queryKey: ["circles"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const entries = log.data?.pages.flatMap((page) => page.entries) ?? [];
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return <p>{t("loading")}</p>;
  return (
    <section className="space-y-5">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("memory")}
      </h2>
      <Select value={scope} onValueChange={setScope}>
        <SelectTrigger aria-label={t("memoryAll")} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t("memoryAll")}</SelectItem>
          {data.scopes.map((item) => (
            <SelectItem key={item.key} value={item.key}>
              {label(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {log.error && <p role="alert">{log.error.message}</p>}
      {log.isPending ? (
        <p>{t("loading")}</p>
      ) : (
        !entries.length && (
          <p className="text-muted-foreground text-sm">{t("memoryEmpty")}</p>
        )
      )}
      <ul className="divide-y">
        {entries.map((entry) => (
          <li key={entry.id} className="space-y-2 py-4">
            <p className="whitespace-pre-wrap break-words text-sm">
              {entry.forgotten ? t("memoryForgotten") : entry.text}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <time
                className="text-muted-foreground text-xs"
                dateTime={entry.date}
              >
                {formatDate(new Date(entry.date), { dateStyle: "medium" })}
              </time>
              <Select
                value={entry.scope}
                disabled={entry.forgotten || change.isPending}
                onValueChange={(key) =>
                  change.mutate(() => pim.moveMemory(entry.id, key))
                }
              >
                <SelectTrigger
                  aria-label={t("memoryScopes")}
                  className="h-7 w-auto max-w-full rounded-full border-0 bg-muted text-muted-foreground text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {data.scopes
                    .filter(
                      (item) =>
                        item.kind !== "former" || item.key === entry.scope,
                    )
                    .map((item) => (
                      <SelectItem key={item.key} value={item.key}>
                        {label(item)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {!entry.forgotten && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={change.isPending}
                  onClick={() => {
                    if (window.confirm(t("memoryForgetConfirm")))
                      change.mutate(() => pim.forgetMemory(entry.id));
                  }}
                >
                  {t("memoryForget")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {log.hasNextPage && (
        <Button
          variant="secondary"
          disabled={log.isFetchingNextPage}
          onClick={() => log.fetchNextPage()}
        >
          {t("memoryLoadMore")}
        </Button>
      )}
      <div className="space-y-3 border-t pt-5">
        <h3 className="text-muted-foreground text-sm">{t("memoryScopes")}</h3>
        {data.scopes.map((item) => (
          <div key={item.key} className="space-y-1 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-words text-sm">{label(item)}</span>
              {item.kind === "named" && (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={change.isPending}
                    onClick={() => {
                      const next = window.prompt(t("rename"), item.name ?? "");
                      if (next?.trim() && next.trim().length <= 40)
                        change.mutate(() =>
                          pim.renameMemoryScope(item.key, next.trim()),
                        );
                    }}
                  >
                    {t("rename")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={change.isPending}
                    onClick={() => {
                      if (window.confirm(t("memoryDeleteConfirm"))) {
                        setScope("all");
                        change.mutate(() => pim.deleteMemoryScope(item.key));
                      }
                    }}
                  >
                    {t("memoryDeleteScope")}
                  </Button>
                </div>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              {t("memoryReaders", {
                names: item.readers
                  .map(
                    (id) => agents.find((agent) => agent.id === id)?.name ?? id,
                  )
                  .join(", "),
                count: item.count,
              })}
            </p>
          </div>
        ))}
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            change.mutate(async () => {
              await pim.createMemoryScope(name.trim());
              setName("");
            });
          }}
        >
          <Input
            aria-label={t("memoryNewScope")}
            placeholder={t("memoryNewScope")}
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
          <Button
            type="submit"
            disabled={
              !name.trim() ||
              change.isPending ||
              data.scopes.filter((item) => item.kind === "named").length >= 20
            }
          >
            {t("add")}
          </Button>
        </form>
      </div>
    </section>
  );
}
