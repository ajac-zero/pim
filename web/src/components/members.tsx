import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Link2,
  Loader2,
  Pause,
  Play,
  Trash2,
  UserPlus,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { admin, type Member } from "~/lib/pim-api";
import { accountQuery, membersQuery } from "~/lib/queries";

/** A link to hand over, with a button that copies it. */
function LinkToShare({ url, note }: { url: string; note: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-xl border border-primary/40 bg-primary/5 px-4 py-3">
      <code className="block break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
        {url}
      </code>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("copied") : t("copyLink")}
        </Button>
        <p className="text-muted-foreground text-xs">{note}</p>
      </div>
    </div>
  );
}

/**
 * The admin's view of everyone on this Pim: invite people, and suspend,
 * help back in, or delete someone. Shown only to the admin.
 */
export function MembersSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: account } = useQuery(accountQuery());
  const isAdmin = account?.role === "admin";
  const { data: members } = useQuery({ ...membersQuery(), enabled: isAdmin });
  const [invite, setInvite] = useState<string | null>(null);
  const [setupLink, setSetupLink] = useState<{
    username: string;
    url: string;
  } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["members"] });
  const onError = (error: Error) => toast.error(error.message);

  const makeInvite = useMutation({
    mutationFn: admin.invite,
    onSuccess: setInvite,
    onError,
  });
  const suspend = useMutation({
    mutationFn: ({ username, on }: { username: string; on: boolean }) =>
      on ? admin.suspend(username) : admin.unsuspend(username),
    onSuccess: refresh,
    onError,
  });
  const link = useMutation({
    mutationFn: (username: string) => admin.setupLink(username),
    onSuccess: ({ setupUrl }, username) =>
      setSetupLink({ username, url: setupUrl }),
    onError,
  });
  const remove = useMutation({
    mutationFn: (username: string) => admin.remove(username),
    onSuccess: () => {
      setConfirming(null);
      refresh();
    },
    onError,
  });

  if (!isAdmin || !members) return null;
  const listed = members.filter((member) => member.status !== "deleted");
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("members")}
      </h2>
      <p className="px-1 text-muted-foreground text-xs">
        {t("membersDescription")}
      </p>
      <ul className="divide-y rounded-xl border" aria-label={t("members")}>
        {listed.map((member) => (
          <MemberRow
            key={member.ownerId}
            member={member}
            self={member.ownerId === account.ownerId}
            confirming={confirming === member.username}
            busy={
              (suspend.isPending &&
                suspend.variables?.username === member.username) ||
              (link.isPending && link.variables === member.username) ||
              (remove.isPending && remove.variables === member.username)
            }
            onSuspend={(on) =>
              suspend.mutate({ username: member.username, on })
            }
            onSetupLink={() => link.mutate(member.username)}
            onDelete={() =>
              confirming === member.username
                ? remove.mutate(member.username)
                : setConfirming(member.username)
            }
            onCancel={() => setConfirming(null)}
          />
        ))}
      </ul>
      {setupLink && (
        <LinkToShare
          url={setupLink.url}
          note={t("setupLinkFor", { username: setupLink.username })}
        />
      )}
      {invite && <LinkToShare url={invite} note={t("inviteLinkNote")} />}
      <Button
        variant="outline"
        onClick={() => makeInvite.mutate()}
        disabled={makeInvite.isPending}
      >
        {makeInvite.isPending ? (
          <Loader2 className="animate-spin" />
        ) : (
          <UserPlus />
        )}
        {t("inviteSomeone")}
      </Button>
    </section>
  );
}

function MemberRow({
  member,
  self,
  confirming,
  busy,
  onSuspend,
  onSetupLink,
  onDelete,
  onCancel,
}: {
  member: Member;
  self: boolean;
  confirming: boolean;
  busy: boolean;
  onSuspend: (on: boolean) => void;
  onSetupLink: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const status =
    member.status === "pending"
      ? t("memberPending")
      : member.status === "suspended"
        ? t("memberSuspended")
        : member.status === "deleting"
          ? t("memberDeleting")
          : null;
  const manageable = !self && member.status !== "deleting";
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">
          @{member.username}
          {member.role === "admin" && (
            <span className="ml-2 font-normal text-muted-foreground text-xs">
              {t("adminBadge")}
            </span>
          )}
          {self && (
            <span className="ml-2 font-normal text-muted-foreground text-xs">
              {t("you")}
            </span>
          )}
        </span>
        {status && (
          <span className="block truncate text-muted-foreground text-xs">
            {status}
          </span>
        )}
      </span>
      {busy && (
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      )}
      {manageable && confirming ? (
        <span className="flex items-center gap-2">
          <Button variant="destructive" size="sm" onClick={onDelete}>
            {t("deleteMember", { username: member.username })}
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
        </span>
      ) : manageable ? (
        <span className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("setupLinkAction", { username: member.username })}
            title={t("setupLinkAction", { username: member.username })}
            onClick={onSetupLink}
            disabled={busy}
          >
            <Link2 />
          </Button>
          {member.status !== "pending" && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={
                member.status === "suspended"
                  ? t("restoreMember", { username: member.username })
                  : t("suspendMember", { username: member.username })
              }
              title={
                member.status === "suspended"
                  ? t("restoreMember", { username: member.username })
                  : t("suspendMember", { username: member.username })
              }
              onClick={() => onSuspend(member.status !== "suspended")}
              disabled={busy}
            >
              {member.status === "suspended" ? <Play /> : <Pause />}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("deleteMember", { username: member.username })}
            title={t("deleteMember", { username: member.username })}
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 />
          </Button>
        </span>
      ) : null}
    </li>
  );
}
