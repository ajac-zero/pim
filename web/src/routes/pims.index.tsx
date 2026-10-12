import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Bot,
  Globe,
  ImagePlus,
  MessageCircle,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "~/components/i18n";
import { EmptyState, Page } from "~/components/page";
import { iconFromFile, PimIcon } from "~/components/pim-icon";
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
  admin,
  type Persona,
  type PersonaInput,
  pim,
  type SuggestedApp,
  type TeamMember,
} from "~/lib/pim-api";
import {
  accountQuery,
  appsQuery,
  defaultPimQuery,
  extensionsQuery,
  personasQuery,
} from "~/lib/queries";

export const Route = createFileRoute("/pims/")({
  loader: ({ context }) => context.queryClient.ensureQueryData(personasQuery()),
  component: PimsPage,
});

const EMPTY: PersonaInput = {
  name: "",
  description: "",
  instructions: "",
  apps: [],
  team: [],
};

/** Your Pims: named agents with their own instructions, your default one first. */
function PimsPage() {
  const { t } = useI18n();
  const { data: personas = [] } = useQuery(personasQuery());
  const [creating, setCreating] = useState(false);
  return (
    <Page title={t("yourPims")} description={t("yourPimsDescription")}>
      <div className="space-y-3">
        {personas.length === 0 && !creating && (
          <EmptyState icon={<Bot className="size-5" />} text={t("noPims")} />
        )}
        {personas.map((persona) => (
          <PersonaCard key={persona.id} persona={persona} />
        ))}
        {creating ? (
          <PersonaForm
            initial={EMPTY}
            onDone={() => setCreating(false)}
            onCancel={() => setCreating(false)}
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setCreating(true)}>
              <Plus /> {t("newPim")}
            </Button>
            <DiscoverLink />
          </div>
        )}
      </div>
    </Page>
  );
}

/** The gallery, where Pims others on this Pim published are. */
function DiscoverLink() {
  const { t } = useI18n();
  const { data: account } = useQuery(accountQuery());
  if (!account) return null;
  return (
    <Button variant="outline" asChild>
      <Link to="/discover">
        <Globe /> {t("findPims")}
      </Link>
    </Button>
  );
}

function PersonaCard({ persona }: { persona: Persona }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: account } = useQuery(accountQuery());
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isAdmin = account?.role === "admin";
  const { data: everyones } = useQuery({
    ...defaultPimQuery(),
    enabled: isAdmin,
  });
  const forEveryone = everyones?.personaId === persona.id;
  const choose = useMutation({
    mutationFn: (on: boolean) => admin.setDefaultPim(on ? persona.id : null),
    onSuccess: (chosen) => {
      queryClient.setQueryData(defaultPimQuery().queryKey, chosen);
      toast.success(
        chosen
          ? t("everyonesDefaultSet", { name: persona.name })
          : t("everyonesDefaultCleared"),
      );
    },
    onError: (error) => toast.error(error.message),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["personas"] });
  const makeDefault = useMutation({
    mutationFn: () => pim.makeDefaultPersona(persona.id),
    onSuccess: () => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
      toast.success(t("madeDefault", { name: persona.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: () => pim.deletePersona(persona.id),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const setIcon = useMutation({
    mutationFn: async (file: File) =>
      pim.setPersonaIcon(persona.id, await iconFromFile(file)),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const removeIcon = useMutation({
    mutationFn: () => pim.removePersonaIcon(persona.id),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const publish = useMutation({
    mutationFn: async (on: boolean) => {
      if (on) await pim.publishPersona(persona.id);
      else await pim.unpublishPersona(persona.id);
    },
    onSuccess: (_result, on) => {
      refresh();
      queryClient.invalidateQueries({ queryKey: ["templates"] });
      toast.success(t(on ? "pimPublished" : "pimUnpublished"));
    },
    onError: (error) => toast.error(error.message),
  });

  if (editing) {
    return (
      <PersonaForm
        id={persona.id}
        initial={persona}
        onDone={() => setEditing(false)}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <article className="rounded-xl border px-4 py-3" aria-label={persona.name}>
      <div className="flex items-start gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10 text-primary">
          <PimIcon
            persona={persona}
            className={
              persona.icon === null ? "size-4.5" : "size-8 rounded-none"
            }
          />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 font-medium">
            <Link
              to="/pims/$pimId"
              params={{ pimId: persona.id }}
              className="truncate underline-offset-2 hover:underline"
            >
              {persona.name}
            </Link>
            {persona.default && (
              <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 font-normal text-primary text-xs">
                {t("defaultPim")}
              </span>
            )}
          </h2>
          {persona.description && (
            <p className="text-muted-foreground text-sm">
              {persona.description}
            </p>
          )}
          <p className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground text-xs">
            <BuildsOn base={persona.base} />
            {persona.source && (
              <span>
                {t("fromTemplateBy")}{" "}
                <Link
                  to="/people/$username"
                  params={{ username: persona.source.author }}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  @{persona.source.author}
                </Link>
              </span>
            )}
            {persona.published && (
              <span className="flex items-center gap-1 text-green-700 dark:text-green-500">
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
      {persona.instructions && (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-sm">
          {persona.instructions}
        </p>
      )}
      {persona.apps.length > 0 && <SuggestedApps apps={persona.apps} />}
      {persona.team.length > 0 && (
        <ul
          className="mt-2 flex flex-wrap gap-1.5"
          aria-label={t("teamOf", { name: persona.name })}
        >
          {persona.team.map((member) => (
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
          onClick={() => navigate({ to: "/new", search: { pim: persona.id } })}
        >
          <MessageCircle /> {t("chatWithPim")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil /> {t("edit")}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          aria-label={t("uploadIcon")}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) setIcon.mutate(file);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInput.current?.click()}
          disabled={setIcon.isPending}
        >
          <ImagePlus /> {t("uploadIcon")}
        </Button>
        {persona.icon !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => removeIcon.mutate()}
            disabled={removeIcon.isPending}
          >
            {t("removeIcon")}
          </Button>
        )}
        {account && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => publish.mutate(true)}
            disabled={publish.isPending}
          >
            <Globe /> {t(persona.published ? "updatePublished" : "publish")}
          </Button>
        )}
        {account && persona.published && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => publish.mutate(false)}
            disabled={publish.isPending}
          >
            {t("unpublish")}
          </Button>
        )}
        {!persona.default && (
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
          {persona.default ? null : confirming ? (
            <span className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {t("deletePim")}
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
              aria-label={t("deletePimNamed", { name: persona.name })}
              title={t("deletePimNamed", { name: persona.name })}
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

/** Apps a Pim works with, each connectable from here unless it already is. */
function SuggestedApps({ apps }: { apps: SuggestedApp[] }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: connected = [] } = useQuery(appsQuery());
  const connect = useMutation({
    mutationFn: pim.connectApp,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["permissions"] });
      if (result.authUrl) window.open(result.authUrl, "_blank", "noopener");
      else toast.success(t("appConnected"));
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("suggestedApps")}>
      {apps.map((app) => {
        const known = connected.some(
          (server) => server.url === app.url && server.state === "ready",
        );
        return (
          <li
            key={app.url}
            className="flex items-center gap-1.5 rounded-full border py-0.5 pr-1 pl-2.5 text-xs"
            title={app.url}
          >
            <Plug className="size-3 text-muted-foreground" />
            {app.name}
            {known ? (
              <span className="px-1.5 text-muted-foreground">
                {t("connected")}
              </span>
            ) : (
              <button
                type="button"
                className="rounded-full bg-primary px-2 py-0.5 text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
                onClick={() => connect.mutate(app)}
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

/** The name of the extension's Pim a Pim builds on, from what the deployment installed. */
function useBaseName(base: string | null | undefined): string | null {
  const { data } = useQuery(extensionsQuery());
  if (!base) return null;
  const pim = data?.extensions
    .flatMap((extension) => extension.pims)
    .find((candidate) => candidate.ref === base);
  return pim?.name ?? base;
}

function BuildsOn({ base }: { base: string | null }) {
  const { t } = useI18n();
  const name = useBaseName(base);
  return (
    <span className="flex items-center gap-1">
      <Puzzle className="size-3" />
      {name ? t("buildsOnName", { name }) : t("buildsOnNothing")}
    </span>
  );
}

/** Which extension's Pim a Pim builds on: its habits, abilities and dashboard. */
function BaseSelect({
  value,
  onChange,
}: {
  value: string | null | undefined;
  onChange: (base: string | null) => void;
}) {
  const { t } = useI18n();
  const { data } = useQuery(extensionsQuery());
  if (!data) return null;
  const chosen = value === undefined ? data.defaultPim : value;
  return (
    <label className="block space-y-1">
      <span className="font-medium text-sm">{t("buildsOn")}</span>
      <Select
        value={chosen ?? NOTHING}
        onValueChange={(next) => onChange(next === NOTHING ? null : next)}
      >
        <SelectTrigger className="w-full" aria-label={t("buildsOn")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {data.extensions.flatMap((extension) =>
            extension.pims.map((pim) => (
              <SelectItem key={pim.ref} value={pim.ref}>
                {pim.name === extension.name
                  ? pim.name
                  : `${pim.name} · ${extension.name}`}
              </SelectItem>
            )),
          )}
          <SelectItem value={NOTHING}>{t("buildsOnNothingOption")}</SelectItem>
        </SelectContent>
      </Select>
      <span className="block text-muted-foreground text-xs">
        {t("buildsOnHint")}
      </span>
    </label>
  );
}

/** The select's value for building on nothing: Radix needs a non-empty one. */
const NOTHING = "-";

function PersonaForm({
  id,
  initial,
  onDone,
  onCancel,
}: {
  id?: string;
  initial: PersonaInput;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // Each app and member row keeps a key of its own while edited, so removing one doesn't shift the others' inputs.
  const [value, setValue] = useState<
    Omit<PersonaInput, "apps" | "team"> & {
      apps: (SuggestedApp & { key: string })[];
      team: (Omit<TeamMember, "tools"> & { tools: string; key: string })[];
    }
  >({
    name: initial.name,
    description: initial.description,
    instructions: initial.instructions,
    base: initial.base,
    apps: initial.apps.map((app) => ({ ...app, key: crypto.randomUUID() })),
    team: initial.team.map((member) => ({
      ...member,
      tools: member.tools?.join(", ") ?? "",
      key: crypto.randomUUID(),
    })),
  });
  const save = useMutation({
    mutationFn: () => {
      const { base, ...rest } = value;
      const input: PersonaInput = {
        ...rest,
        ...(base === undefined ? {} : { base }),
        apps: value.apps.map(({ name, url }) => ({ name, url })),
        team: value.team.map(({ name, instructions, tools }) => {
          const names = tools
            .split(",")
            .map((tool) => tool.trim())
            .filter(Boolean);
          return { name, instructions, tools: names.length > 0 ? names : null };
        }),
      };
      return id ? pim.updatePersona(id, input) : pim.createPersona(input);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["personas"] });
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
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
  const setApp = (key: string, app: Partial<SuggestedApp>) =>
    setValue({
      ...value,
      apps: value.apps.map((current) =>
        current.key === key ? { ...current, ...app } : current,
      ),
    });

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-xl border px-4 py-4"
      aria-label={id ? t("editPim") : t("newPim")}
    >
      <label className="block space-y-1">
        <span className="font-medium text-sm">{t("pimName")}</span>
        <Input
          value={value.name}
          onChange={(event) => setValue({ ...value, name: event.target.value })}
          placeholder={t("pimNamePlaceholder")}
          maxLength={60}
          required
        />
      </label>
      <label className="block space-y-1">
        <span className="font-medium text-sm">{t("pimDescription")}</span>
        <Input
          value={value.description}
          onChange={(event) =>
            setValue({ ...value, description: event.target.value })
          }
          placeholder={t("pimDescriptionPlaceholder")}
          maxLength={280}
        />
      </label>
      <BaseSelect
        value={value.base}
        onChange={(base) => setValue({ ...value, base })}
      />
      <label className="block space-y-1">
        <span className="font-medium text-sm">{t("pimInstructions")}</span>
        <textarea
          value={value.instructions}
          onChange={(event) =>
            setValue({ ...value, instructions: event.target.value })
          }
          placeholder={t("pimInstructionsPlaceholder")}
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
        {value.apps.map((app) => (
          <div key={app.key} className="flex gap-2">
            <Input
              value={app.name}
              onChange={(event) =>
                setApp(app.key, { name: event.target.value })
              }
              placeholder={t("appName")}
              aria-label={t("appName")}
              className="max-w-40"
            />
            <Input
              value={app.url}
              onChange={(event) => setApp(app.key, { url: event.target.value })}
              placeholder="https://…/mcp"
              aria-label={t("appUrl")}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("removeApp")}
              onClick={() =>
                setValue({
                  ...value,
                  apps: value.apps.filter((other) => other.key !== app.key),
                })
              }
            >
              <X />
            </Button>
          </div>
        ))}
        {value.apps.length < 10 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setValue({
                ...value,
                apps: [
                  ...value.apps,
                  { name: "", url: "", key: crypto.randomUUID() },
                ],
              })
            }
          >
            <Plus /> {t("addApp")}
          </Button>
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
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
