import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ApprovalBlock } from "~/components/chat/items";
import { useI18n } from "~/components/i18n";
import { ChevronDown, Plus, Trash2, X } from "~/components/icons";
import { ToolPermissionList } from "~/components/tool-permissions";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { type Circle, pim } from "~/lib/pim-api";
import {
  accountQuery,
  approvalsQuery,
  circlesQuery,
  guestActivityQuery,
} from "~/lib/queries";

/**
 * Sharing, as a dialog over whatever is open: circles of people who may
 * message your Pim from their own, what each circle may use, the requests
 * they're waiting on, and what they did.
 */
export function SharingDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const { data: account } = useQuery(accountQuery());
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content className="fixed inset-0 z-50 overflow-y-auto bg-background p-6 scrollbar-thin data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:max-h-[min(720px,calc(100dvh-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8 sm:shadow-xl">
          <Dialog.Title className="pr-8 font-semibold text-xl">
            {t("sharing")}
          </Dialog.Title>
          <Dialog.Description className="mt-1 mb-8 text-muted-foreground text-sm">
            {t("sharingDescription")}
          </Dialog.Description>
          {account && (
            <>
              <RequestsSection />
              <CirclesSection />
              <ActivitySection />
            </>
          )}
          <Dialog.Close className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
            <span className="sr-only">{t("close")}</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Requests from people in your circles, waiting for your answer. */
function RequestsSection() {
  const { t } = useI18n();
  const { data: approvals } = useQuery(approvalsQuery());
  const asked = (approvals ?? []).filter(
    (approval) => approval.requestedBy && approval.status === "pending",
  );
  if (asked.length === 0) return null;
  return (
    <section className="mb-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("waitingForYou")}
      </h2>
      {asked.map((approval) => (
        <ApprovalBlock key={approval.id} approval={approval} />
      ))}
    </section>
  );
}

function CirclesSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: circles } = useQuery(circlesQuery());
  const [name, setName] = useState("");
  const create = useMutation({
    mutationFn: pim.createCircle,
    onSuccess: () => {
      setName("");
      queryClient.invalidateQueries({ queryKey: ["circles"] });
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim()) create.mutate(name.trim());
  };

  return (
    <section className="space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("circles")}
      </h2>
      {circles?.length === 0 && (
        <p className="text-[13px] text-muted-foreground">{t("noCircles")}</p>
      )}
      {circles?.map((circle) => (
        <CircleCard key={circle.id} circle={circle} />
      ))}
      <form onSubmit={submit} className="flex gap-2">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("circleNamePlaceholder")}
          aria-label={t("newCircle")}
          maxLength={40}
        />
        <Button type="submit" disabled={!name.trim() || create.isPending}>
          <Plus /> {t("newCircle")}
        </Button>
      </form>
    </section>
  );
}

function CircleCard({ circle }: { circle: Circle }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [confirming, setConfirming] = useState(false);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["circles"] });
  const update = useMutation({
    mutationFn: (enabled: boolean) => pim.updateCircle(circle.id, { enabled }),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: () => pim.deleteCircle(circle.id),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const add = useMutation({
    mutationFn: (name: string) => pim.addMember(circle.id, name),
    onSuccess: () => {
      setUsername("");
      refresh();
    },
    onError: (error) => toast.error(error.message),
  });
  const removeMember = useMutation({
    mutationFn: (ownerId: string) => pim.removeMember(circle.id, ownerId),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (username.trim()) add.mutate(username.trim());
  };

  return (
    <article
      className="rounded-2xl border bg-muted/20"
      aria-label={circle.name}
    >
      <header className="flex items-center gap-3 px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">
            {circle.name}
          </span>
          <span className="block text-muted-foreground text-xs">
            {circle.enabled
              ? t("circleMembers", { count: circle.members.length })
              : t("circlePaused")}
          </span>
        </span>
        <Switch
          checked={circle.enabled}
          onCheckedChange={(enabled) => update.mutate(enabled)}
          disabled={update.isPending}
          aria-label={t("shareWithCircle", { circle: circle.name })}
        />
        {confirming ? (
          <span className="flex items-center gap-1">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {t("deleteCircle")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirming(false)}
            >
              {t("cancel")}
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground"
            aria-label={t("deleteCircleNamed", { circle: circle.name })}
            title={t("deleteCircleNamed", { circle: circle.name })}
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
          </Button>
        )}
      </header>
      <div className="space-y-2 border-t px-4 py-3">
        {circle.members.length > 0 && (
          <ul
            className="flex flex-wrap gap-1.5"
            aria-label={t("membersOf", { circle: circle.name })}
          >
            {circle.members.map((member) => (
              <li
                key={member.ownerId}
                className="flex items-center gap-1 rounded-full border py-0.5 pr-1 pl-2.5 text-sm"
              >
                <span
                  className="flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground"
                  aria-hidden="true"
                >
                  {member.username.slice(0, 1).toUpperCase()}
                </span>
                {member.username}
                <button
                  type="button"
                  className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  aria-label={t("removeMember", {
                    username: member.username,
                    circle: circle.name,
                  })}
                  onClick={() => removeMember.mutate(member.ownerId)}
                  disabled={removeMember.isPending}
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={submit} className="flex gap-2">
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={t("usernamePlaceholder")}
            aria-label={t("addTo", { circle: circle.name })}
            className="h-8"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!username.trim() || add.isPending}
          >
            {t("add")}
          </Button>
        </form>
      </div>
      <Collapsible className="border-t">
        <CollapsibleTrigger className="group flex w-full items-center gap-2 px-4 py-3 text-left text-sm">
          <span className="flex-1">
            {t("whatCircleCanUse", { circle: circle.name })}
          </span>
          <ChevronDown className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 px-4 pb-4">
          <p className="text-muted-foreground text-xs">
            {t("circlePermissionsDescription")}
          </p>
          <ToolPermissionList circle={circle.id} />
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

/** What people in your circles used, newest first. */
function ActivitySection() {
  const { t, formatDate } = useI18n();
  const { data: activity } = useQuery(guestActivityQuery());
  const { data: circles } = useQuery(circlesQuery());
  if (!activity || activity.length === 0) return null;
  const circleName = (id: string) =>
    circles?.find((circle) => circle.id === id)?.name ?? "";
  const outcome = {
    ran: t("activityRan"),
    asked: t("activityAsked"),
    refused: t("activityRefused"),
  } as const;
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("recentActivity")}
      </h2>
      <ul className="divide-y rounded-xl border">
        {activity.slice(0, 50).map((entry) => (
          <li
            key={entry.id}
            className="flex items-baseline gap-3 px-4 py-2.5 text-sm"
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium">{entry.username}</span>
              <span className="text-muted-foreground">
                {circleName(entry.circle) && ` · ${circleName(entry.circle)}`}
                {` · ${outcome[entry.outcome]}`}
              </span>
              <span
                className="block truncate font-mono text-muted-foreground text-xs"
                title={entry.summary}
              >
                {entry.summary}
              </span>
            </span>
            <time className="shrink-0 text-muted-foreground text-xs">
              {formatDate(new Date(entry.at), {
                dateStyle: "short",
                timeStyle: "short",
              })}
            </time>
          </li>
        ))}
      </ul>
    </section>
  );
}
