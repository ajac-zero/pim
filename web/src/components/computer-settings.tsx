import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton, Section } from "~/components/account-settings";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { Eye, Loader2, Server, Trash2 } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { type ComputerStatus, type Observation, pim } from "~/lib/pim-api";
import { computerQuery, observationsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * The commands that start pim-computer with `token`: with Node.js, or in a
 * container, which installs Chromium the first time, for the agents' browser.
 */
function commands(token: string) {
  const origin = window.location.origin;
  return {
    node: `curl -fsSLO ${origin}/pim-computer.ts\nPIM_URL=${origin} PIM_COMPUTER_TOKEN=${token} node pim-computer.ts`,
    docker: `docker run -d --name pim-computer --restart unless-stopped \\\n  -e PIM_URL=${origin} -e PIM_COMPUTER_TOKEN=${token} \\\n  -e PIM_COMPUTER_ROOT=/workspace -v pim-files:/workspace \\\n  node:24 sh -c 'command -v chromium || (apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-color-emoji); curl -fsSLO $PIM_URL/pim-computer.ts && exec node pim-computer.ts'`,
  };
}

function Command({ label, text }: { label: string; text: string }) {
  return (
    <div className="space-y-2">
      <p className="text-[13px] text-muted-foreground">{label}</p>
      <pre className="overflow-x-auto whitespace-pre rounded-xl bg-muted px-3 py-2.5 font-mono text-xs scrollbar-thin">
        {text}
      </pre>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * A computer the operator manages, or a choice of one Pim can't read. Setup,
 * removal and the choice itself are the operator's, so nothing here changes them.
 */
function OperatorComputer({ status }: { status: ComputerStatus }) {
  const { t } = useI18n();
  const machine = status.computer;
  if (status.provider === "unreadable")
    return (
      <Section
        title={t("computer")}
        description={t("computerUnreadableDescription")}
      >
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
          <Server className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
          <span className="font-medium text-sm">
            {t("computerUnavailable")}
          </span>
        </div>
      </Section>
    );
  return (
    <Section
      title={t("computer")}
      description={t("computerOperatorDescription")}
    >
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
        <Server className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">
              {machine?.hostname ?? t("computerOperatorManaged")}
            </span>
            <Badge
              variant={status.state === "online" ? "success" : "secondary"}
              className="text-[11px]"
            >
              {status.state === "online"
                ? t("computerOnline")
                : t("computerOffline")}
            </Badge>
          </span>
          {machine && (
            <span className="block truncate text-muted-foreground text-xs">
              {[
                t("computerOperatorManaged"),
                `${machine.platform} ${machine.arch}`,
                machine.user,
                t("computerFilesIn", { folder: machine.root }),
                ...(machine.browser ? [] : [t("computerNoBrowser")]),
              ].join(" · ")}
            </span>
          )}
        </span>
      </div>
      <p className="text-[13px] text-muted-foreground">
        {t("computerOperatorNote")}
      </p>
      {status.provider === "cua" && <WatchDesktop />}
    </Section>
  );
}

/** What a record that isn't settled yet shows as; settled ones show nothing. */
const UNSETTLED: Partial<Record<Observation["status"], TranslationKey>> = {
  pending_open: "observationStarting",
  open: "observationOpen",
  revoking: "observationStopping",
  unconfirmed: "observationUnconfirmed",
};

/**
 * Watching the operator's Cua desktop, view only, where this Pim offers it
 * (only a preview does: elsewhere `/api/observations` is not found, and this
 * shows nothing). The desktop is shown in Cua's own viewer while the agents
 * keep using it; nothing here takes over or sends input. For now the viewer
 * opens without the desktop's picture: Pim refuses its media socket until it
 * can relay it within a bound (docs/cua-viewer-first-worker.md), and the card
 * says so. Closing the viewer asks the computer to end the observation, and
 * Check again asks whether it closed.
 */
function WatchDesktop() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data } = useQuery(observationsQuery());
  const [viewer, setViewer] = useState<{ id: string; url: string } | null>(
    null,
  );
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["observations"] });
  const failed = (error: Error) => {
    toast.error(error.message);
    refresh();
  };
  const watch = useMutation({
    mutationFn: pim.watchDesktop,
    onSuccess: ({ observation, viewer: url }) => {
      setViewer({ id: observation.id, url });
      refresh();
    },
    onError: failed,
  });
  const stop = useMutation({
    mutationFn: pim.stopWatching,
    onSuccess: refresh,
    onError: failed,
  });
  const check = useMutation({
    mutationFn: pim.checkObservation,
    onSuccess: refresh,
    onError: failed,
  });
  if (!data) return null;
  const current = data.observations.find(
    (observation) => UNSETTLED[observation.status] !== undefined,
  );
  const label = current && UNSETTLED[current.status];
  const close = () => {
    if (!viewer) return;
    stop.mutate(viewer.id);
    setViewer(null);
  };

  return (
    <div className="space-y-3 rounded-2xl border px-4 py-3">
      <div className="flex items-center gap-3">
        <Eye className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-sm">
            {t("watchDesktopTitle")}
          </span>
          <span className="block text-muted-foreground text-xs">
            {t("watchDesktopNote")}
          </span>
        </span>
        <Button
          onClick={() => watch.mutate()}
          disabled={
            data.blocked !== null ||
            watch.isPending ||
            (current !== undefined && current.status !== "open")
          }
        >
          {watch.isPending && <Loader2 className="animate-spin" />}
          {t("watchDesktop")}
        </Button>
      </div>
      {current && label && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={current.status === "open" ? "success" : "secondary"}
            className="text-[11px]"
          >
            {t(label)}
          </Badge>
          {current.evidence && (
            <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
              {current.evidence}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={check.isPending}
            onClick={() => check.mutate(current.id)}
          >
            {t("checkObservation")}
          </Button>
          {/* On an unconfirmed record this only asks the computer to end its launch again: it stays not confirmed closed until Check again sees closure. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={stop.isPending}
            onClick={() => stop.mutate(current.id)}
          >
            {t(
              current.status === "unconfirmed" ? "askToEnd" : "stopWatching",
            )}
          </Button>
        </div>
      )}
      {data.blocked && (
        <p className="text-[13px] text-destructive">
          {t("watchDesktopBlocked", { reason: data.blocked })}
        </p>
      )}
      <p className="text-[13px] text-muted-foreground">
        {t("watchDesktopNoPicture")}
      </p>
      {data.agent === "stand-in" && (
        <p className="text-[13px] text-muted-foreground">
          {t("watchDesktopStandIn")}
        </p>
      )}
      <Dialog.Root
        open={viewer !== null}
        onOpenChange={(open) => !open && close()}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed inset-0 z-50 flex flex-col overflow-clip bg-background data-[state=open]:animate-in data-[state=open]:fade-in-0 sm:inset-4 sm:rounded-2xl sm:border sm:shadow-xl"
          >
            <div className="flex items-center gap-3 border-b px-4 py-3">
              <Dialog.Title className="truncate font-semibold text-xl">
                {t("watchDesktopTitle")}
              </Dialog.Title>
              <Badge variant="secondary" className="text-[11px]">
                <Eye />
                {t("watchDesktopViewOnly")}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                {t("watchDesktopAgentsContinue")}
              </span>
              <Button variant="secondary" onClick={close}>
                {t("stopWatching")}
              </Button>
            </div>
            {/*
              Not isolated: the viewer is served under this app's own origin, so
              its pinned script runs with the app's privileges and is trusted as
              pinned code, not contained by the frame. `allow` only denies the
              permissions a viewer might ask for; the launch itself turns the
              clipboard off, and the media socket that would carry input is
              refused.
            */}
            {viewer && (
              <iframe
                title={t("watchDesktopTitle")}
                src={viewer.url}
                referrerPolicy="no-referrer"
                allow="microphone 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'"
                className="min-h-0 w-full flex-1 border-0 bg-black"
              />
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

/**
 * Your computer: a machine of yours that runs pim-computer, where your
 * agents run commands and keep your files. Connecting one makes a token,
 * shown once with the commands that start pim-computer with it.
 */
export function ComputerSection() {
  const { t, formatDate } = useI18n();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const { data: status } = useQuery({
    ...computerQuery(),
    // While a new token waits for its computer, look now and then too, in case the socket missed it.
    refetchInterval: (query) =>
      (token || query.state.data?.managed) &&
      !query.state.data?.computer &&
      query.state.data?.state !== "online"
        ? 5_000
        : false,
  });
  const settle = (next: ComputerStatus) => {
    queryClient.setQueryData(["computer"], next);
    void queryClient.invalidateQueries({ queryKey: ["files"] });
  };
  const pair = useMutation({
    mutationFn: pim.pairComputer,
    onSuccess: ({ token: made, ...next }) => {
      setToken(made);
      settle(next);
    },
    onError: (error) => toast.error(error.message),
  });
  const start = useMutation({
    mutationFn: pim.startComputer,
    onSuccess: settle,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: pim.removeComputer,
    onSuccess: (next) => {
      setToken(null);
      settle(next);
    },
    onError: (error) => toast.error(error.message),
  });
  if (!status) return null;
  if (status.provider) return <OperatorComputer status={status} />;
  const machine = status.computer;
  const shown = token ? commands(token) : null;

  return (
    <Section
      title={t("computer")}
      description={t(
        status.startable
          ? "computerDescriptionStartable"
          : "computerDescription",
      )}
    >
      {status.state !== "none" && (
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
          <Server className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-sm">
                {machine?.hostname ??
                  t(status.managed ? "computerStarting" : "computerWaiting")}
              </span>
              {machine && (
                <Badge
                  variant={status.state === "online" ? "success" : "secondary"}
                  className="text-[11px]"
                >
                  {status.state === "online"
                    ? t("computerOnline")
                    : t(status.managed ? "computerAsleep" : "computerOffline")}
                </Badge>
              )}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {machine
                ? [
                    ...(status.managed ? [t("computerStartedByPim")] : []),
                    `${machine.platform} ${machine.arch}`,
                    machine.user,
                    t("computerFilesIn", { folder: machine.root }),
                    ...(machine.browser ? [] : [t("computerNoBrowser")]),
                  ].join(" · ")
                : t(status.managed ? "computerStartedOn" : "computerPairedOn", {
                    date: formatDate(new Date(status.pairedAt ?? 0), {
                      dateStyle: "medium",
                    }),
                  })}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("removeComputer")}
            disabled={remove.isPending}
            onClick={() => {
              const confirm = status.managed
                ? "removeStartedComputerConfirm"
                : "removeComputerConfirm";
              if (window.confirm(t(confirm))) remove.mutate();
            }}
          >
            {remove.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Trash2 />
            )}
          </Button>
        </div>
      )}
      {status.state === "offline" && !status.managed && !shown && (
        <p className="text-[13px] text-muted-foreground">
          {t("computerOfflineHint")}
        </p>
      )}
      {shown && (
        <div
          className={cn(
            "space-y-4 rounded-2xl border px-4 py-4",
            status.state !== "online" && "border-primary/40 bg-primary/5",
          )}
        >
          <p className="text-sm">{t("computerTokenOnce")}</p>
          <Command label={t("computerWithNode")} text={shown.node} />
          <Command label={t("computerWithDocker")} text={shown.docker} />
          {status.state !== "online" && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("computerWaitingToConnect")}
            </p>
          )}
        </div>
      )}
      {status.state === "none" ? (
        <div className="flex flex-wrap gap-2">
          {status.startable && (
            <Button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending && <Loader2 className="animate-spin" />}
              {t("startComputer")}
            </Button>
          )}
          <Button
            variant={status.startable ? "secondary" : "default"}
            onClick={() => pair.mutate()}
            disabled={pair.isPending}
          >
            {pair.isPending && <Loader2 className="animate-spin" />}
            {t(status.startable ? "connectOwnComputer" : "connectComputer")}
          </Button>
        </div>
      ) : (
        !shown &&
        !status.managed && (
          <Button
            variant="secondary"
            onClick={() => {
              if (window.confirm(t("newComputerTokenConfirm"))) pair.mutate();
            }}
            disabled={pair.isPending}
          >
            {pair.isPending && <Loader2 className="animate-spin" />}
            {t("newComputerToken")}
          </Button>
        )
      )}
    </Section>
  );
}
