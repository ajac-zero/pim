import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton, Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import { AlertCircle, Loader2, Server, Trash2 } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { admin, type ComputerStatus, pim } from "~/lib/pim-api";
import { computerHostQuery, computerQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/**
 * The commands that start pim-computer with `token`: this Pim's install
 * script, which keeps it running as the person's service, or a container,
 * which installs Chromium the first time, for the agents' browser.
 */
function commands(token: string) {
  const origin = window.location.origin;
  return {
    install: `curl -fsSL ${origin}/install.sh | sh -s -- computer ${token}`,
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
 * Your computer: where your agents run commands, browse and keep your
 * files. Where this Pim has a computer host, it's the one the host keeps for
 * you, which you can't remove; this says while it's being set up, and why it
 * couldn't be. Otherwise it's a machine of yours that runs pim-computer:
 * connecting one makes a token, shown once with the commands that start
 * pim-computer with it.
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
  const setUp = useMutation({
    mutationFn: pim.setUpComputer,
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
  const machine = status.computer;
  const shown = token ? commands(token) : null;
  const settingUp = status.managed && !machine && !status.error;

  return (
    <Section
      title={t("computer")}
      description={t(
        status.managed ? "computerDescriptionManaged" : "computerDescription",
      )}
    >
      {/* One that couldn't be set up is only the error below. */}
      {status.state !== "none" && (machine || !status.error) && (
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
          <Server className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-sm">
                {machine?.hostname ??
                  t(status.managed ? "computerSettingUp" : "computerWaiting")}
              </span>
              {machine && (
                <Badge
                  variant={status.state === "online" ? "success" : "secondary"}
                  className="text-[11px]"
                >
                  {t(
                    status.state === "online"
                      ? "computerOnline"
                      : "computerOffline",
                  )}
                </Badge>
              )}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {machine
                ? [
                    `${machine.platform} ${machine.arch}`,
                    machine.user,
                    t("computerFilesIn", { folder: machine.root }),
                    ...(machine.browser ? [] : [t("computerNoBrowser")]),
                  ].join(" · ")
                : settingUp
                  ? t("computerSettingUpHint")
                  : t("computerPairedOn", {
                      date: formatDate(new Date(status.pairedAt ?? 0), {
                        dateStyle: "medium",
                      }),
                    })}
            </span>
          </span>
          {settingUp && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
          {machine?.screen && status.state === "online" && (
            <Button variant="secondary" size="sm" asChild>
              <Link to="/computer">{t("computerOpen")}</Link>
            </Button>
          )}
          {!status.managed && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t("removeComputer")}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(t("removeComputerConfirm"))) remove.mutate();
              }}
            >
              {remove.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
            </Button>
          )}
        </div>
      )}
      {status.error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1 space-y-1">
            <span className="block text-sm">{t("computerSetupFailed")}</span>
            <span className="block break-words text-muted-foreground text-xs">
              {status.error}
            </span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setUp.mutate()}
            disabled={setUp.isPending}
          >
            {setUp.isPending && <Loader2 className="animate-spin" />}
            {t("tryAgain")}
          </Button>
        </div>
      )}
      {status.state === "offline" && !shown && machine && (
        <p className="text-[13px] text-muted-foreground">
          {t(status.managed ? "computerOfflineManaged" : "computerOfflineHint")}
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
          <Command label={t("computerWithInstaller")} text={shown.install} />
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
        <Button onClick={() => pair.mutate()} disabled={pair.isPending}>
          {pair.isPending && <Loader2 className="animate-spin" />}
          {t("connectComputer")}
        </Button>
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

/**
 * The machine that keeps everyone's computers: one of the operator's (Linux
 * with KVM, or a Mac with Apple silicon) that runs pim-host with Cua. Pairing it makes its token, shown once
 * with the command that installs pim-host with it. The admin's alone.
 */
export function ComputerHostSection() {
  const { t, formatDate, formatNumber } = useI18n();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const { data: host } = useQuery({
    ...computerHostQuery(),
    // While a new token waits for the host, look now and then.
    refetchInterval: (query) =>
      token && !query.state.data?.connected ? 5_000 : false,
  });
  const pair = useMutation({
    mutationFn: admin.pairComputerHost,
    onSuccess: ({ token: made, ...next }) => {
      setToken(made);
      queryClient.setQueryData(["computer-host"], next);
    },
    onError: (error) => toast.error(error.message),
  });
  const forget = useMutation({
    mutationFn: admin.forgetComputerHost,
    onSuccess: (next) => {
      setToken(null);
      queryClient.setQueryData(["computer-host"], next);
    },
    onError: (error) => toast.error(error.message),
  });
  if (!host) return null;
  const origin = window.location.origin;
  const command = token
    ? `curl -fsSL ${origin}/install.sh | sh -s -- host ${token}`
    : null;

  return (
    <Section
      title={t("computerHost")}
      description={t("computerHostDescription")}
    >
      {host.paired && (
        <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
          <Server className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-sm">
                {host.image ?? t("computerHostWaiting")}
              </span>
              {host.seenAt !== null && (
                <Badge
                  variant={host.connected ? "success" : "secondary"}
                  className="text-[11px]"
                >
                  {t(host.connected ? "computerOnline" : "computerOffline")}
                </Badge>
              )}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {host.seenAt === null
                ? t("computerPairedOn", {
                    date: formatDate(new Date(host.pairedAt ?? 0), {
                      dateStyle: "medium",
                    }),
                  })
                : [
                    t("computerHostMachines", {
                      count: formatNumber(host.machines),
                      running: formatNumber(host.running),
                    }),
                    ...(host.pending > 0
                      ? [
                          t("computerHostPending", {
                            count: formatNumber(host.pending),
                          }),
                        ]
                      : []),
                    t("computerHostSeen", {
                      date: formatDate(new Date(host.seenAt), {
                        dateStyle: "medium",
                        timeStyle: "short",
                      }),
                    }),
                    ...(host.version ? [`pim-host ${host.version}`] : []),
                  ].join(" · ")}
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("computerHostRemove")}
            disabled={forget.isPending}
            onClick={() => {
              if (window.confirm(t("computerHostRemoveConfirm")))
                forget.mutate();
            }}
          >
            {forget.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Trash2 />
            )}
          </Button>
        </div>
      )}
      {command && (
        <div
          className={cn(
            "space-y-4 rounded-2xl border px-4 py-4",
            !host.connected && "border-primary/40 bg-primary/5",
          )}
        >
          <p className="text-sm">{t("computerHostTokenOnce")}</p>
          <Command label={t("computerHostCommand")} text={command} />
          {!host.connected && (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t("computerWaitingToConnect")}
            </p>
          )}
        </div>
      )}
      {!command && (
        <Button
          variant={host.paired ? "secondary" : "default"}
          onClick={() => {
            if (
              !host.paired ||
              window.confirm(t("computerHostNewTokenConfirm"))
            )
              pair.mutate();
          }}
          disabled={pair.isPending}
        >
          {pair.isPending && <Loader2 className="animate-spin" />}
          {t(host.paired ? "newComputerToken" : "computerHostPair")}
        </Button>
      )}
    </Section>
  );
}
