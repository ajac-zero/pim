import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useCodingApi } from "~/components/coding";
import { useI18n } from "~/components/i18n";
import { Loader2, TriangleAlert } from "~/components/icons";
import { Confirm } from "~/components/triggers";
import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  type CodingEnvironment,
  type CodingThreadView,
  codingErrorCode,
  formatAgo,
  MAX_SETUP_SCRIPT_BYTES,
  repoName,
  setupScriptBytes,
} from "~/lib/coding";
import { cn } from "~/lib/utils";

/*
 * A coding thread's prepared environment (docs/coding-api.md): a chip below
 * the thread's header with the timings and a rebuild in a popover, and the
 * repository's setup script, which the person can edit from there.
 */

const FIELD =
  "w-full rounded-xl border bg-background px-3 py-2 font-mono text-[13px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/20 aria-invalid:border-destructive";

export function EnvironmentSection({ thread }: { thread: CodingThreadView }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="mt-4">
      <EnvironmentChip thread={thread} onEditScript={() => setEditing(true)} />
      {editing && (
        <SetupScriptPanel
          repoUrl={thread.repo.url}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
}

const TIMINGS = [
  ["provisionMs", "codingEnvProvision"],
  ["restoreMs", "codingEnvRestore"],
  ["setupMs", "codingEnvSetup"],
  ["snapshotMs", "codingEnvSnapshot"],
] as const;

function EnvironmentChip({
  thread,
  onEditScript,
}: {
  thread: CodingThreadView;
  onEditScript: () => void;
}) {
  const { t, locale, formatNumber } = useI18n();
  const env = thread.environment;
  const [open, setOpen] = useState(false);
  const label = (() => {
    switch (env.state) {
      case "cached":
        return env.builtAt === null
          ? t("codingEnvCachedNow")
          : t("codingEnvCached", {
              ago: formatAgo(env.builtAt, Date.now(), locale),
            });
      case "building":
        return t("codingEnvBuilding");
      case "restoring":
        return t("codingEnvRestoring");
      case "failed":
        return t("codingEnvFailed");
      default:
        return t("codingEnvNone");
    }
  })();
  const pending = env.state === "building" || env.state === "restoring";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("codingEnvDetails", { state: label })}
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            env.state === "none" && "text-muted-foreground",
            env.state === "failed" && "border-destructive/50 text-destructive",
          )}
        >
          {pending && (
            <Loader2
              aria-hidden
              className="size-3.5 shrink-0 motion-safe:animate-spin"
            />
          )}
          {env.state === "failed" && (
            <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 max-w-[calc(100vw-2rem)] text-sm"
      >
        <p className="font-medium">{t("codingEnvTitle")}</p>
        {env.error && (
          <p
            role="alert"
            className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-2.5 py-2 font-mono text-destructive text-xs"
          >
            {env.error}
          </p>
        )}
        {env.source && (
          <p className="mt-2 text-muted-foreground">
            {env.source === "settings"
              ? t("codingEnvSourceSettings")
              : t("codingEnvSourceRepository")}
          </p>
        )}
        <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-muted-foreground">
          {TIMINGS.map(([field, key]) => {
            const ms = env[field];
            return ms === null ? null : (
              <div key={field} className="contents">
                <dt>{t(key)}</dt>
                <dd className="text-foreground tabular-nums">
                  {t("codingEnvSeconds", {
                    seconds: formatNumber(ms / 1000, {
                      maximumFractionDigits: 1,
                    }),
                  })}
                </dd>
              </div>
            );
          })}
        </dl>
        <RebuildEnvironment thread={thread} env={env} />
        <Button
          type="button"
          variant="ghost"
          className="mt-2 w-full"
          onClick={() => {
            setOpen(false);
            onEditScript();
          }}
        >
          {t("codingEnvEditScript")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function RebuildEnvironment({
  thread,
  env,
}: {
  thread: CodingThreadView;
  env: CodingEnvironment;
}) {
  const { t } = useI18n();
  const api = useCodingApi();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const rebuild = useMutation({
    mutationFn: () => api.rebuildEnvironment(thread.id),
    onSuccess: (environment) => {
      setConfirming(false);
      queryClient.setQueryData<CodingThreadView>(
        ["coding", "thread", thread.id],
        (current) => (current ? { ...current, environment } : current),
      );
    },
    onError: () => setConfirming(false),
  });
  const turnRunning =
    thread.state === "running" || thread.currentOperation !== null;
  const disabled = turnRunning || env.state === "building";
  return (
    <div className="mt-3">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={disabled || rebuild.isPending}
        aria-expanded={confirming}
        onClick={() => {
          rebuild.reset();
          setConfirming(true);
        }}
      >
        {t("codingEnvRebuild")}
      </Button>
      {disabled && (
        <p className="mt-1.5 text-muted-foreground text-xs">
          {turnRunning ? t("codingEnvRebuildTurn") : t("codingEnvRebuildBusy")}
        </p>
      )}
      {rebuild.error && (
        <p role="alert" className="mt-1.5 text-destructive text-xs">
          {codingErrorCode(rebuild.error) === "conflict"
            ? t("codingEnvRebuildConflict")
            : rebuild.error.message}
        </p>
      )}
      {confirming && (
        <Confirm
          text={t("codingEnvRebuildConfirm")}
          action={t("codingEnvRebuild")}
          pending={rebuild.isPending}
          onConfirm={() => rebuild.mutate()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

/** The person's setup script for the thread's repository: shown, saved or cleared. */
function SetupScriptPanel({
  repoUrl,
  onClose,
}: {
  repoUrl: string;
  onClose: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const api = useCodingApi();
  const queryClient = useQueryClient();
  const id = useId();
  const key = ["coding", "repo-settings", repoName(repoUrl)];
  const settings = useQuery({
    queryKey: key,
    queryFn: () => api.repoSettings(repoUrl),
  });
  const [script, setScript] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (settings.data) setScript(settings.data.setupScript ?? "");
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (next: string | null) => api.setRepoSettings(repoUrl, next),
    onSuccess: (next) => {
      queryClient.setQueryData(key, next);
      setScript(next.setupScript ?? "");
      setSaved(true);
    },
  });
  const bytes = setupScriptBytes(script);
  const tooBig = bytes > MAX_SETUP_SCRIPT_BYTES;
  const max = formatNumber(MAX_SETUP_SCRIPT_BYTES / 1024);
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="mt-3 rounded-2xl border px-4 py-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="min-w-0 truncate font-medium text-sm">
          {t("codingSetupTitle", { repo: repoName(repoUrl) })}
        </h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          {t("codingSetupClose")}
        </Button>
      </div>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {t("codingSetupNote")}
      </p>
      {settings.isError ? (
        <p role="alert" className="mt-3 text-destructive text-sm">
          {settings.error.message}
        </p>
      ) : !settings.data ? (
        <p role="status" className="mt-3 text-muted-foreground text-sm">
          {t("loading")}
        </p>
      ) : (
        <>
          <label htmlFor={`${id}-script`} className="sr-only">
            {t("codingSetupScript")}
          </label>
          <textarea
            id={`${id}-script`}
            value={script}
            rows={8}
            spellCheck={false}
            aria-invalid={tooBig}
            aria-describedby={`${id}-size`}
            placeholder="#!/bin/sh"
            onChange={(event) => {
              setScript(event.target.value);
              setSaved(false);
            }}
            className={cn(FIELD, "mt-3 resize-y")}
          />
          <p
            id={`${id}-size`}
            role={tooBig ? "alert" : undefined}
            className={cn(
              "mt-1 text-xs",
              tooBig ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {tooBig
              ? t("codingSetupTooBig", { max })
              : t("codingSetupSize", {
                  size: formatNumber(bytes / 1024, {
                    maximumFractionDigits: 1,
                  }),
                  max,
                })}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={save.isPending || tooBig}
              onClick={() => save.mutate(script)}
            >
              {t("save")}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={save.isPending || settings.data.setupScript === null}
              onClick={() => save.mutate(null)}
            >
              {t("codingSetupClear")}
            </Button>
            {saved && (
              <span role="status" className="text-muted-foreground text-sm">
                {t("codingSetupSaved")}
              </span>
            )}
          </div>
          {save.error && (
            <p role="alert" className="mt-2 text-destructive text-sm">
              {save.error.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
