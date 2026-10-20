import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton, Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import { Loader2, Server, Trash2 } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { type ComputerStatus, pim } from "~/lib/pim-api";
import { computerQuery } from "~/lib/queries";
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
