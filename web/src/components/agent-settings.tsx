import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
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
  Blocks,
  ChevronDown,
  Globe,
  MessageCircle,
  Pencil,
  Plus,
  Puzzle,
  Search,
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
  type ToolPermissionInfo,
} from "~/lib/pim-api";
import {
  accountQuery,
  agentPermissionsQuery,
  agentsQuery,
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
  contacts: [],
};

/** The frame of an agent's pages: a readable column of the main content. */
function AgentPageFrame({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 md:px-8">
        {children}
      </div>
    </main>
  );
}

/** Making an agent: once it exists, its page opens, where its apps are added. */
export function NewAgentPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <AgentPageFrame>
      <h1 className="mb-8 font-semibold text-xl">{t("newAgent")}</h1>
      <AgentForm
        onDone={(saved) =>
          navigate({
            to: "/agents/$agentId/settings",
            params: { agentId: saved.id },
          })
        }
      />
    </AgentPageFrame>
  );
}

/**
 * An agent's page: what it is and the actions on it, then how the majordomo
 * works with you, the apps it works with and their tools, and its details,
 * which save together.
 */
export function AgentSettingsPage({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: account } = useQuery(accountQuery());
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
      navigate({ to: "/" });
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

  return (
    <AgentPageFrame>
      <header className="flex items-start gap-3">
        <AgentIcon agent={agent} tile className="size-10 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 font-semibold text-xl">
            <span className="truncate">{agent.name}</span>
            {agent.majordomo && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-normal text-primary text-xs">
                {t("majordomoBadge")}
              </span>
            )}
          </h1>
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
      </header>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button size="sm" asChild>
          <Link to="/agents/$agentId" params={{ agentId: agent.id }}>
            <MessageCircle /> {t("chatWithAgent")}
          </Link>
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
      {agent.majordomo && <MajordomoPreferencesSection agent={agent} />}
      <AgentApps agent={agent} />
      <section className="mt-8" aria-label={t("agentDetails")}>
        <h2 className="mb-3 text-[13px] text-muted-foreground">
          {t("agentDetails")}
        </h2>
        {/* Saved, it starts again from what was saved. */}
        <AgentForm key={agent.updatedAt} agent={agent} />
      </section>
    </AgentPageFrame>
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
    <section
      className="mt-6"
      aria-label={t("majordomoPreferences", { name: agent.name })}
    >
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
 * its own, which can be taken off. Apps are added from those already
 * connected, and connected in Apps; one listed but not connected yet
 * connects from here. A connected app's tools each have a switch: on, the
 * agent uses the tool without asking; off, it can't use it.
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
  // Its own apps save as they change, apart from its other details.
  const change = useMutation({
    mutationFn: (own: string[]) => pim.updateAgent(agent.id, { apps: own }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      queryClient.invalidateQueries({ queryKey: ["permissions"] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <section className="mt-8 space-y-2" aria-label={t("suggestedApps")}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] text-muted-foreground">
          {t("suggestedApps")}
        </h2>
        <AddApp
          listed={apps.map((app) => app.ref)}
          full={agent.apps.length >= MAX_AGENT_APPS}
          onAdd={(ref) => change.mutate([...agent.apps, ref])}
        />
      </div>
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
                    {/* The blueprint's apps come with it: only the agent's own are taken off. */}
                    {agent.apps.includes(app.ref) && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-muted-foreground"
                        aria-label={t("removeAppFrom", { name: app.name })}
                        title={t("removeAppFrom", { name: app.name })}
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate(
                            agent.apps.filter((ref) => ref !== app.ref),
                          )
                        }
                      >
                        <X />
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

/** How many apps of its own an agent can have, as the API allows. */
const MAX_AGENT_APPS = 10;

/**
 * Adds one of the apps you connected, found by its name or what it does.
 * Apps not connected yet are connected in Apps, which it opens.
 */
function AddApp({
  listed,
  full,
  onAdd,
}: {
  /** The apps the agent already works with, which aren't offered. */
  listed: string[];
  full: boolean;
  onAdd: (ref: string) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data: directory = [] } = useQuery(appDirectoryQuery());
  const { data: connected = [] } = useQuery(appsQuery());
  const yours = connected.flatMap((server) =>
    server.app === null
      ? []
      : (directory.find((app) => app.ref === server.app) ?? []),
  );
  const query = search.trim().toLowerCase();
  const offered = yours.filter(
    (app) =>
      !listed.includes(app.ref) &&
      `${app.name} ${app.description}`.toLowerCase().includes(query),
  );
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Each time it opens, it starts from all your apps.
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="secondary" disabled={full}>
          <Plus /> {t("addApp")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-2">
        <div className="relative">
          <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("searchYourApps")}
            aria-label={t("searchYourApps")}
            className="h-8 border-transparent bg-muted pl-8 text-sm shadow-none focus-visible:ring-0"
            autoFocus
          />
        </div>
        {offered.length === 0 ? (
          <p className="px-2 py-3 text-muted-foreground text-sm">
            {t(
              yours.length === 0
                ? "noConnectedApps"
                : query
                  ? "noAppsMatch"
                  : "allAppsAdded",
            )}
          </p>
        ) : (
          <ul className="mt-1 max-h-64 overflow-y-auto">
            {offered.map((app) => (
              <li key={app.ref}>
                <button
                  type="button"
                  onClick={() => {
                    onAdd(app.ref);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent"
                >
                  <AppIcon
                    name={app.name}
                    icon={app.icon}
                    className="size-6 text-xs"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{app.name}</span>
                    {app.description && (
                      <span className="block truncate text-muted-foreground text-xs">
                        {app.description}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-1 border-t pt-1">
          <Link
            to="."
            search={(prev) => ({ ...prev, dialog: "apps", tab: undefined })}
            onClick={() => {
              setOpen(false);
              setSearch("");
            }}
            className="flex items-center gap-2 rounded-lg px-2 py-2 text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
          >
            <Blocks className="size-4" /> {t("connectMoreApps")}
          </Link>
        </div>
      </PopoverContent>
    </Popover>
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

/**
 * An agent's details: how it looks, its name, what it's for, its blueprint,
 * instructions and contacts. Its apps are chosen on its page, where they save as
 * they change, so saving these leaves them as they are.
 */
function AgentForm({
  agent,
  onDone,
}: {
  /** The agent to edit; left out, the form makes a new one. */
  agent?: Agent;
  onDone?: (saved: Agent) => void;
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
  const [value, setValue] = useState<Omit<AgentInput, "apps">>({
    name: initial.name,
    description: initial.description,
    instructions: initial.instructions,
    blueprint: initial.blueprint,
    contacts: initial.contacts,
  });
  const save = useMutation({
    mutationFn: async () => {
      const { blueprint, ...rest } = value;
      const input: Omit<AgentInput, "apps"> = {
        ...rest,
        symbol: look.symbol,
        color: look.color,
        ...(blueprint === undefined ? {} : { blueprint }),
      };
      const saved = agent
        ? await pim.updateAgent(agent.id, input)
        : await pim.createAgent({ ...input, apps: [] });
      // An uploaded image shows in place of the symbol, so it is sent, or taken away, once the agent exists.
      if (look.image instanceof Blob)
        await pim.setAgentIcon(saved.id, look.image);
      else if (look.image === null && saved.icon !== null) {
        await pim.removeAgentIcon(saved.id);
      }
      return saved;
    },
    onSuccess: async (saved) => {
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      if (agent) toast.success(t("agentSaved"));
      onDone?.(saved);
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

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
      <ContactsField
        agent={agent}
        value={value.contacts}
        onChange={(contacts) => setValue({ ...value, contacts })}
      />
      <div className="flex justify-end gap-2 border-t pt-5">
        <Button type="submit" disabled={save.isPending || !value.name.trim()}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/**
 * The agents an agent hands tasks to: any of your others but your majordomo,
 * each switched on or off. Your majordomo hands tasks to all of them.
 */
function ContactsField({
  agent,
  value,
  onChange,
}: {
  agent?: Agent;
  value: string[];
  onChange: (contacts: string[]) => void;
}) {
  const { t } = useI18n();
  const { data: agents } = useQuery(agentsQuery());
  const others =
    agents?.filter((other) => !other.majordomo && other.id !== agent?.id) ?? [];
  return (
    <fieldset className="space-y-2">
      <legend className="font-medium text-sm">{t("contacts")}</legend>
      <p className="text-muted-foreground text-xs">
        {agent?.majordomo ? t("majordomoContacts") : t("contactsHint")}
      </p>
      {!agent?.majordomo &&
        (others.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("noContacts")}</p>
        ) : (
          <ul className="divide-y rounded-xl border">
            {others.map((other) => (
              <li
                key={other.id}
                className="flex items-center gap-3 px-3 py-2.5 text-sm"
              >
                <AgentIcon agent={other} tile className="size-8 rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{other.name}</span>
                  {other.description && (
                    <span className="block truncate text-muted-foreground text-xs">
                      {other.description}
                    </span>
                  )}
                </span>
                <Switch
                  checked={value.includes(other.id)}
                  onCheckedChange={(checked) =>
                    onChange(
                      checked
                        ? [...value, other.id]
                        : value.filter((id) => id !== other.id),
                    )
                  }
                  aria-label={t("handTasksTo", { name: other.name })}
                />
              </li>
            ))}
          </ul>
        ))}
    </fieldset>
  );
}
