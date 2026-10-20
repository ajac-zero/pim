import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { Dialog } from "radix-ui";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { toast } from "sonner";
import {
  AgentIcon,
  CompactLookPicker,
  type LookChoice,
} from "~/components/agent-icon";
import { AppIcon } from "~/components/app-icon";
import { useI18n } from "~/components/i18n";
import {
  AlertCircle,
  Bot,
  ChevronDown,
  Globe,
  MessageCircle,
  Pencil,
  Plus,
  Puzzle,
  Trash2,
  Users,
  X,
} from "~/components/icons";
import {
  Chip,
  InvolvementBar,
  Question,
  toneKey,
  WriteYourOwn,
} from "~/components/majordomo-setup";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  type Agent,
  type AgentInput,
  admin,
  MAJORDOMO_TONES,
  type MajordomoPreferences,
  pim,
  type TeamMember,
  type ToolPermissionInfo,
} from "~/lib/pim-api";
import {
  accountQuery,
  agentPermissionsQuery,
  appDirectoryQuery,
  appsQuery,
  defaultAgentQuery,
  extensionsQuery,
  majordomoQuery,
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
          className="fixed inset-x-0 bottom-0 z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-t-2xl bg-background p-5 shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 max-sm:data-[state=open]:slide-in-from-bottom-4 sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:w-[calc(100%-2rem)] sm:max-w-xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:p-8"
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
    <>
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
              {agent.majordomo && (
                <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-normal text-primary text-xs">
                  {t("majordomoBadge")}
                </span>
              )}
            </h2>
            {agent.description && (
              <p className="text-muted-foreground text-sm">
                {agent.description}
              </p>
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
              navigate({
                to: "/agents/$agentId",
                params: { agentId: agent.id },
              });
            }}
          >
            <MessageCircle /> {t("chatWithAgent")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> {t("edit")}
          </Button>
          {/* Alone on this Pim, there is nobody to publish for, unless it already is. */}
          {account && (!account.alone || agent.published) && (
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
            {agent.majordomo ? null : confirming ? (
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
      {agent.majordomo && <MajordomoPreferencesSection agent={agent} />}
      <AgentApps agent={agent} />
    </>
  );
}

/**
 * How the majordomo talks with you and how much it handles on its own, as
 * at setup: each choice is saved as it is made.
 */
function MajordomoPreferencesSection({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data } = useQuery(majordomoQuery());
  const save = useMutation({
    mutationFn: pim.setMajordomoPreferences,
    onSuccess: (state) => {
      queryClient.setQueryData(majordomoQuery().queryKey, state);
      queryClient.invalidateQueries({ queryKey: ["agents"] });
    },
    onError: (error) => toast.error(error.message),
  });
  if (!data) return null;
  // What was just chosen shows while it saves.
  const preferences =
    save.isPending && save.variables ? save.variables : data.preferences;
  const change = (next: Partial<MajordomoPreferences>) =>
    save.mutate({ ...preferences, ...next });
  return (
    <section aria-label={t("majordomoPreferences", { name: agent.name })}>
      <Question label={t("toneLabel", { name: agent.name })}>
        {MAJORDOMO_TONES.map((choice) => (
          <Chip
            key={choice}
            selected={preferences.tone === choice}
            onSelect={() =>
              change({
                tone: preferences.tone === choice ? null : choice,
                customTone: null,
              })
            }
          >
            {t(toneKey[choice])}
          </Chip>
        ))}
        <WriteYourOwn
          shape="pill"
          value={preferences.customTone}
          onChange={(customTone) =>
            change({
              customTone,
              ...(customTone !== null ? { tone: null } : {}),
            })
          }
        />
      </Question>
      <InvolvementBar
        label={t("involvementLabel", { name: agent.name })}
        value={preferences.involvement}
        onChange={(involvement) => change({ involvement })}
      />
    </section>
  );
}

/**
 * The apps an agent works with: those of the blueprint it is based on, then
 * its own, each connectable from here unless it already is. A connected
 * app's tools each have a switch: on, the agent uses the tool without
 * asking; off, it can't use it.
 */
function AgentApps({ agent }: { agent: Agent }) {
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
  const { data: tools = [] } = useQuery(agentPermissionsQuery(agent.id));
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
  const set = useMutation({
    mutationFn: ({ info, on }: { info: ToolPermissionInfo; on: boolean }) =>
      pim.setAgentPermission(
        agent.id,
        info.app ?? "",
        info.tool,
        on ? "on" : "off",
      ),
    onSuccess: (next) =>
      queryClient.setQueryData(
        agentPermissionsQuery(agent.id).queryKey,
        (all) =>
          all?.map((info) =>
            info.app === next.app && info.tool === next.tool ? next : info,
          ),
      ),
    onError: (error) => toast.error(error.message),
  });
  return (
    <section className="mt-6 space-y-2" aria-label={t("suggestedApps")}>
      <h3 className="text-[13px] text-muted-foreground">
        {t("suggestedApps")}
      </h3>
      {apps.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noAgentApps")}</p>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {apps.map((app) => {
            const server = connected.find(
              (candidate) => candidate.app === app.ref,
            );
            const ready = server?.state === "ready";
            const own = ready
              ? tools.filter((info) => info.app === server.id)
              : [];
            return (
              <li key={app.ref}>
                <Collapsible>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <AppIcon
                      name={app.name}
                      icon={app.icon}
                      className="size-6 text-xs"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {app.name}
                    </span>
                    {ready ? (
                      <CollapsibleTrigger className="group flex items-center gap-1 rounded-md text-[13px] text-muted-foreground hover:text-foreground">
                        {t("toolsOn", {
                          on: own.filter((info) => info.permission === "on")
                            .length,
                          count: own.length,
                        })}
                        <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                      </CollapsibleTrigger>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => connect.mutate(app.ref)}
                        disabled={connect.isPending}
                      >
                        {t("connect")}
                      </Button>
                    )}
                  </div>
                  <CollapsibleContent>
                    <ul
                      className="divide-y border-t bg-muted/20"
                      aria-label={t("toolsOf", { name: app.name })}
                    >
                      {own.map((info) => (
                        <AgentToolRow
                          key={info.tool}
                          info={info}
                          pending={
                            set.isPending &&
                            set.variables?.info.app === info.app &&
                            set.variables.info.tool === info.tool
                          }
                          onChange={(on) => set.mutate({ info, on })}
                        />
                      ))}
                    </ul>
                  </CollapsibleContent>
                </Collapsible>
              </li>
            );
          })}
        </ul>
      )}
      {apps.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("agentToolsHint", { name: agent.name })}
        </p>
      )}
    </section>
  );
}

/** One of an app's tools, with its switch for the agent. */
function AgentToolRow({
  info,
  pending,
  onChange,
}: {
  info: ToolPermissionInfo;
  pending: boolean;
  onChange: (on: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <li className="flex items-center gap-3 py-2.5 pr-3 pl-12">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate font-mono text-[13px]">{info.tool}</span>
          {info.destructive && (
            <span className="shrink-0 rounded-full bg-secondary px-2 text-[11px] text-muted-foreground">
              {t("destructiveTool")}
            </span>
          )}
        </span>
        {info.description && (
          <span
            className="block truncate text-muted-foreground text-xs"
            title={info.description}
          >
            {info.description}
          </span>
        )}
        {info.changed && (
          <span className="mt-1 flex items-start gap-1.5 text-muted-foreground text-xs">
            <AlertCircle className="mt-px size-3.5 shrink-0" />
            {t("agentToolChanged")}
          </span>
        )}
      </span>
      <Switch
        checked={info.permission === "on"}
        onCheckedChange={onChange}
        disabled={pending}
        aria-label={t("useTool", { tool: info.tool })}
      />
    </li>
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
  const nameId = useId();
  // An image chosen but not uploaded yet shows from the browser.
  const [preview, setPreview] = useState<string>();
  useEffect(() => {
    if (!(look.image instanceof Blob)) return setPreview(undefined);
    const url = URL.createObjectURL(look.image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [look.image]);
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
      <div className="space-y-1">
        <label
          htmlFor={nameId}
          className="block font-normal text-[13px] text-muted-foreground"
        >
          {t("agentName")}
        </label>
        {/* How it looks is chosen from its icon, beside its name, as at setup. */}
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={t("changeLook")}
                title={t("changeLook")}
                className="relative shrink-0 rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
              >
                <AgentIcon
                  agent={{
                    id: agent?.id ?? "",
                    icon: look.image === "saved" ? (agent?.icon ?? null) : null,
                    symbol: look.symbol,
                    color: look.color,
                  }}
                  src={preview}
                  tile
                  className="size-9 rounded-xl"
                />
                <span className="-right-1.5 -bottom-1.5 absolute flex size-4.5 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border">
                  <Pencil className="size-2.5" />
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-3">
              <CompactLookPicker value={look} onChange={setLook} />
            </PopoverContent>
          </Popover>
          <Input
            id={nameId}
            value={value.name}
            onChange={(event) =>
              setValue({ ...value, name: event.target.value })
            }
            placeholder={t("agentNamePlaceholder")}
            maxLength={60}
            required
          />
        </div>
      </div>
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
