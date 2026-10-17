import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";
import { Popover } from "radix-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import type { Account, Profile } from "~/lib/pim-api";
import { pim } from "~/lib/pim-api";

/** What opens the profile popover; it goes inside `ProfilePopover`. */
export const ProfilePopoverTrigger = Popover.Trigger;

/**
 * Your profile, from the rail: how others on this Pim see you, editable in
 * place, with a link to your page.
 */
export function ProfilePopover({
  account,
  profile,
  onNavigate,
  children,
}: {
  account: Account;
  profile?: Profile;
  onNavigate?: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {children}
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={12}
          collisionPadding={8}
          // Focus the popover, not the name field, so opening it to look selects nothing.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          className="z-50 w-80 rounded-2xl outline-none border bg-popover p-4 text-popover-foreground shadow-[0_8px_30px_-6px_rgb(0_0_0/0.18)] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <div className="mb-4 flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground uppercase"
              aria-hidden="true"
            >
              {(profile?.displayName ?? account.username).slice(0, 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {profile?.displayName ?? `@${account.username}`}
              </p>
              <p className="truncate text-muted-foreground text-[13px]">
                @{account.username}
              </p>
            </div>
            <Link
              to="/people/$username"
              params={{ username: account.username }}
              onClick={() => {
                setOpen(false);
                onNavigate?.();
              }}
              className="flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t("yourPage")}
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
          {profile && (
            <ProfileForm
              account={account}
              profile={profile}
              onSaved={() => setOpen(false)}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ProfileForm({
  account,
  profile,
  onSaved,
}: {
  account: Account;
  profile: Profile;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    displayName: profile.displayName ?? "",
    bio: profile.bio ?? "",
  });
  const changed =
    draft.displayName !== (profile.displayName ?? "") ||
    draft.bio !== (profile.bio ?? "");
  const save = useMutation({
    mutationFn: pim.setProfile,
    onSuccess: (next) => {
      queryClient.setQueryData(["profile"], next);
      queryClient.invalidateQueries({ queryKey: ["people", next.username] });
      toast.success(t("settingsSaved"));
      onSaved();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      displayName: draft.displayName.trim() || null,
      bio: draft.bio.trim() || null,
    });
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[13px] text-muted-foreground">
        {t("profileDescription")}
      </p>
      <label className="block space-y-1">
        <span className="text-muted-foreground text-[13px]">
          {t("displayName")}
        </span>
        <Input
          value={draft.displayName}
          onChange={(event) =>
            setDraft({ ...draft, displayName: event.target.value })
          }
          placeholder={`@${account.username}`}
          maxLength={50}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-muted-foreground text-[13px]">{t("bio")}</span>
        <Input
          value={draft.bio}
          onChange={(event) => setDraft({ ...draft, bio: event.target.value })}
          placeholder={t("bioPlaceholder")}
          maxLength={280}
        />
      </label>
      <div className="flex justify-end">
        <Button type="submit" disabled={!changed || save.isPending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
