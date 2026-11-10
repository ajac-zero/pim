import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton, Section } from "~/components/account-settings";
import { useI18n } from "~/components/i18n";
import { Loader2, Server } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { admin, type HostOpsAuditRow } from "~/lib/pim-api";
import { hostOpsAuditQuery, hostOpsStatusQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The daemon long-polls for at most 25 s: seen within a minute, it's there. */
const ONLINE_MS = 60_000;
/** How often the section looks again while it's open. */
const REFRESH_MS = 15_000;

/** The installer, run on the host from Pim's checkout, for this Pim. */
export const installCommand = (origin: string) =>
  `sudo ./sandbox-manager/hostopsd/install.sh ${origin}`;

const FAILED = new Set([
  "rejected",
  "invalid",
  "conflict",
  "failed",
  "rolled_back",
  "expired",
]);

/** What a row of the audit log asked for: the operation, and its arguments without it. */
function asked(row: HostOpsAuditRow): { op: string | null; args: string } {
  const args = row.args;
  if (!args) return { op: null, args: "" };
  if (typeof args.op === "string") {
    const rest = args.args;
    const empty =
      rest === undefined ||
      rest === null ||
      (typeof rest === "object" && Object.keys(rest).length === 0);
    return { op: args.op, args: empty ? "" : JSON.stringify(rest) };
  }
  return { op: null, args: JSON.stringify(args) };
}

/**
 * Host operations, the admin's view: the host daemon (hostopsd) that runs
 * what the admin's majordomo asks for, its credential, which is issued,
 * rotated and revoked here and shown only once, and the audit log of every
 * request and what came of it, newest first. Read-only otherwise: only the
 * majordomo asks for operations.
 */
export function HostOpsSection() {
  const { t, formatDate, formatNumber } = useI18n();
  const queryClient = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const { data: status } = useQuery({
    ...hostOpsStatusQuery(),
    refetchInterval: REFRESH_MS,
  });
  const { data: audit } = useQuery({
    ...hostOpsAuditQuery(),
    refetchInterval: REFRESH_MS,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["hostops"] });
  const issue = useMutation({
    mutationFn: admin.issueHostOpsCredential,
    onSuccess: ({ token: made }) => {
      setToken(made);
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const revoke = useMutation({
    mutationFn: admin.revokeHostOpsCredential,
    onSuccess: () => {
      setToken(null);
      void refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  if (!status) return null;
  const { credential, agent, queue } = status;
  const when = (ms: number) =>
    formatDate(new Date(ms), { dateStyle: "medium", timeStyle: "short" });
  const online =
    credential.present &&
    agent.lastSeenAt !== null &&
    Date.now() - agent.lastSeenAt < ONLINE_MS;

  return (
    <Section title={t("hostOps")} description={t("hostOpsDescription")}>
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 px-4 py-3">
        <Server className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate font-medium text-sm">
              {agent.version ? `hostopsd ${agent.version}` : "hostopsd"}
            </span>
            {agent.commit && (
              <code className="truncate font-mono text-muted-foreground text-xs">
                {agent.commit}
              </code>
            )}
            {agent.lastSeenAt !== null && (
              <Badge
                variant={online ? "success" : "secondary"}
                className="text-[11px]"
              >
                {t(online ? "computerOnline" : "computerOffline")}
              </Badge>
            )}
          </span>
          <span className="block text-muted-foreground text-xs">
            {[
              agent.lastSeenAt === null
                ? t("hostOpsNotSeen")
                : t("hostOpsSeen", { date: when(agent.lastSeenAt) }),
              credential.present
                ? t("hostOpsCredentialIssued", {
                    date: when(credential.createdAt ?? 0),
                  })
                : credential.revoked
                  ? t("hostOpsCredentialRevoked", {
                      date: when(credential.revokedAt ?? 0),
                    })
                  : t("hostOpsNoCredential"),
              t("hostOpsQueue", {
                queued: formatNumber(queue.queued),
                running: formatNumber(queue.running),
              }),
            ].join(" · ")}
          </span>
        </span>
      </div>
      {token && (
        <div className="space-y-4 rounded-2xl border border-primary/40 bg-primary/5 px-4 py-4">
          <p className="text-sm">{t("hostOpsTokenOnce")}</p>
          <div className="space-y-2">
            <p className="text-[13px] text-muted-foreground">
              {t("hostOpsCredential")}
            </p>
            <pre className="overflow-x-auto whitespace-pre rounded-xl bg-muted px-3 py-2.5 font-mono text-xs scrollbar-thin">
              {token}
            </pre>
            <CopyButton text={token} />
          </div>
          <div className="space-y-2">
            <p className="text-[13px] text-muted-foreground">
              {t("hostOpsCommand")}
            </p>
            <pre className="overflow-x-auto whitespace-pre rounded-xl bg-muted px-3 py-2.5 font-mono text-xs scrollbar-thin">
              {installCommand(window.location.origin)}
            </pre>
            <CopyButton text={installCommand(window.location.origin)} />
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={issue.isPending}
          onClick={() => {
            if (
              !credential.present ||
              window.confirm(t("hostOpsRotateConfirm"))
            )
              issue.mutate();
          }}
        >
          {issue.isPending && <Loader2 className="animate-spin" />}
          {t(credential.present ? "hostOpsRotate" : "hostOpsIssue")}
        </Button>
        {credential.present && (
          <Button
            variant="secondary"
            disabled={revoke.isPending}
            onClick={() => {
              if (window.confirm(t("hostOpsRevokeConfirm"))) revoke.mutate();
            }}
          >
            {revoke.isPending && <Loader2 className="animate-spin" />}
            {t("hostOpsRevoke")}
          </Button>
        )}
      </div>
      <h3 className="pt-4 font-medium text-muted-foreground text-sm">
        {t("hostOpsAudit")}
      </h3>
      {audit && audit.length === 0 && (
        <p className="text-[13px] text-muted-foreground">
          {t("hostOpsAuditEmpty")}
        </p>
      )}
      {audit && audit.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border scrollbar-thin">
          <table className="w-full min-w-[640px] table-fixed text-left text-[13px]">
            <colgroup>
              <col className="w-[20%]" />
              <col className="w-[18%]" />
              <col className="w-[16%]" />
              <col className="w-[22%]" />
              <col className="w-[24%]" />
            </colgroup>
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 font-normal">{t("hostOpsTime")}</th>
                <th className="px-3 py-2 font-normal">{t("hostOpsActor")}</th>
                <th className="px-3 py-2 font-normal">{t("hostOpsOp")}</th>
                <th className="px-3 py-2 font-normal">{t("hostOpsArgs")}</th>
                <th className="px-3 py-2 font-normal">{t("hostOpsOutcome")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {audit.map((row) => {
                const { op, args } = asked(row);
                return (
                  <tr key={row.id} className="align-top">
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDate(new Date(row.ts), {
                        dateStyle: "short",
                        timeStyle: "medium",
                      })}
                    </td>
                    <td className="px-3 py-2">
                      <span className="block">{row.actorKind}</span>
                      {row.actorId && (
                        <span
                          className="block truncate text-muted-foreground text-xs"
                          title={row.actorId}
                        >
                          {row.actorId}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span className="block break-words">
                        {op ?? row.action}
                      </span>
                      {(op || row.opId) && (
                        <span className="block text-muted-foreground text-xs">
                          {op ? row.action : row.opId?.slice(0, 8)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {args && (
                        <code
                          className="line-clamp-3 break-all font-mono text-xs"
                          title={args}
                        >
                          {args}
                        </code>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={cn(
                          "block",
                          FAILED.has(row.outcome) && "text-destructive",
                          row.outcome === "succeeded" && "text-success",
                        )}
                      >
                        {row.outcome}
                      </span>
                      {row.detail && (
                        <span
                          className="line-clamp-2 break-words text-muted-foreground text-xs"
                          title={row.detail}
                        >
                          {row.detail}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
