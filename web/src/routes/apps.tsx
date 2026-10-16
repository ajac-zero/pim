import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, ImageIcon, Plus, Trash2, Unplug } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { AppIcon } from "~/components/app-icon";
import { useI18n } from "~/components/i18n";
import { Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
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

/**
 * The apps this Pim offers, each with your connection to it: you connect an
 * app once, and every agent of yours that lists it works with it. Apps you
 * connected that it no longer offers can only be disconnected here. The
 * admin adds apps of their own, and takes them out.
 */
function AppsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: account } = useQuery(accountQuery());
  const isAdmin = account?.role === "admin";
  const { data: directory } = useQuery(appDirectoryQuery());
  const { data: connections } = useQuery(appsQuery());
  const [creating, setCreating] = useState(false);
  // The admin's app whose icon they're changing, by ref.
  const [changingIcon, setChangingIcon] = useState<string | null>(null);
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
  if (!directory || !connections) {
    return (
      <Page
        title={t("connectedApps")}
        description={t("connectedAppsDescription")}
      >
        {null}
      </Page>
    );
  }
  const stateLabel = (app: ConnectedApp) =>
    app.state === "ready"
      ? t("appReady")
      : app.state === "authenticating"
        ? t("appNeedsSignIn")
        : app.state === "failed"
          ? t("appFailed")
          : t("appConnecting");
  const unoffered = connections.filter((connection) => connection.app === null);
  const rows = [
    ...directory.map((app) => ({
      app,
      connection: connections.find((candidate) => candidate.app === app.ref),
    })),
    ...unoffered.map((connection) => ({ app: null, connection })),
  ];
  return (
    <Page
      title={t("connectedApps")}
      description={t("connectedAppsDescription")}
    >
      <div className="space-y-3">
        {rows.length === 0 ? (
          <p className="py-3 text-muted-foreground text-sm">
            {t("noAppsOffered")}
          </p>
        ) : (
          <ul
            className="divide-y rounded-2xl border bg-muted/20"
            aria-label={t("connectedApps")}
          >
            {rows.map(({ app, connection }) => {
              const name = app?.name ?? connection?.name ?? "";
              return (
                <li
                  key={app?.ref ?? connection?.id}
                  className="flex flex-wrap items-center gap-3 px-4 py-3"
                >
                  <AppIcon
                    name={name}
                    icon={app?.icon}
                    className="size-11 text-lg"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-medium text-sm">
                        {name}
                      </span>
                      {connection && (
                        <span
                          className={cn(
                            "shrink-0 rounded border px-1 text-[10px]",
                            connection.state === "ready"
                              ? "text-success"
                              : connection.state === "failed"
                                ? "text-destructive"
                                : "text-muted-foreground",
                          )}
                          title={connection.error ?? undefined}
                        >
                          {stateLabel(connection)}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-muted-foreground text-xs">
                      {app
                        ? app.description || app.url
                        : t("appNoLongerOffered")}
                    </span>
                    {connection && (
                      <span className="block truncate text-muted-foreground text-xs">
                        {connection.agents.length > 0
                          ? t("appUsedBy", {
                              agents: connection.agents.join(", "),
                            })
                          : t("appUnused")}
                        {connection.state === "ready" &&
                          ` · ${t("toolCount", { count: connection.tools.length })}`}
                      </span>
                    )}
                  </span>
                  {connection?.authUrl &&
                    connection.state === "authenticating" && (
                      <Button variant="outline" size="sm" asChild>
                        <a
                          href={connection.authUrl}
                          target="_blank"
                          rel="noopener"
                        >
                          {t("signIn")} <ExternalLink />
                        </a>
                      </Button>
                    )}
                  {app && (!connection || connection.state === "failed") && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={connect.isPending}
                      onClick={() => connect.mutate(app)}
                    >
                      {t("connect")}
                    </Button>
                  )}
                  {connection && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={t("removeAppNamed", { name })}
                      title={t("removeAppNamed", { name })}
                      disabled={disconnect.isPending}
                      onClick={() => disconnect.mutate(connection)}
                    >
                      <Unplug />
                    </Button>
                  )}
                  {isAdmin && app?.custom && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={t("changeAppIconNamed", { name })}
                      title={t("changeAppIconNamed", { name })}
                      aria-expanded={changingIcon === app.ref}
                      onClick={() =>
                        setChangingIcon(
                          changingIcon === app.ref ? null : app.ref,
                        )
                      }
                    >
                      <ImageIcon />
                    </Button>
                  )}
                  {isAdmin && app?.custom && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={t("unlistAppNamed", { name })}
                      title={t("unlistAppNamed", { name })}
                      disabled={unlist.isPending}
                      onClick={() => unlist.mutate(app)}
                    >
                      <Trash2 />
                    </Button>
                  )}
                  {app && changingIcon === app.ref && (
                    <AppIconForm
                      app={app}
                      onDone={() => setChangingIcon(null)}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {isAdmin &&
          (creating ? (
            <CreateAppForm onDone={() => setCreating(false)} />
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCreating(true)}
            >
              <Plus /> {t("createApp")}
            </Button>
          ))}
      </div>
    </Page>
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
    <form
      onSubmit={submit}
      className="basis-full space-y-2 pl-14"
      aria-label={t("changeAppIconNamed", { name: app.name })}
    >
      <label
        htmlFor={`${hint}-input`}
        className="block text-[13px] text-muted-foreground"
      >
        {t("appIcon")}
      </label>
      <div className="flex gap-2">
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
        <Button type="submit" size="sm" disabled={change.isPending}>
          {t("save")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
      <p id={hint} className="text-muted-foreground text-xs">
        {t("appIconHint")}
      </p>
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
    <form
      onSubmit={submit}
      className="space-y-3 rounded-2xl border p-4"
      aria-label={t("createApp")}
    >
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
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {t("addApp")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
