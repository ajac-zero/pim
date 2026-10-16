import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  Bot,
  Globe,
  MessageCircle,
  Pencil,
  Plus,
  Puzzle,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, type ReactNode, useState } from "react";
import { toast } from "sonner";
import {
  AgentIcon,
  AgentLookPicker,
  type LookChoice,
} from "~/components/agent-icon";
import { AppIcon } from "~/components/app-icon";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  type Agent,
  type AgentInput,
  admin,
  pim,
  type TeamMember,
} from "~/lib/pim-api";
import {
  accountQuery,
  appDirectoryQuery,
  appsQuery,
  defaultAgentQuery,
  extensionsQuery,
} from "~/lib/queries";

const EMPTY: AgentInput = {
  name: "",
  description: "",
  instructions: "",
  apps: [],
  team: [],
};

/** The same agent controls wherever its settings are opened. */
export function AgentSettingsDialog({
  agent,
  children,
  open: controlledOpen,
  onOpenChange,
  onCloseAutoFocus,
}: {
  agent?: Agent;
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {children && <Dialog.Trigger asChild>{children}</Dialog.Trigger>}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={onCloseAutoFocus}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-5 shadow-xl sm:p-8"
        >
          <Dialog.Title className="mb-6 pr-8 font-semibold text-xl">
            {agent ? t("agentSettings", { name: agent.name }) : t("newAgent")}
          </Dialog.Title>
          {agent ? (
            <AgentCard agent={agent} onClose={() => setOpen(false)} />
          ) : (
            <AgentForm
              onDone={() => setOpen(false)}
              onCancel={() => setOpen(false)}
            />
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

function AgentCard({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { agentId } = useParams({ strict: false });
  const { data: account } = useQuery(accountQuery());
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isAdmin = account?.role === "admin";
  const { data: everyones } = useQuery({
    ...defaultAgentQuery(),
    enabled: isAdmin,
  });
  const forEveryone = everyones?.agentId === agent.id;
  const choose = useMutation({
    mutationFn: (on: boolean) => admin.setDefaultAgent(on ? agent.id : null),
    onSuccess: (chosen) => {
      queryClient.setQueryData(defaultAgentQuery().queryKey, chosen);
      toast.success(
        chosen
          ? t("everyonesDefaultSet", { name: agent.name })
          : t("everyonesDefaultCleared"),
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    return queryClient.invalidateQueries({ queryKey: ["agents"] });
  };
  const makeDefault = useMutation({
    mutationFn: () => pim.makeDefaultAgent(agent.id),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(t("madeDefault", { name: agent.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: () => pim.deleteAgent(agent.id),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onClose();
      if (agentId === agent.id) navigate({ to: "/" });
    },
    onError: (error) => toast.error(error.message),
  });
  const publish = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await pim.publishAgent(agent.id);
      else await pim.unpublishAgent(agent.id);
    },
    onSuccess: (_result, on) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success(t(on ? "agentPublished" : "agentUnpublished"));
    },
    onError: (error) => toast.error(error.message),
  });

  if (editing) {
    return (
      <AgentForm
        agent={agent}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <article className="rounded-xl border px-4 py-3" aria-label={agent.name}>
      <div className="flex items-start gap-3">
        <AgentIcon agent={agent} tile className="size-8 rounded-lg" />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-medium">
            <Link
              to="/agents/$agentId"
              params={{ agentId: agent.id }}
              onClick={onClose}
              className="truncate underline-offset-2 hover:underline"
            >
              {agent.name}
            </Link>
            {agent.default && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-normal text-primary text-xs">
                {t("defaultAgent")}
              </span>
            )}
          </h2>
          {agent.description && (
            <p className="text-muted-foreground text-sm">{agent.description}</p>
          )}
          <p className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground text-xs">
            <BuildsOn blueprint={agent.blueprint} />
            {agent.source && (
              <span>
                {t("fromTemplateBy")}{" "}
                <Link
                  to="/people/$username"
                  params={{ username: agent.source.author }}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  @{agent.source.author}
                </Link>
              </span>
            )}
            {agent.published && (
              <span className="flex items-center gap-1 text-success">
                <Globe className="size-3" /> {t("published")}
              </span>
            )}
            {forEveryone && (
              <span className="flex items-center gap-1 text-primary">
                <Users className="size-3" /> {t("everyonesDefault")}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => choose.mutate(false)}
                  disabled={choose.isPending}
                >
                  {t("stopEveryonesDefault")}
                </button>
              </span>
            )}
          </p>
        </div>
      </div>
      {agent.instructions && (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm">
          {agent.instructions}
        </p>
      )}
      <PimApps agent={agent} />
      {agent.team.length > 0 && (
        <ul
          className="mt-2 flex flex-wrap gap-1.5"
          aria-label={t("teamOf", { name: agent.name })}
        >
          {agent.team.map((member) => (
            <li
              key={member.name}
              className="flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 text-xs"
              title={member.instructions}
            >
              <Bot className="size-3 text-muted-foreground" />
              {member.name}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          onClick={() => {
            onClose();
            navigate({ to: "/new", search: { agent: agent.id } });
          }}
        >
          <MessageCircle /> {t("chatWithAgent")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil /> {t("edit")}
        </Button>
        {account && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => publish.mutate(true)}
            disabled={publish.isPending}
          >
            <Globe /> {t(agent.published ? "updatePublished" : "publish")}
          </Button>
        )}
        {account && agent.published && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => publish.mutate(false)}
            disabled={publish.isPending}
          >
            {t("unpublish")}
          </Button>
        )}
        {!agent.default && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => makeDefault.mutate()}
            disabled={makeDefault.isPending}
          >
            <Star /> {t("makeDefault")}
          </Button>
        )}
        {isAdmin && everyones !== undefined && !forEveryone && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => choose.mutate(true)}
            disabled={choose.isPending}
          >
            <Users /> {t("makeEveryonesDefault")}
          </Button>
        )}
        <span className="ml-auto">
          {agent.default ? null : confirming ? (
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {t("deleteAgent")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirming(false)}
              >
                {t("cancel")}
              </Button>
            </span>
          ) : (
            <Button
              size="icon-sm"
              variant="ghost"
              className="text-muted-foreground"
              aria-label={t("deleteAgentNamed", { name: agent.name })}
              title={t("deleteAgentNamed", { name: agent.name })}
              onClick={() => setConfirming(true)}
            >
              <Trash2 />
            </Button>
          )}
        </span>
      </div>
    </article>
  );
}

/**
 * The apps an agent works with: those of the blueprint it is based on, then its own,
 * each connectable from here unless it already is.
 */
function PimApps({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const { data: extensions } = useQuery(extensionsQuery());
  const blueprint = extensions?.extensions
    .flatMap((extension) => extension.blueprints)
    .find((candidate) => candidate.ref === agent.blueprint);
  const { data: directory = [] } = useQuery(appDirectoryQuery());
  const apps = [
    ...new Set([...(blueprint?.apps ?? []), ...agent.apps]),
  ].flatMap((ref) => directory.find((app) => app.ref === ref) ?? []);
  const queryClient = useQueryClient();
  const { data: connected = [] } = useQuery(appsQuery());
  const connect = useMutation({
    mutationFn: (ref: string) => pim.connectApp(ref),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["permissions"] });
      if (result.authUrl) window.open(result.authUrl, "_blank", "noopener");
      else toast.success(t("appConnected"));
    },
    onError: (error) => toast.error(error.message),
  });
  if (apps.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("suggestedApps")}>
      {apps.map((app) => {
        const known = connected.some(
          (server) => server.app === app.ref && server.state === "ready",
        );
        return (
          <li
            key={app.ref}
            className="flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
            title={app.description || app.name}
          >
            <AppIcon
              name={app.name}
              icon={app.icon}
              className="size-4 text-[9px]"
            />
            {app.name}
            {known ? (
              <span className="px-1.5 text-muted-foreground">
                {t("connected")}
              </span>
            ) : (
              <button
                type="button"
                className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                onClick={() => connect.mutate(app.ref)}
                disabled={connect.isPending}
              >
                {t("connect")}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The name of the blueprint an agent is based on, from what the deployment installed. */
function useBaseName(blueprint: string | null | undefined): string | null {
  const { data } = useQuery(extensionsQuery());
  if (!blueprint) return null;
  const found = data?.extensions
    .flatMap((extension) => extension.blueprints)
    .find((candidate) => candidate.ref === blueprint);
  return found?.name ?? blueprint;
}

function BuildsOn({ blueprint }: { blueprint: string | null }) {
  const { t } = useI18n();
  const name = useBaseName(blueprint);
  return (
    <span className="flex items-center gap-1">
      <Puzzle className="size-3" />
      {name ? t("basedOnName", { name }) : t("basedOnNothing")}
    </span>
  );
}

/** Which blueprint an agent is based on: its habits, abilities and dashboard. */
function BaseSelect({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (blueprint: string | null) => void;
}) {
  const { t } = useI18n();
  const { data } = useQuery(extensionsQuery());
  if (!data) return null;
  const chosen = value === undefined ? data.defaultBlueprint : value;
  return (
    <label className="block space-y-1">
      <span className="font-medium text-sm">{t("basedOn")}</span>
      <Select
        value={chosen ?? NOTHING}
        onValueChange={(next) => onChange(next === NOTHING ? null : next)}
      >
        <SelectTrigger className="w-full" aria-label={t("basedOn")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {data.extensions.flatMap((extension) =>
            extension.blueprints.map((blueprint) => (
              <SelectItem key={blueprint.ref} value={blueprint.ref}>
                {blueprint.name === extension.name
                  ? blueprint.name
                  : `${blueprint.name} · ${extension.name}`}
              </SelectItem>
            )),
          )}
          <SelectItem value={NOTHING}>{t("basedOnNothingOption")}</SelectItem>
        </SelectContent>
      </Select>
      <span className="block text-muted-foreground text-xs">
        {t("basedOnHint")}
      </span>
    </label>
  );
}

/** The select's value for building on nothing: Radix needs a non-empty one. */
const NOTHING = "-";

function AgentForm({
  agent,
  onDone,
  onCancel,
}: {
  /** The agent to edit; left out, the form makes a new one. */
  agent?: Agent;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const initial = agent ?? EMPTY;
  const [look, setLook] = useState<LookChoice>({
    symbol: agent?.symbol ?? null,
    color: agent?.color ?? null,
    image: agent?.icon != null ? "saved" : null,
  });
  const { data: directory } = useQuery(appDirectoryQuery());
  // Each member row keeps a key of its own while edited, so removing one doesn't shift the others' inputs.
  const [value, setValue] = useState<
    Omit<AgentInput, "team"> & {
      team: (Omit<TeamMember, "tools"> & { tools: string; key: string })[];
    }
  >({
    name: initial.name,
    description: initial.description,
    instructions: initial.instructions,
    blueprint: initial.blueprint,
    apps: initial.apps,
    team: initial.team.map((member) => ({
      ...member,
      tools: member.tools?.join(", ") ?? "",
      key: crypto.randomUUID(),
    })),
  });
  const save = useMutation({
    mutationFn: async () => {
      const { blueprint, ...rest } = value;
      const input: AgentInput = {
        ...rest,
        symbol: look.symbol,
        color: look.color,
        ...(blueprint === undefined ? {} : { blueprint }),
        // An app this Pim no longer offers can't be saved: it is dropped.
        apps: directory
          ? value.apps.filter((ref) => directory.some((app) => app.ref === ref))
          : value.apps,
        team: value.team.map(({ name, instructions, tools }) => {
          const names = tools
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean);
          return { name, instructions, tools: names.length > 0 ? names : null };
        }),
      };
      const saved = agent
        ? await pim.updateAgent(agent.id, input)
        : await pim.createAgent(input);
      // An uploaded image shows in place of the symbol, so it is sent, or taken away, once the agent exists.
      if (look.image instanceof Blob)
        await pim.setAgentIcon(saved.id, look.image);
      else if (look.image === null && saved.icon !== null) {
        await pim.removeAgentIcon(saved.id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };
  const setMember = (
    key: string,
    member: Partial<{ name: string; instructions: string; tools: string }>,
  ) =>
    setValue({
      ...value,
      team: value.team.map((current) =>
        current.key === key ? { ...current, ...member } : current,
      ),
    });

  return (
    <form
      onSubmit={submit}
      className="space-y-5 [&_legend]:text-[13px] [&_legend]:text-muted-foreground [&_label>span]:font-normal [&_label>span]:text-[13px] [&_label>span]:text-muted-foreground [&_textarea]:rounded-xl"
      aria-label={agent ? t("editAgent") : t("newAgent")}
    >
      <AgentLookPicker agent={agent} value={look} onChange={setLook} />
      <label className="block space-y-1">
        <span className="font-medium text-sm">{t("agentName")}</span>
        <Input
          value={value.name}
          onChange={(event) => setValue({ ...value, name: event.target.value })}
          placeholder={t("agentNamePlaceholder")}
          maxLength={60}
          required
        />
      </label>
      <label className="block space-y-1">
        <span className="font-medium text-sm">{t("agentDescription")}</span>
        <Input
          value={value.description}
          onChange={(event) =>
            setValue({ ...value, description: event.target.value })
          }
          placeholder={t("agentDescriptionPlaceholder")}
          maxLength={280}
        />
      </label>
      <BaseSelect
        value={value.blueprint}
        onChange={(blueprint) => setValue({ ...value, blueprint })}
      />
      <label className="block space-y-1">
        <span className="font-medium text-sm">{t("agentInstructions")}</span>
        <textarea
          value={value.instructions}
          onChange={(event) =>
            setValue({ ...value, instructions: event.target.value })
          }
          placeholder={t("agentInstructionsPlaceholder")}
          maxLength={8000}
          rows={6}
          className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </label>
      <fieldset className="space-y-2">
        <legend className="font-medium text-sm">{t("suggestedApps")}</legend>
        <p className="text-muted-foreground text-xs">
          {t("suggestedAppsHint")}
        </p>
        {directory?.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("noAppsOffered")}</p>
        ) : (
          directory && (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
              {directory.map((app) => {
                const checked = value.apps.includes(app.ref);
                return (
                  <li key={app.ref}>
                    <label className="flex cursor-pointer items-start gap-3 px-3 py-2 has-disabled:cursor-not-allowed has-disabled:opacity-60">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-primary"
                        checked={checked}
                        // Up to 10 apps an agent.
                        disabled={!checked && value.apps.length >= 10}
                        onChange={() =>
                          setValue({
                            ...value,
                            apps: checked
                              ? value.apps.filter((ref) => ref !== app.ref)
                              : [...value.apps, app.ref],
                          })
                        }
                      />
                      <AppIcon
                        name={app.name}
                        icon={app.icon}
                        className="size-6 text-xs"
                      />
                      <div className="min-w-0">
                        <div className="text-sm">{app.name}</div>
                        {app.description && (
                          <div className="text-muted-foreground text-xs">
                            {app.description}
                          </div>
                        )}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )
        )}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="font-medium text-sm">{t("team")}</legend>
        <p className="text-muted-foreground text-xs">{t("teamHint")}</p>
        {value.team.map((member) => (
          <div key={member.key} className="space-y-2 rounded-lg border p-3">
            <div className="flex gap-2">
              <Input
                value={member.name}
                onChange={(event) =>
                  setMember(member.key, { name: event.target.value })
                }
                placeholder={t("memberNamePlaceholder")}
                aria-label={t("memberName")}
                maxLength={40}
                required
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t("removeTeamMember")}
                onClick={() =>
                  setValue({
                    ...value,
                    team: value.team.filter(
                      (other) => other.key !== member.key,
                    ),
                  })
                }
              >
                <X />
              </Button>
            </div>
            <textarea
              value={member.instructions}
              onChange={(event) =>
                setMember(member.key, { instructions: event.target.value })
              }
              placeholder={t("memberInstructionsPlaceholder")}
              aria-label={t("memberInstructions")}
              maxLength={8000}
              required
              rows={3}
              className="w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Input
              value={member.tools}
              onChange={(event) =>
                setMember(member.key, { tools: event.target.value })
              }
              placeholder={t("memberTools")}
              aria-label={t("memberTools")}
              title={t("memberToolsHint")}
            />
          </div>
        ))}
        {value.team.length > 0 && (
          <p className="text-muted-foreground text-xs">
            {t("memberToolsHint")}
          </p>
        )}
        {value.team.length < 8 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setValue({
                ...value,
                team: [
                  ...value.team,
                  {
                    name: "",
                    instructions: "",
                    tools: "",
                    key: crypto.randomUUID(),
                  },
                ],
              })
            }
          >
            <Plus /> {t("addMember")}
          </Button>
        )}
      </fieldset>
      <div className="flex justify-between gap-2 border-t pt-5">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending || !value.name.trim()}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
