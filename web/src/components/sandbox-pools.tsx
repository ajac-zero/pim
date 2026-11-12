import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import { Loader2, Plus } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { admin, type SandboxPool } from "~/lib/pim-api";
import { sandboxPoolsQuery } from "~/lib/queries";

/**
 * The sandbox pools, the admin's: the named groups of coding sandboxes, how
 * many threads each holds at once and in what order threads take them, with
 * how each stands now in the admin's own space.
 */
export function SandboxPoolsPart() {
  const { t } = useI18n();
  const { data } = useQuery(sandboxPoolsQuery());
  const [adding, setAdding] = useState(false);
  if (!data) return null;
  return (
    <Section title={t("poolsTitle")} description={t("poolsBody")}>
      {data.pools.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
          {t("poolsNone")}
        </p>
      ) : (
        <ul
          className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
          aria-label={t("poolsTitle")}
        >
          {data.pools.map((pool) => (
            <li key={pool.id}>
              <PoolRow pool={pool} />
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <PoolForm onDone={() => setAdding(false)} />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          {t("poolsAdd")}
        </Button>
      )}
    </Section>
  );
}

/** Whole minutes and seconds left of a cooldown, such as "4:05". */
function remaining(retryAt: number | null) {
  const seconds = Math.max(0, Math.ceil(((retryAt ?? 0) - Date.now()) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function PoolRow({ pool }: { pool: SandboxPool }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [size, setSize] = useState(String(pool.size));
  const [priority, setPriority] = useState(String(pool.priority));
  const changed = () =>
    queryClient.invalidateQueries({ queryKey: ["compute", "pools"] });
  const update = useMutation({
    mutationFn: (change: {
      size?: number;
      priority?: number;
      enabled?: boolean;
    }) => admin.updateSandboxPool(pool.id, change),
    onSuccess: changed,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: () => admin.removeSandboxPool(pool.id),
    onSuccess: () => {
      changed();
      toast.success(t("computeRemoved", { name: pool.id }));
    },
    onError: (error) => toast.error(error.message),
  });
  const valid =
    /^\d+$/.test(size) && Number(size) >= 1 && /^-?\d+$/.test(priority);
  const dirty =
    size !== String(pool.size) || priority !== String(pool.priority);
  return (
    <div className="space-y-3 px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium text-sm">{pool.id}</span>
            <Badge variant="secondary" className="text-[11px]">
              {pool.provider}
            </Badge>
            {!pool.providerAvailable && (
              <Badge variant="destructive" className="text-[11px]">
                {t("poolsProviderMissing")}
              </Badge>
            )}
            <Badge variant="outline" className="text-[11px]">
              {t("poolsSlots", { held: pool.slots.held, size: pool.size })}
            </Badge>
            {pool.queued > 0 && (
              <Badge variant="outline" className="text-[11px]">
                {t("poolsQueued", { count: pool.queued })}
              </Badge>
            )}
            {pool.breaker.state === "open" && (
              <Badge variant="destructive" className="text-[11px]">
                {t("poolsUnhealthy", { time: remaining(pool.breaker.retryAt) })}
              </Badge>
            )}
            {pool.breaker.state === "half_open" && (
              <Badge variant="destructive" className="text-[11px]">
                {t("poolsProbing")}
              </Badge>
            )}
          </span>
        </span>
        <label className="flex shrink-0 items-center gap-2 text-sm">
          {t("poolsEnabled")}
          <Switch
            checked={pool.enabled}
            aria-label={t("poolsEnabledNamed", { name: pool.id })}
            onCheckedChange={(enabled) => update.mutate({ enabled })}
            disabled={update.isPending}
          />
        </label>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
          aria-label={t("computeRemoveNamed", { name: pool.id })}
        >
          {t("remove")}
        </Button>
      </div>
      <form
        className="flex flex-wrap items-center gap-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          update.mutate({ size: Number(size), priority: Number(priority) });
        }}
      >
        <label className="flex items-center gap-2">
          {t("poolsSize")}
          <Input
            type="number"
            min={1}
            value={size}
            aria-label={t("poolsSizeNamed", { name: pool.id })}
            onChange={(event) => setSize(event.target.value)}
            className="h-9 w-24 text-right"
          />
        </label>
        <label className="flex items-center gap-2">
          {t("poolsPriority")}
          <Input
            type="number"
            value={priority}
            aria-label={t("poolsPriorityNamed", { name: pool.id })}
            onChange={(event) => setPriority(event.target.value)}
            className="h-9 w-24 text-right"
          />
        </label>
        {dirty && (
          <Button
            type="submit"
            size="sm"
            disabled={!valid || update.isPending}
            aria-label={t("poolsSaveNamed", { name: pool.id })}
          >
            {update.isPending && <Loader2 className="size-4 animate-spin" />}
            {t("save")}
          </Button>
        )}
      </form>
    </div>
  );
}

/** Adds a pool: its name, the provider it runs on, how many threads it holds and where it stands. */
function PoolForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [id, setId] = useState("");
  const [provider, setProvider] = useState("");
  const [size, setSize] = useState("2");
  const [priority, setPriority] = useState("10");
  const save = useMutation({
    mutationFn: () =>
      admin.addSandboxPool({
        id: id.trim(),
        provider: provider.trim(),
        size: Number(size),
        priority: Number(priority),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["compute", "pools"] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const complete =
    id.trim() &&
    provider.trim() &&
    /^\d+$/.test(size) &&
    Number(size) >= 1 &&
    /^-?\d+$/.test(priority);
  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border bg-background p-4"
    >
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("poolsId")}
        </span>
        <Input
          value={id}
          onChange={(event) => setId(event.target.value)}
          className="h-9 font-mono text-xs"
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("poolsProvider")}
        </span>
        <Input
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          placeholder="compose"
          className="h-9 font-mono text-xs"
        />
      </label>
      <div className="flex gap-3">
        <label className="block flex-1 space-y-1">
          <span className="text-[13px] text-muted-foreground">
            {t("poolsSize")}
          </span>
          <Input
            type="number"
            min={1}
            value={size}
            onChange={(event) => setSize(event.target.value)}
            className="h-9"
          />
        </label>
        <label className="block flex-1 space-y-1">
          <span className="text-[13px] text-muted-foreground">
            {t("poolsPriority")}
          </span>
          <Input
            type="number"
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="h-9"
          />
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={!complete || save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          {t("poolsAdd")}
        </Button>
      </div>
    </form>
  );
}
