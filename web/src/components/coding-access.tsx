import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Section } from "~/components/account-settings";
import { type TranslationKey, useI18n } from "~/components/i18n";
import { Loader2, Plus } from "~/components/icons";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  admin,
  CODING_PERMISSIONS,
  type CodingGrant,
  type CodingPermission,
} from "~/lib/pim-api";
import {
  codingAccessQuery,
  codingGrantsQuery,
  membersQuery,
} from "~/lib/queries";

const PERMISSION_LABELS: Record<CodingPermission, TranslationKey> = {
  "coding:start": "codingAccessStart",
  "coding:steer": "codingAccessSteer",
  "coding:push": "codingAccessPush",
  "coding:pr": "codingAccessPr",
  "coding:merge": "codingAccessMerge",
};

/** What a grant gives by default: everything but merge, which an admin turns on on purpose. */
const DEFAULT_PERMISSIONS: CodingPermission[] = [
  "coding:start",
  "coding:steer",
  "coding:push",
  "coding:pr",
];

/**
 * Coding access, the admin's: what this deployment can run coding threads on,
 * and who may start threads, on which repositories.
 * A grant only permits; pushing, opening a pull request and merging still wait
 * for a person's yes each time.
 */
export function CodingAccessSection() {
  const { t } = useI18n();
  const { data } = useQuery(codingAccessQuery());
  const { data: grants } = useQuery(codingGrantsQuery());
  if (!data || !grants) return null;
  return (
    <div className="space-y-10">
      <Section
        title={t("codingAccessRuns")}
        description={t("codingAccessRunsBody")}
      >
        <ul
          className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
          aria-label={t("codingAccessRuns")}
        >
          {data.harnesses.map((harness) => (
            <li
              key={harness.id}
              className="flex items-center gap-3 px-4 py-3 text-sm"
            >
              <span className="min-w-0 flex-1">
                <span className="font-medium">{harness.id}</span>
                <span className="block text-[13px] text-muted-foreground">
                  {harness.available
                    ? t(
                        harness.runsIn === "orb"
                          ? "codingAccessInOrb"
                          : "codingAccessInSandbox",
                      )
                    : harness.reason}
                </span>
              </span>
              <Badge variant={harness.available ? "secondary" : "outline"}>
                {t(
                  harness.available
                    ? "codingAccessAvailable"
                    : "codingAccessUnavailable",
                )}
              </Badge>
            </li>
          ))}
        </ul>
      </Section>
      <Section
        title={t("codingAccessGrants")}
        description={t("codingAccessGrantsBody")}
      >
        {grants.length === 0 ? (
          <p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground text-sm">
            {t("codingAccessNoGrants")}
          </p>
        ) : (
          <ul
            className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
            aria-label={t("codingAccessGrants")}
          >
            {grants.map((grant) => (
              <li key={grant.grantId}>
                <GrantRow grant={grant} />
              </li>
            ))}
          </ul>
        )}
        <GrantForm />
      </Section>
    </div>
  );
}

function GrantRow({ grant }: { grant: CodingGrant }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const revoke = useMutation({
    mutationFn: () => admin.revokeCoding(grant),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["coding-access"] });
      toast.success(t("codingAccessRevoked", { name: grant.username }));
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="min-w-0 flex-1 space-y-1.5">
        <span className="block truncate font-medium text-sm">
          {grant.username}
        </span>
        <span className="flex flex-wrap gap-1.5">
          {grant.permissions.map((permission) => (
            <Badge key={permission} variant="secondary" className="text-[11px]">
              {t(PERMISSION_LABELS[permission])}
            </Badge>
          ))}
        </span>
        <span className="block truncate font-mono text-[13px] text-muted-foreground">
          {grant.repositories.join(", ")}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => revoke.mutate()}
        disabled={revoke.isPending}
        aria-label={t("codingAccessRevokeNamed", { name: grant.username })}
      >
        {t("codingAccessRevoke")}
      </Button>
    </div>
  );
}

function GrantForm() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: members } = useQuery(membersQuery());
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState("");
  const [repository, setRepository] = useState("");
  const [permissions, setPermissions] =
    useState<CodingPermission[]>(DEFAULT_PERMISSIONS);
  // A guest is never given coding access.
  const people = (members ?? []).filter(
    (member) => member.status === "active" && member.role !== "guest",
  );
  const save = useMutation({
    mutationFn: () =>
      admin.grantCoding({
        ownerId: person || (people[0]?.ownerId ?? ""),
        permissions,
        repositories: [repository.trim()],
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["coding-access"] });
      toast.success(t("codingAccessGranted"));
      setOpen(false);
    },
    onError: (error) => toast.error(error.message),
  });
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        {t("codingAccessAdd")}
      </Button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-xl border bg-background p-4"
    >
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("codingAccessPerson")}
        </span>
        <select
          value={person || (people[0]?.ownerId ?? "")}
          onChange={(event) => setPerson(event.target.value)}
          className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm"
        >
          {people.map((member) => (
            <option key={member.ownerId} value={member.ownerId}>
              {member.username}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("codingAccessRepository")}
        </span>
        <Input
          value={repository}
          onChange={(event) => setRepository(event.target.value)}
          placeholder="owner/*"
          className="h-9 font-mono text-xs"
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-[13px] text-muted-foreground">
          {t("codingAccessPermissions")}
        </legend>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {CODING_PERMISSIONS.map((permission) => (
            <label key={permission} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={permissions.includes(permission)}
                onChange={(event) =>
                  setPermissions(
                    event.target.checked
                      ? [...permissions, permission]
                      : permissions.filter((p) => p !== permission),
                  )
                }
              />
              {t(PERMISSION_LABELS[permission])}
            </label>
          ))}
        </div>
        <p className="text-[13px] text-muted-foreground">
          {t("codingAccessAsks")}
        </p>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          {t("cancel")}
        </Button>
        <Button
          type="submit"
          disabled={
            !repository.trim() ||
            permissions.length === 0 ||
            people.length === 0 ||
            save.isPending
          }
        >
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          {t("codingAccessGive")}
        </Button>
      </div>
    </form>
  );
}
