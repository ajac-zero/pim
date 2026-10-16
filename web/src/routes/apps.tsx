import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ExternalLink, Plug, Plus, Trash2, Unplug } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <Plug className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
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
                      aria-label={t("unlistAppNamed", { name })}
                      title={t("unlistAppNamed", { name })}
                      disabled={unlist.isPending}
                      onClick={() => unlist.mutate(app)}
                    >
                      <Trash2 />
                    </Button>
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

/** The admin adds an app everyone on this Pim can connect: a remote MCP server. */
function CreateAppForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [app, setApp] = useState({ name: "", description: "", url: "" });
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
