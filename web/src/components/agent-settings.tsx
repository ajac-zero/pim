import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  AgentIcon,
  CompactLookPicker,
  type LookChoice,
} from "~/components/agent-icon";
import { AppIcon } from "~/components/app-icon";
import { BotShareButton } from "~/components/bot-share";
import { ModelMark, useAgentModel } from "~/components/chat/model-menu";
import { useSaveContacts } from "~/components/contact-map";
import { useI18n } from "~/components/i18n";
import {
  AlertCircle,
  Blocks,
  ChevronDown,
  ChevronUpIcon,
  Globe,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  Workflow,
  X,
} from "~/components/icons";
import {
  Chip,
  InvolvementBar,
  Question,
  toneKey,
  WriteYourOwn,
} from "~/components/majordomo-setup";
import { AgentMemoryField } from "~/components/memory-settings";
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
  type ModelInfo,
  type ModelSettings,
  pim,
  type ToolPermissionInfo,
} from "~/lib/pim-api";
import {
  accountQuery,
  agentPermissionsQuery,
  agentSkillsPermissionQuery,
  agentsQuery,
  appDirectoryQuery,
  appsQuery,
  defaultAgentQuery,
  majordomoQuery,
} from "~/lib/queries";
import { newChatSearch } from "~/lib/start-chat";
import { modelName } from "~/lib/utils";

const EMPTY: AgentInput = {
  name: "",
  description: "",
  instructions: "",
  apps: [],
  contacts: [],
};

/** Making an agent: once it exists, `onCreated` shows its settings, where its connectors are added. */
export function NewAgent({ onCreated }: { onCreated: (agent: Agent) => void }) {
  const { t } = useI18n();
  return (
    <>
      <h2 className="mb-8 pr-8 font-semibold text-xl">{t("newAgent")}</h2>
      <AgentForm onDone={onCreated} />
    </>
  );
}

/**
 * An agent's settings: what it is and the actions on it, then how the
 * majordomo works with you, the connectors it works with and their tools, its
 * contacts, and its details, which save together. `onDeleted` says where to go once it's gone.
 */
export function AgentSettings({
  agent,
  onDeleted,
  onShowNetwork,
}: {
  agent: Agent;
  onDeleted: () => void;
  /** Opens the network of your agents, with this one chosen, or none for the majordomo. */
  onShowNetwork: (agent: string | null) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
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
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agents"] });
  const remove = useMutation({
    mutationFn: () => pim.deleteAgent(agent.id),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onDeleted();
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
    <>
      {/* Clear of the dialog's close button. */}
      <header className="flex items-start gap-3 pr-8">
        <AgentIcon agent={agent} tile className="size-10 rounded-xl" />
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-semibold text-xl">
            <span className="truncate">{agent.name}</span>
          </h2>
          <p className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground text-xs">
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
          <Link to="." search={newChatSearch(agent.id)}>
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
        {/* The admin pays for guests, so only the admin shares bots. */}
        {isAdmin && !agent.majordomo && <BotShareButton agent={agent} />}
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
      <AgentModels agent={agent} />
      <AgentApps agent={agent} />
      <AgentSkills agent={agent} />
      <AgentContacts agent={agent} onShowNetwork={onShowNetwork} />
      <section className="mt-8" aria-label={t("agentDetails")}>
        <h2 className="mb-3 text-[13px] text-muted-foreground">
          {t("agentDetails")}
        </h2>
        {/* Saved, it starts again from what was saved. */}
        <AgentForm key={agent.updatedAt} agent={agent} />
      </section>
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
 * The connectors an agent works with, which can be taken off. Connectors are added from those already
 * connected, and connected in Connectors; one listed but not connected yet
 * connects from here. A connected connector's tools each have a switch: on, the
 * agent uses the tool without asking; off, it can't use it.
 */
function AgentApps({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const { data: directory = [] } = useQuery(appDirectoryQuery());
  const apps = agent.apps.flatMap(
    (ref) => directory.find((app) => app.ref === ref) ?? [],
  );
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
  // Its own connectors save as they change, apart from its other details.
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

/**
 * Whether agents may change an agent's skills: on, it writes and installs
 * them, asking first as write_skill's permission and the approval policy
 * say, and the majordomo may for it; off, none does. Only you switch it.
 */
export function AgentSkills({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: info, error } = useQuery(agentSkillsPermissionQuery(agent.id));
  const set = useMutation({
    mutationFn: (on: boolean) =>
      pim.setAgentPermission(agent.id, "", "write_skill", on ? "on" : "off"),
    onSuccess: (next) =>
      queryClient.setQueryData(
        agentSkillsPermissionQuery(agent.id).queryKey,
        next,
      ),
    onError: (error) => toast.error(error.message),
  });
  if (!info && !error) return null;
  // What was just chosen shows while it saves.
  const on = set.isPending ? set.variables : info?.permission === "on";
  return (
    <section className="mt-8 space-y-2" aria-label={t("agentSkills")}>
      <h2 className="text-[13px] text-muted-foreground">{t("agentSkills")}</h2>
      {!info ? (
        <p role="alert" className="text-muted-foreground text-sm">
          {t("writeSkillsUnavailable", {
            name: agent.name,
            error: error?.message ?? "",
          })}
        </p>
      ) : (
        <div className="flex items-center gap-3 rounded-xl border px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm">{t("writeSkills")}</span>
            <span className="block text-muted-foreground text-xs">
              {t(
                agent.majordomo
                  ? "writeSkillsHintMajordomo"
                  : "writeSkillsHint",
                {
                  name: agent.name,
                },
              )}
            </span>
          </span>
          <Switch
            checked={on}
            onCheckedChange={(next) => set.mutate(next)}
            disabled={set.isPending}
            aria-label={t("writeSkills")}
          />
        </div>
      )}
    </section>
  );
}

/** How many connectors of its own an agent can have, as the API allows. */
const MAX_AGENT_APPS = 10;

/**
 * Adds one of the connectors you connected, found by its name or what it does.
 * Connectors not connected yet are connected in Connectors, which it opens.
 */
function AddApp({
  listed,
  full,
  onAdd,
}: {
  /** The connectors the agent already works with, which aren't offered. */
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
        // Each time it opens, it starts from all your connectors.
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

/** One of a connector's tools, with its switch for the agent. */
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

/**
 * The agents an agent hands tasks to, each of which can be taken off. They are
 * added in the network of your agents, where Add contacts goes with this agent
 * chosen. Your majordomo hands tasks to all of them, so it has no list.
 */
/**
 * The models an agent runs on, in order: the first is the one it runs on, and
 * the rest are the ones it moves on to when that fails for good, such as when
 * its provider's quota is used up.
 */
function AgentModels({ agent }: { agent: Agent }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { settings, current, pinned } = useAgentModel(agent.id);
  const save = useMutation({
    mutationFn: async (models: ModelInfo[]) => {
      const [first, ...rest] = models;
      if (
        first &&
        !(first.provider === current?.provider && first.id === current.id)
      ) {
        await pim.chooseAgentModel(agent.id, first);
      }
      return pim.setAgentFallbacks(agent.id, rest);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
    onError: (error) => toast.error(error.message),
  });
  if (!settings || !current) return null;
  const models = [
    current,
    ...agent.fallbacks.flatMap(
      (fallback) =>
        settings.choices.find((choice) => same(choice, fallback)) ?? [],
    ),
  ];
  return (
    <section className="mt-8 space-y-2" aria-label={t("agentModels")}>
      <h2 className="text-[13px] text-muted-foreground">{t("agentModels")}</h2>
      <p className="text-muted-foreground text-xs">
        {t("fallbackModelsHint", { name: agent.name })}
      </p>
      <ModelOrderList
        settings={settings}
        models={models}
        minimum={1}
        defaultTag={!pinned}
        pending={save.isPending}
        onChange={(next) => save.mutate(next)}
      />
    </section>
  );
}

const same = (
  a: { provider: string; id: string },
  b: { provider: string; id: string },
) => a.provider === b.provider && a.id === b.id;

/**
 * Models in the order they are tried, each of which can be moved or taken off,
 * with the choices not yet in it to add. An agent's list starts with the model
 * it runs on and always keeps one; the space's holds only fallbacks, so it can
 * be empty.
 */
export function ModelOrderList({
  settings,
  models,
  minimum,
  defaultTag,
  pending,
  onChange,
}: {
  settings: ModelSettings;
  models: ModelInfo[];
  minimum: number;
  defaultTag: boolean;
  pending: boolean;
  onChange: (models: ModelInfo[]) => void;
}) {
  const { t } = useI18n();
  const unused = settings.choices.filter(
    (choice) => !models.some((used) => same(used, choice)),
  );
  return (
    <>
      <ol className="divide-y overflow-hidden rounded-xl border empty:hidden">
        {models.map((model, index) => {
          const name = modelName(model.name);
          const move = (to: number) => {
            const next = [...models];
            next.splice(to, 0, ...next.splice(index, 1));
            onChange(next);
          };
          const button = "size-6 text-muted-foreground [&_svg]:size-3.5";
          return (
            <li
              key={`${model.provider}/${model.id}`}
              className="flex items-center gap-2 px-3 py-1 text-sm"
            >
              <span className="w-4 text-muted-foreground text-xs">
                {index + 1}
              </span>
              <ModelMark
                settings={settings}
                model={model}
                className="size-4 shrink-0 text-foreground"
              />
              <span className="min-w-0 flex-1 truncate">
                {name}
                {index === 0 && defaultTag && (
                  <span className="ml-2 text-muted-foreground text-xs">
                    {t("defaultModelTag")}
                  </span>
                )}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                className={button}
                aria-label={t("moveFallbackUp", { model: name })}
                title={t("moveFallbackUp", { model: name })}
                disabled={pending || index === 0}
                onClick={() => move(index - 1)}
              >
                <ChevronUpIcon />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className={button}
                aria-label={t("moveFallbackDown", { model: name })}
                title={t("moveFallbackDown", { model: name })}
                disabled={pending || index === models.length - 1}
                onClick={() => move(index + 1)}
              >
                <ChevronDown />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                className={button}
                aria-label={t("removeFallback", { model: name })}
                title={t("removeFallback", { model: name })}
                disabled={pending || models.length <= minimum}
                onClick={() =>
                  onChange(models.filter((other) => other !== model))
                }
              >
                <X />
              </Button>
            </li>
          );
        })}
      </ol>
      {unused.length > 0 && (
        <Select
          // Chosen, a model joins the list and the field is empty again.
          value=""
          onValueChange={(value) => {
            const added = unused.find(
              (choice) => `${choice.provider}/${choice.id}` === value,
            );
            if (added) onChange([...models, added]);
          }}
          disabled={pending}
        >
          <SelectTrigger className="w-full" aria-label={t("addFallback")}>
            <SelectValue placeholder={t("addFallback")} />
          </SelectTrigger>
          <SelectContent>
            {unused.map((choice) => (
              <SelectItem
                key={`${choice.provider}/${choice.id}`}
                value={`${choice.provider}/${choice.id}`}
              >
                {modelName(choice.name)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </>
  );
}

function AgentContacts({
  agent,
  onShowNetwork,
}: {
  agent: Agent;
  onShowNetwork: (agent: string | null) => void;
}) {
  const { t } = useI18n();
  const { data: agents = [] } = useQuery(agentsQuery());
  const save = useSaveContacts();
  const contacts = agent.contacts.flatMap(
    (id) => agents.find((other) => other.id === id) ?? [],
  );
  return (
    <section className="mt-8 space-y-2" aria-label={t("contacts")}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] text-muted-foreground">{t("contacts")}</h2>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onShowNetwork(agent.majordomo ? null : agent.id)}
        >
          {agent.majordomo ? <Workflow /> : <Plus />}
          {t(agent.majordomo ? "seeNetwork" : "addContacts")}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {agent.majordomo ? t("majordomoContacts") : t("contactsHint")}
      </p>
      {!agent.majordomo &&
        (contacts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noContactsYet")}</p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border">
            {contacts.map((contact) => (
              <li
                key={contact.id}
                className="flex items-center gap-3 px-3 py-2.5 text-sm"
              >
                <AgentIcon agent={contact} tile className="size-8 rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{contact.name}</span>
                  {contact.description && (
                    <span className="block truncate text-muted-foreground text-xs">
                      {contact.description}
                    </span>
                  )}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  aria-label={t("stopHandingTasks", {
                    from: agent.name,
                    to: contact.name,
                  })}
                  title={t("stopHandingTasks", {
                    from: agent.name,
                    to: contact.name,
                  })}
                  onClick={() =>
                    save.mutate({
                      from: agent.id,
                      contacts: agent.contacts.filter(
                        (id) => id !== contact.id,
                      ),
                    })
                  }
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

/**
 * An agent's details: how it looks, its name, what it's for and
 * instructions. Its connectors and contacts are chosen on its page, where they save as
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
  const [value, setValue] = useState<Omit<AgentInput, "apps" | "contacts">>({
    name: initial.name,
    role: agent?.role ?? "",
    description: initial.description,
    instructions: initial.instructions,
    memoryScopes: initial.memoryScopes ?? [],
  });
  const save = useMutation({
    mutationFn: async () => {
      const { role, ...rest } = value;
      const input: Omit<AgentInput, "apps" | "contacts"> = {
        ...rest,
        ...(role?.trim() ? { role: role.trim() } : {}),
        symbol: look.symbol,
        color: look.color,
      };
      const saved = agent
        ? await pim.updateAgent(agent.id, input)
        : await pim.createAgent({ ...input, apps: [], contacts: [] });
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
      {!agent?.majordomo && (
        <label className="block space-y-1">
          <span className="font-medium text-sm">{t("agentRole")}</span>
          <Input
            value={value.role ?? ""}
            onChange={(event) =>
              setValue({ ...value, role: event.target.value })
            }
            placeholder={t("agentRolePlaceholder")}
            maxLength={60}
          />
          <span className="block text-muted-foreground text-xs">
            {t("agentRoleHint")}
          </span>
        </label>
      )}
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
      {agent && (
        <AgentMemoryField
          agent={agent}
          value={value.memoryScopes ?? []}
          onChange={(memoryScopes) => setValue({ ...value, memoryScopes })}
        />
      )}
      <div className="flex justify-end gap-2 border-t pt-5">
        <Button type="submit" disabled={save.isPending || !value.name.trim()}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
