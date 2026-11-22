import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CopyButton, Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import { ExternalLink, Loader2, Package, RefreshCw } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { admin, type Release } from "~/lib/pim-api";
import { releaseQuery } from "~/lib/queries";

/** The update whose success the admin has reloaded for, so its notice goes away: the server reports an update for an hour. */
const RELOADED_KEY = "pim-update-reloaded";

/** What a person runs on the host to update, where Pim has no daemon to do it. */
export const updateCommand = (channel: string) =>
  `./deploy/compose/pim.sh update${channel === "stable" ? "" : ` ${channel}`}`;

/** A published image as a person reads it: its version, with the commit where the version is no number (an edge image). */
export const published = (latest: NonNullable<Release["latest"]>) =>
  /^v?\d+\.\d+\.\d+$/.test(latest.version ?? "")
    ? (latest.version as string)
    : [latest.version ?? "edge", latest.revision?.slice(0, 7)]
        .filter(Boolean)
        .join(" ");

/**
 * Which version of Pim runs, and, for the admin, whether a newer image is published on this deployment's channel. Updating is one press: the host daemon pulls the image, backs up,
 * restarts the stack and goes back by itself if it fails. Where no daemon is connected the screen gives the command to run on the host instead.
 */
export function ReleaseSection() {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const { data } = useQuery(releaseQuery());
  const update = useMutation({
    mutationFn: () => admin.updateHost(),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["hostops", "release"] }),
    onError: (error) => toast.error(error.message),
  });
  const check = useMutation({
    mutationFn: () => admin.checkRelease(),
    onSuccess: (release) =>
      queryClient.setQueryData(releaseQuery().queryKey, release),
    onError: (error) => toast.error(error.message),
  });
  if (!data) return null;
  const { latest, update: op } = data;
  const updating = op?.state === "queued" || op?.state === "running";
  const ended =
    op && !updating && localStorage.getItem(RELOADED_KEY) !== op.id ? op : null;
  const offer = data.available && latest && !updating;
  const meta = [
    t("releaseChannel", { channel: data.channel }),
    data.check === "off"
      ? t("releaseCheckOff")
      : data.error
        ? t("releaseCheckFailed", { error: data.error })
        : data.checkedAt === null
          ? t("releaseNotChecked")
          : t("releaseChecked", {
              date: formatDate(new Date(data.checkedAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            }),
  ].join(" · ");

  return (
    <Section title={t("release")} description={t("releaseDescription")}>
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
        <Package className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">
              Pim {data.version}
            </span>
            {data.revision !== "unknown" && (
              <code
                className="truncate font-mono text-muted-foreground text-xs"
                title={t("releaseRevision", { revision: data.revision })}
              >
                {data.revision.slice(0, 7)}
              </code>
            )}
            {data.check === "on" &&
              !data.available &&
              !updating &&
              !data.error &&
              data.checkedAt !== null && (
                <Badge variant="success" className="text-[11px]">
                  {t("releaseUpToDate")}
                </Badge>
              )}
          </span>
          <span className="block text-muted-foreground text-xs">{meta}</span>
        </span>
        {data.check === "on" && !updating && (
          <Button
            variant="secondary"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate()}
          >
            {check.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <RefreshCw />
            )}
            {t("releaseCheckNow")}
          </Button>
        )}
      </div>
      {offer && (
        <div className="space-y-3 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="flex-1 font-medium text-sm">
              {t("releaseAvailable", { version: published(latest) })}
            </p>
            {latest.notesUrl && (
              <a
                href={latest.notesUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-link text-sm hover:underline"
              >
                {t("releaseNotes")}
                <ExternalLink className="size-3.5" />
              </a>
            )}
            {data.daemon.online && (
              <Button
                disabled={update.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      t("releaseUpdateConfirm", { version: published(latest) }),
                    )
                  )
                    update.mutate();
                }}
              >
                {update.isPending && <Loader2 className="animate-spin" />}
                {t("releaseUpdate")}
              </Button>
            )}
          </div>
          {!data.daemon.online && (
            <div className="space-y-2">
              <p className="text-[13px] text-muted-foreground">
                {t("releaseNoDaemon")} {t("releaseRunCommand")}
              </p>
              <pre className="overflow-x-auto whitespace-pre rounded-xl bg-muted px-3 py-2.5 font-mono text-xs scrollbar-thin">
                {updateCommand(data.channel)}
              </pre>
              <CopyButton text={updateCommand(data.channel)} />
            </div>
          )}
        </div>
      )}
      {updating && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-3 text-sm"
        >
          <Loader2 className="size-4 shrink-0 animate-spin" />
          {t("releaseUpdating")}
        </div>
      )}
      {ended && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm"
        >
          <span
            className={
              ended.state === "succeeded" ? "text-success" : "text-destructive"
            }
          >
            {ended.state === "succeeded"
              ? t("releaseUpdated", { summary: ended.summary ?? "" })
              : t("releaseUpdateFailed", {
                  summary: ended.summary ?? ended.state,
                })}
          </span>
          {ended.state === "succeeded" && (
            <Button
              variant="secondary"
              onClick={() => {
                localStorage.setItem(RELOADED_KEY, ended.id);
                window.location.reload();
              }}
            >
              {t("releaseReload")}
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}
