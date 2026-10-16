import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ExternalLink,
  ImageIcon,
  ListFilter,
  Plus,
  Search,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { AppIcon } from "~/components/app-icon";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  APP_CATEGORIES,
  type AppCategory,
  admin,
  type ConnectedApp,
  type DirectoryApp,
  pim,
} from "~/lib/pim-api";
import { accountQuery, appDirectoryQuery, appsQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/apps")({
  component: AppsPage,
});

type Category = AppCategory | "other";

const CATEGORY_LABELS = {
  productivity: "appCategoryProductivity",
  meetings: "appCategoryMeetings",
  development: "appCategoryDevelopment",
  data: "appCategoryData",
  finance: "appCategoryFinance",
  customers: "appCategoryCustomers",
  websites: "appCategoryWebsites",
  automation: "appCategoryAutomation",
  research: "appCategoryResearch",
  media: "appCategoryMedia",
  other: "appCategoryOther",
} as const;

const CATEGORIES: readonly Category[] = [...APP_CATEGORIES, "other"];

/** An app this Pim offers with your connection to it, or a connection to one it no longer offers. */
type Row = { app: DirectoryApp | null; connection: ConnectedApp | undefined };

/**
 * The apps this Pim offers, each with your connection to it: you connect an
 * app once, and every agent of yours that lists it works with it. Apps you
 * connected that it no longer offers can only be disconnected here. The
 * admin adds apps of their own, and takes them out.
 *
 * The page fits the window: its search and filters stay put while the
 * cards, grouped by category, scroll beneath them.
 */
function AppsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: account } = useQuery(accountQuery());
  const isAdmin = account?.role === "admin";
  const { data: directory } = useQuery(appDirectoryQuery());
  const { data: connections } = useQuery(appsQuery());
  const [query, setQuery] = useState("");
  const [onlyConnected, setOnlyConnected] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  // The admin's app whose icon they're changing.
  const [changingIcon, setChangingIcon] = useState<DirectoryApp | null>(null);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["apps"] });
    queryClient.invalidateQueries({ queryKey: ["permissions"] });
  };
  const onError = (error: Error) => toast.error(error.message);
  const connect = useMutation({
    mutationFn: (app: DirectoryApp) => pim.connectApp(app.ref),
    onSuccess: (result) => {
      refresh();
      if (result.authUrl) window.open(result.authUrl, "_blank", "noopener");
      else toast.success(t("appConnected"));
    },
    onError,
  });
  const disconnect = useMutation({
    mutationFn: (app: ConnectedApp) => pim.removeApp(app.id),
    onSuccess: (_result, app) => {
      refresh();
      toast.success(t("appRemoved", { name: app.name }));
    },
    onError,
  });
  const unlist = useMutation({
    mutationFn: (app: DirectoryApp) =>
      admin.removeApp(app.ref.slice(app.ref.indexOf("/") + 1)),
    onSuccess: (_result, app) => {
      queryClient.invalidateQueries({ queryKey: ["app-directory"] });
      toast.success(t("appUnlisted", { name: app.name }));
    },
    onError,
  });

  const rows: Row[] = [
    ...(directory ?? []).map((app) => ({
      app,
      connection: connections?.find((candidate) => candidate.app === app.ref),
    })),
    ...(connections ?? [])
      .filter((connection) => connection.app === null)
      .map((connection) => ({ app: null, connection })),
  ];
  const categoryOf = (row: Row): Category => row.app?.category ?? "other";
  const label = (category: Category) => t(CATEGORY_LABELS[category]);
  // Every word of the search, in its name, description or category.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (row: Row) => {
    const text = [
      row.app?.name ?? row.connection?.name,
      row.app?.description,
      label(categoryOf(row)),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  };
  const found = rows.filter(
    (row) => matches(row) && (!onlyConnected || row.connection),
  );
  const counts = new Map<Category, number>();
  for (const row of found) {
    counts.set(categoryOf(row), (counts.get(categoryOf(row)) ?? 0) + 1);
  }
  // Chips for the categories this Pim has apps in, whatever the search.
  const offered = CATEGORIES.filter((candidate) =>
    rows.some((row) => categoryOf(row) === candidate),
  );
  const sections = CATEGORIES.filter(
    (candidate) =>
      (category === null || category === candidate) && counts.has(candidate),
  ).map((candidate) => ({
    category: candidate,
    rows: found.filter((row) => categoryOf(row) === candidate),
  }));
  const connectedCount = rows.filter((row) => row.connection).length;
  const loading = !directory || !connections;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <div className="@container mx-auto w-full max-w-6xl shrink-0 px-6 pt-8 md:pt-12">
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-semibold text-xl">{t("connectedApps")}</h1>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus /> {t("createApp")}
            </Button>
          )}
        </div>
        <p className="mt-1 text-muted-foreground text-sm">
          {t("connectedAppsDescription")}
        </p>
        <div className="mt-5 mb-4 flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchApps")}
              aria-label={t("searchApps")}
              className="pl-9"
            />
          </div>
          {offered.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-lg"
                  className={cn(
                    "relative shrink-0 rounded-xl",
                    category && "border-foreground/40 bg-accent",
                  )}
                  aria-label={
                    category
                      ? `${t("filterByCategory")}: ${label(category)}`
                      : t("filterByCategory")
                  }
                >
                  <ListFilter />
                  {category && (
                    <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-primary" />
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="text-muted-foreground text-xs">
                  {t("appsByCategory")}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={category ?? "all"}
                  onValueChange={(value) =>
                    setCategory(value === "all" ? null : (value as Category))
                  }
                >
                  {[null, ...offered].map((candidate) => {
                    const count =
                      candidate === null
                        ? found.length
                        : (counts.get(candidate) ?? 0);
                    return (
                      <DropdownMenuRadioItem
                        key={candidate ?? "all"}
                        value={candidate ?? "all"}
                        className={cn(count === 0 && "text-muted-foreground")}
                      >
                        <span className="flex-1 truncate">
                          {candidate === null
                            ? t("allCategories")
                            : label(candidate)}
                        </span>
                        <span className="text-muted-foreground text-xs tabular-nums">
                          {count}
                        </span>
                      </DropdownMenuRadioItem>
                    );
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <fieldset className="flex rounded-xl border p-0.5 text-sm">
            <legend className="sr-only">{t("connectedApps")}</legend>
            {[
              { value: false, text: t("appsShowAll"), count: rows.length },
              {
                value: true,
                text: t("appsShowConnected"),
                count: connectedCount,
              },
            ].map((option) => (
              <button
                key={String(option.value)}
                type="button"
                aria-pressed={onlyConnected === option.value}
                onClick={() => setOnlyConnected(option.value)}
                className={cn(
                  "flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
                  onlyConnected === option.value &&
                    "bg-accent font-medium text-foreground",
                )}
              >
                {option.text}
                <span className="hidden text-xs tabular-nums opacity-70 sm:inline">
                  {option.count}
                </span>
              </button>
            ))}
          </fieldset>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t scrollbar-thin">
        <div className="@container mx-auto w-full max-w-6xl px-6 pb-12">
          {loading ? null : rows.length === 0 ? (
            <p className="py-6 text-muted-foreground text-sm">
              {t("noAppsOffered")}
            </p>
          ) : sections.length === 0 ? (
            <p className="py-6 text-muted-foreground text-sm">
              {onlyConnected && words.length === 0
                ? t("noConnectedApps")
                : t("noAppsMatch")}
            </p>
          ) : (
            sections.map((section) => (
              <section
                key={section.category}
                aria-labelledby={`apps-${section.category}`}
              >
                <h2
                  id={`apps-${section.category}`}
                  className="sticky top-0 z-10 flex items-baseline gap-2 bg-background pt-5 pb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide"
                >
                  {label(section.category)}
                  <span className="tabular-nums opacity-70">
                    {section.rows.length}
                  </span>
                </h2>
                <ul className="grid @xl:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4 grid-cols-1 gap-3">
                  {section.rows.map((row) => (
                    <AppCard
                      key={row.app?.ref ?? row.connection?.id}
                      row={row}
                      isAdmin={isAdmin}
                      busy={
                        connect.isPending ||
                        disconnect.isPending ||
                        unlist.isPending
                      }
                      onConnect={(app) => connect.mutate(app)}
                      onDisconnect={(connection) =>
                        disconnect.mutate(connection)
                      }
                      onChangeIcon={setChangingIcon}
                      onUnlist={(app) => unlist.mutate(app)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
      <AppDialog
        title={t("createApp")}
        open={creating}
        onOpenChange={setCreating}
      >
        <CreateAppForm onDone={() => setCreating(false)} />
      </AppDialog>
      <AppDialog
        title={
          changingIcon
            ? t("changeAppIconNamed", { name: changingIcon.name })
            : ""
        }
        open={changingIcon !== null}
        onOpenChange={(open) => !open && setChangingIcon(null)}
      >
        {changingIcon && (
          <AppIconForm
            app={changingIcon}
            onDone={() => setChangingIcon(null)}
          />
        )}
      </AppDialog>
    </main>
  );
}

/** One app as a card: its logo, what it does, your connection, and what you can do with it. */
function AppCard({
  row: { app, connection },
  isAdmin,
  busy,
  onConnect,
  onDisconnect,
  onChangeIcon,
  onUnlist,
}: {
  row: Row;
  isAdmin: boolean;
  busy: boolean;
  onConnect: (app: DirectoryApp) => void;
  onDisconnect: (connection: ConnectedApp) => void;
  onChangeIcon: (app: DirectoryApp) => void;
  onUnlist: (app: DirectoryApp) => void;
}) {
  const { t } = useI18n();
  const name = app?.name ?? connection?.name ?? "";
  const state = connection?.state;
  const stateLabel =
    state === "ready"
      ? t("appReady")
      : state === "authenticating"
        ? t("appNeedsSignIn")
        : state === "failed"
          ? t("appFailed")
          : t("appConnecting");
  const adminActions = isAdmin && app?.custom;
  return (
    <li className="flex flex-col gap-2 rounded-xl border bg-card p-3.5 transition-colors hover:border-foreground/20">
      <div className="flex items-center gap-3">
        <AppIcon name={name} icon={app?.icon} className="size-9 text-sm" />
        <h3 className="min-w-0 flex-1 truncate font-medium text-sm">{name}</h3>
        {connection?.authUrl && state === "authenticating" && (
          <Button variant="outline" size="sm" asChild>
            <a href={connection.authUrl} target="_blank" rel="noopener">
              {t("signIn")} <ExternalLink />
            </a>
          </Button>
        )}
        {app && (!connection || state === "failed") && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onConnect(app)}
          >
            {t("connect")}
          </Button>
        )}
      </div>
      <p className="line-clamp-2 text-muted-foreground text-xs leading-relaxed">
        {app ? app.description || app.url : t("appNoLongerOffered")}
      </p>
      {(connection || adminActions) && (
        <div className="mt-auto flex items-center gap-1 border-t pt-2">
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground text-xs">
            {connection && (
              <>
                <span
                  className={cn(
                    "shrink-0 rounded-full px-1.5 py-px text-[10px]",
                    state === "ready"
                      ? "bg-success/12 text-success"
                      : state === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted",
                  )}
                  title={connection.error ?? undefined}
                >
                  {stateLabel}
                </span>
                {state === "ready" && (
                  <span className="shrink-0">
                    {t("toolCount", { count: connection.tools.length })} ·
                  </span>
                )}
                <span
                  className="truncate"
                  title={connection.agents.join(", ") || undefined}
                >
                  {connection.agents.length > 0
                    ? t("appUsedBy", { agents: connection.agents.join(", ") })
                    : t("appUnused")}
                </span>
              </>
            )}
          </span>
          {adminActions && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t("changeAppIconNamed", { name })}
                title={t("changeAppIconNamed", { name })}
                onClick={() => onChangeIcon(app)}
              >
                <ImageIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t("unlistAppNamed", { name })}
                title={t("unlistAppNamed", { name })}
                disabled={busy}
                onClick={() => onUnlist(app)}
              >
                <Trash2 />
              </Button>
            </>
          )}
          {connection && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={t("removeAppNamed", { name })}
              title={t("removeAppNamed", { name })}
              disabled={busy}
              onClick={() => onDisconnect(connection)}
            >
              <Unplug />
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** A dialog for the admin's forms. */
function AppDialog({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-background p-5 shadow-xl sm:p-6"
        >
          <Dialog.Title className="mb-4 pr-8 font-semibold text-lg">
            {title}
          </Dialog.Title>
          {children}
          <Dialog.Close className="absolute top-4 right-4 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-4" />
            <span className="sr-only">{t("close")}</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The admin gives an app they added another icon, or empties it to use its site's again. */
function AppIconForm({
  app,
  onDone,
}: {
  app: DirectoryApp;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const hint = useId();
  const [icon, setIcon] = useState(
    app.icon?.startsWith("https://") ? app.icon : "",
  );
  const change = useMutation({
    mutationFn: () =>
      admin.setAppIcon(app.ref.slice(app.ref.indexOf("/") + 1), icon),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-directory"] });
      toast.success(t("appIconChanged", { name: app.name }));
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    change.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-1">
        <label
          htmlFor={`${hint}-input`}
          className="block text-[13px] text-muted-foreground"
        >
          {t("appIcon")}
        </label>
        <Input
          id={`${hint}-input`}
          value={icon}
          onChange={(event) => setIcon(event.target.value)}
          placeholder="https://github.com/favicon.ico"
          type="url"
          pattern="https://.*"
          autoFocus
          aria-describedby={hint}
        />
        <p id={hint} className="text-muted-foreground text-xs">
          {t("appIconHint")}
        </p>
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={change.isPending}>
          {t("save")}
        </Button>
      </div>
    </form>
  );
}

/** The admin adds an app everyone on this Pim can connect: a remote MCP server. */
function CreateAppForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const hint = useId();
  const [app, setApp] = useState({
    name: "",
    description: "",
    url: "",
    icon: "",
    category: "" as AppCategory | "",
  });
  const create = useMutation({
    mutationFn: () => admin.addApp(app),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-directory"] });
      toast.success(t("appAdded", { name: app.name }));
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-[13px] text-muted-foreground">{t("createAppHint")}</p>
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("appName")}
        </span>
        <Input
          value={app.name}
          onChange={(event) => setApp({ ...app, name: event.target.value })}
          placeholder="Linear"
          maxLength={40}
          required
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("appDescription")}
        </span>
        <Input
          value={app.description}
          onChange={(event) =>
            setApp({ ...app, description: event.target.value })
          }
          placeholder={t("appDescriptionPlaceholder")}
          maxLength={280}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-[13px] text-muted-foreground">{t("appUrl")}</span>
        <Input
          value={app.url}
          onChange={(event) => setApp({ ...app, url: event.target.value })}
          placeholder="https://mcp.linear.app/mcp"
          type="url"
          pattern="https://.*"
          required
        />
      </label>
      <div className="space-y-1">
        <span
          id={`${hint}-category`}
          className="block text-[13px] text-muted-foreground"
        >
          {t("appCategory")}
        </span>
        <Select
          value={app.category || "other"}
          onValueChange={(value) =>
            setApp({
              ...app,
              category: value === "other" ? "" : (value as AppCategory),
            })
          }
        >
          <SelectTrigger
            className="w-full"
            aria-labelledby={`${hint}-category`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {CATEGORIES.map((category) => (
              <SelectItem key={category} value={category}>
                {t(CATEGORY_LABELS[category])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <label className="block space-y-1">
          <span className="text-[13px] text-muted-foreground">
            {t("appIcon")}
          </span>
          <Input
            value={app.icon}
            onChange={(event) => setApp({ ...app, icon: event.target.value })}
            placeholder="https://github.com/favicon.ico"
            type="url"
            pattern="https://.*"
            aria-describedby={hint}
          />
        </label>
        <p id={hint} className="text-muted-foreground text-xs">
          {t("appIconHint")}
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button type="submit" size="sm" disabled={create.isPending}>
          {t("addApp")}
        </Button>
      </div>
    </form>
  );
}
