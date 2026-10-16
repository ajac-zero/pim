import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertCircle,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Mail,
  Monitor,
  Moon,
  Plug,
  Sun,
  Trash2,
} from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import {
  AccountSection,
  DeleteAccountSection,
  PreferencesSection,
  TokensSection,
} from "~/components/account-settings";
import { AddDevice } from "~/components/add-device";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { MembersSection } from "~/components/members";
import { Page } from "~/components/page";
import { useTheme } from "~/components/theme";
import { ToolPermissionList } from "~/components/tool-permissions";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import {
  auth,
  authSessionQuery,
  cancelled,
  type Passkey,
  passkeysQuery,
} from "~/lib/auth";
import {
  CHATGPT_PROVIDER,
  type ConnectedApp,
  type EmailState,
  type ModelInfo,
  type ModelSettings,
  pim,
} from "~/lib/pim-api";
import {
  disablePush,
  enablePush,
  pushEnabled,
  pushSupported,
} from "~/lib/push";
import {
  accountQuery,
  appsQuery,
  emailQuery,
  modelQuery,
  profileQuery,
} from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/settings")({
  loader: ({ context }) => context.queryClient.ensureQueryData(modelQuery()),
  component: SettingsPage,
});

/** Shown once, the first time Pim is connected to a ChatGPT plan. */
const WELCOMED_KEY = "pim-chatgpt-welcomed";

function SettingsPage() {
  const { t } = useI18n();
  const { data } = useQuery(modelQuery());
  if (!data) return null;
  return (
    <Page title={t("settings")} description={t("settingsDescription")}>
      <AccountSection />
      <MembersSection />
      <ProfileSection />
      <ChatGPTCard settings={data} />
      <section className="mt-10 space-y-3">
        <h2 className="font-medium text-muted-foreground text-sm">
          {t("model")}
        </h2>
        <ModelChoices settings={data} />
      </section>
      <PreferencesSection />
      <AppearanceSection />
      <ConnectedAppsSection />
      <ToolPermissionsSection />
      <EmailSection />
      <PushSection />
      <PasskeysSection />
      <TokensSection />
      <DeleteAccountSection />
    </Page>
  );
}

function ModelChoices({ settings }: { settings: ModelSettings }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const choose = useMutation({
    mutationFn: (model: ModelInfo) => pim.chooseModel(model),
    onSuccess: ({ model }) => {
      queryClient.invalidateQueries({ queryKey: ["model"] });
      toast.success(t("modelChanged", { model: model.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  const current = settings.model;

  return (
    <div className="space-y-2">
      <ul
        className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
        aria-label={t("model")}
      >
        {settings.choices.map((choice) => {
          const selected =
            choice.provider === current.provider && choice.id === current.id;
          const plan = choice.provider === CHATGPT_PROVIDER;
          return (
            <li key={`${choice.provider}/${choice.id}`}>
              <button
                type="button"
                aria-pressed={selected}
                disabled={selected || choose.isPending}
                onClick={() => choose.mutate(choice)}
                className={cn(
                  "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50 disabled:cursor-default",
                  selected && "hover:bg-transparent",
                )}
              >
                {plan ? (
                  <ChatGPTLogo className="size-5 shrink-0" />
                ) : (
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted font-medium text-muted-foreground text-xs">
                    CF
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">
                    {choice.name}
                  </span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {plan ? t("usesChatGPTPlan") : t("runsOnWorkersAI")}
                    {choice.images && ` · ${t("seesImages")}`}
                  </span>
                </span>
                {choose.isPending && choose.variables?.id === choice.id ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : (
                  selected && <Check className="size-4 text-primary" />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {!settings.chatgpt.connected && (
        <p className="text-[13px] text-muted-foreground">
          {t("connectForMoreModels")}
        </p>
      )}
      {settings.chatgpt.error && (
        <p className="flex items-start gap-2 text-[13px] text-destructive">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          {t("couldNotListModels", { error: settings.chatgpt.error })}
        </p>
      )}
    </div>
  );
}

function ChatGPTCard({ settings }: { settings: ModelSettings }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // Set while a sign-in waits for the address the browser lands on.
  const [waiting, setWaiting] = useState(false);
  const [address, setAddress] = useState("");
  const [welcome, setWelcome] = useState(false);
  const { connected, email } = settings.chatgpt;

  const start = useMutation({
    mutationFn: async () => {
      // Opened now, while the click still counts, so popup blockers allow it.
      const tab = window.open("", "_blank");
      try {
        const { url } = await pim.chatgptLogin();
        if (tab) tab.location.href = url;
        else window.location.href = url;
      } catch (error) {
        tab?.close();
        throw error;
      }
    },
    onSuccess: () => setWaiting(true),
    onError: (error) => toast.error(error.message),
  });
  const finish = useMutation({
    mutationFn: () => pim.chatgptCallback(address),
    onSuccess: () => {
      setWaiting(false);
      setAddress("");
      queryClient.invalidateQueries({ queryKey: ["model"] });
      if (!localStorage.getItem(WELCOMED_KEY)) setWelcome(true);
    },
    onError: (error) => toast.error(error.message),
  });
  const disconnect = useMutation({
    mutationFn: pim.chatgptLogout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model"] }),
    onError: (error) => toast.error(error.message),
  });

  if (welcome) {
    return (
      <section className="flex flex-col items-center gap-3 rounded-xl border bg-card px-6 py-8 text-center shadow-xs">
        <ChatGPTLogo className="size-8" />
        <h2 className="font-semibold text-lg">{t("usingYourPlanTitle")}</h2>
        <p className="max-w-md text-muted-foreground text-sm">
          {t("usingYourPlanBody")}
        </p>
        <Button
          onClick={() => {
            localStorage.setItem(WELCOMED_KEY, "1");
            setWelcome(false);
          }}
        >
          {t("gotIt")}
        </Button>
      </section>
    );
  }

  return (
    <section className="mt-10 rounded-2xl border bg-muted/20 p-5">
      <div className="flex items-start gap-3">
        <ChatGPTLogo className="mt-0.5 size-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{t("useYourChatGPTPlan")}</h2>
          <p className="mt-1 text-muted-foreground text-sm">
            {connected
              ? t("connectedAs", { email: email ?? t("yourAccount") })
              : t("chatGPTPlanPitch")}
          </p>
        </div>
      </div>

      {connected ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
              {t("manageUsage")} <ExternalLink className="size-3.5" />
            </a>
          </Button>
          <Button
            variant="ghost"
            onClick={() => disconnect.mutate()}
            disabled={disconnect.isPending}
          >
            {t("disconnect")}
          </Button>
        </div>
      ) : waiting ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) finish.mutate();
          }}
        >
          <p className="text-muted-foreground text-sm">
            {t("chatGPTWhyPaste")}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>{t("chatGPTStepApprove")}</li>
            <li>{t("chatGPTStepCopy")}</li>
            <li>{t("chatGPTStepPaste")}</li>
          </ol>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="http://127.0.0.1:1455/auth/callback?code=…"
              aria-label={t("pasteAddress")}
              className="h-9 flex-1 font-mono text-xs"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setWaiting(false);
                  setAddress("");
                }}
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!address.trim() || finish.isPending}
              >
                {finish.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {t("connect")}
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {t("chatGPTAfterPaste")}
          </p>
        </form>
      ) : (
        <Button
          className="mt-4"
          onClick={() => start.mutate()}
          disabled={start.isPending}
        >
          <ChatGPTLogo className="size-4" />
          {t("continueWithChatGPT")}
        </Button>
      )}
    </section>
  );
}

/** How others on this Pim see you: on your page, and next to what you publish. */
/** The color theme and the mode; each theme previews itself in the current mode. */
function AppearanceSection() {
  const { t } = useI18n();
  const {
    preference,
    setPreference,
    resolved,
    themes,
    colorTheme,
    setColorTheme,
  } = useTheme();
  return (
    <section id="appearance" className="mt-10 scroll-mt-6 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("appearance")}
      </h2>
      <div
        role="radiogroup"
        aria-label={t("mode")}
        className="inline-flex rounded-full bg-muted p-1"
      >
        {(
          [
            ["light", Sun],
            ["dark", Moon],
            ["system", Monitor],
          ] as const
        ).map(([value, Icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={preference === value}
            onClick={() => setPreference(value)}
            className={cn(
              "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm transition-colors",
              preference === value
                ? "bg-background shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t(`${value}Theme`)}
          </button>
        ))}
      </div>
      <div
        role="radiogroup"
        aria-label={t("theme")}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {themes.map((theme) => {
          const checked = colorTheme?.id === theme.id;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setColorTheme(theme.id)}
              className={cn(
                "rounded-2xl border p-1.5 text-left transition-colors",
                checked
                  ? "border-ring ring-2 ring-ring/40"
                  : "hover:border-foreground/30",
              )}
            >
              {/* A miniature window in the theme's own tokens: scoping
                  data-theme (and .dark) to this element recolors it. */}
              <div
                data-theme={theme.id}
                className={cn(
                  "flex h-20 overflow-hidden rounded-xl border bg-background",
                  resolved === "dark" && "dark",
                )}
                aria-hidden="true"
              >
                <div className="w-1/4 border-r bg-sidebar" />
                <div className="flex flex-1 flex-col justify-center gap-1.5 p-2.5">
                  <div className="ml-auto h-3 w-3/5 rounded-full bg-bubble" />
                  <div className="h-3 w-4/5 rounded-full bg-muted" />
                  <div className="flex items-center gap-1">
                    <div className="h-3 w-2/5 rounded-full bg-muted" />
                    <div className="ml-auto size-3 rounded-full bg-primary" />
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between px-1.5 pt-2 pb-1 text-sm">
                <span>{theme.name}</span>
                {checked && <Check className="size-4" />}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ProfileSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: account } = useQuery(accountQuery());
  const { data: profile } = useQuery({ ...profileQuery(), enabled: !!account });
  const [draft, setDraft] = useState<{
    displayName: string;
    bio: string;
  } | null>(null);
  const save = useMutation({
    mutationFn: pim.setProfile,
    onSuccess: (next) => {
      queryClient.setQueryData(["profile"], next);
      setDraft(null);
      toast.success(t("settingsSaved"));
    },
    onError: (error) => toast.error(error.message),
  });
  if (!account || !profile) return null;
  const value = draft ?? {
    displayName: profile.displayName ?? "",
    bio: profile.bio ?? "",
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({
      displayName: value.displayName.trim() || null,
      bio: value.bio.trim() || null,
    });
  };
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("profile")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("profileDescription")}
      </p>
      <form
        onSubmit={submit}
        className="space-y-4 rounded-2xl border bg-muted/20 p-4"
      >
        <label className="block space-y-1">
          <span className="text-muted-foreground text-[13px]">
            {t("displayName")}
          </span>
          <Input
            value={value.displayName}
            onChange={(event) =>
              setDraft({ ...value, displayName: event.target.value })
            }
            placeholder={`@${account.username}`}
            maxLength={50}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-muted-foreground text-[13px]">{t("bio")}</span>
          <Input
            value={value.bio}
            onChange={(event) =>
              setDraft({ ...value, bio: event.target.value })
            }
            placeholder={t("bioPlaceholder")}
            maxLength={280}
          />
        </label>
        <div className="flex justify-end">
          <Button type="submit" disabled={draft === null || save.isPending}>
            {t("save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * The apps you connected, with the agents that work with each: only their
 * chats get its tools. An app no agent lists can only be removed here.
 */
function ConnectedAppsSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: apps } = useQuery(appsQuery());
  const remove = useMutation({
    mutationFn: (app: ConnectedApp) => pim.removeApp(app.id),
    onSuccess: (_result, app) => {
      queryClient.invalidateQueries({ queryKey: ["apps"] });
      queryClient.invalidateQueries({ queryKey: ["permissions"] });
      toast.success(t("appRemoved", { name: app.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  if (!apps) return null;
  const stateLabel = (app: ConnectedApp) =>
    app.state === "ready"
      ? t("appReady")
      : app.state === "authenticating"
        ? t("appNeedsSignIn")
        : app.state === "failed"
          ? t("appFailed")
          : t("appConnecting");
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("connectedApps")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("connectedAppsDescription")}
      </p>
      {apps.length === 0 ? (
        <p className="py-3 text-muted-foreground text-sm">
          {t("noConnectedApps")}
        </p>
      ) : (
        <ul
          className="divide-y rounded-2xl border bg-muted/20"
          aria-label={t("connectedApps")}
        >
          {apps.map((app) => (
            <li key={app.id} className="flex items-center gap-3 px-4 py-3">
              <Plug className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium text-sm">
                    {app.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded border px-1 text-[10px]",
                      app.state === "ready"
                        ? "text-success"
                        : app.state === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                    title={app.error ?? undefined}
                  >
                    {stateLabel(app)}
                  </span>
                </span>
                <span
                  className="block truncate text-muted-foreground text-xs"
                  title={app.url}
                >
                  {app.url}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  {app.agents.length > 0
                    ? t("appUsedBy", { agents: app.agents.join(", ") })
                    : t("appUnused")}
                  {app.state === "ready" &&
                    ` · ${t("toolCount", { count: app.tools.length })}`}
                </span>
              </span>
              {app.authUrl && app.state === "authenticating" && (
                <Button variant="outline" size="sm" asChild>
                  <a href={app.authUrl} target="_blank" rel="noopener">
                    {t("signIn")} <ExternalLink />
                  </a>
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={t("removeAppNamed", { name: app.name })}
                title={t("removeAppNamed", { name: app.name })}
                disabled={remove.isPending}
                onClick={() => remove.mutate(app)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** What Pim may do with each tool that acts on the world or comes from an app. */
function ToolPermissionsSection() {
  const { t } = useI18n();
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("toolPermissions")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("toolPermissionsDescription")}
      </p>
      <ToolPermissionList />
    </section>
  );
}

/** Whether this browser gets Pim's notifications as pushes. */
/** The address Pim emails you at, confirmed with a code it sends there. Only where this Pim can send email. */
function EmailSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: email } = useQuery(emailQuery());
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const onError = (error: Error) => toast.error(error.message);
  const onSuccess = (next: EmailState) => {
    queryClient.setQueryData(["email"], next);
    setCode("");
  };
  const start = useMutation({ mutationFn: pim.startEmail, onSuccess, onError });
  const confirm = useMutation({
    mutationFn: pim.confirmEmail,
    onSuccess,
    onError,
  });
  const remove = useMutation({
    mutationFn: pim.removeEmail,
    onSuccess,
    onError,
  });
  if (!email?.available) return null;
  const busy = start.isPending || confirm.isPending || remove.isPending;

  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("emailTitle")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("emailDescription")}
      </p>
      {email.address && !email.pending ? (
        <div className="flex items-center gap-3 rounded-xl border px-4 py-3">
          <Mail className="size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 truncate text-sm">
            {t("emailConfirmed", { address: email.address })}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => remove.mutate()}
          >
            {t("emailRemove")}
          </Button>
        </div>
      ) : email.pending ? (
        <form
          className="space-y-2 rounded-xl border px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            confirm.mutate(code);
          }}
        >
          <p className="text-sm">
            {t("emailCodeSent", { address: email.pending })}
          </p>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              aria-label={t("emailCodeLabel")}
              className="max-w-40"
            />
            <Button type="submit" disabled={busy || code.trim() === ""}>
              {t("emailConfirm")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => remove.mutate()}
            >
              {t("emailUseAnother")}
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            start.mutate(address);
          }}
        >
          <Input
            type="email"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            aria-label={t("emailAddressLabel")}
          />
          <Button type="submit" disabled={busy || address.trim() === ""}>
            {t("emailSendCode")}
          </Button>
        </form>
      )}
    </section>
  );
}

function PushSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const supported = pushSupported();
  const { data: enabled = false } = useQuery({
    queryKey: ["push"],
    queryFn: pushEnabled,
    enabled: supported,
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => (on ? enablePush() : disablePush()),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["push"] }),
    onError: (error) => {
      if (error.message !== "notifications-blocked") toast.error(error.message);
    },
  });
  const blocked = supported && Notification.permission === "denied";

  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("pushNotifications")}
      </h2>
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/20 p-4">
        <p className="min-w-0 flex-1 text-sm">{t("pushDescription")}</p>
        <Switch
          checked={enabled}
          disabled={!supported || blocked || toggle.isPending}
          onCheckedChange={(on) => toggle.mutate(on)}
          aria-label={t("pushNotifications")}
        />
      </div>
      {(!supported || blocked) && (
        <p className="text-[13px] text-muted-foreground">
          {t(supported ? "pushBlocked" : "pushUnsupported")}
        </p>
      )}
    </section>
  );
}

/** The passkeys that sign in to this Pim, and signing out. */
function PasskeysSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  // The dev server signs you in itself; there are no passkeys to manage.
  const enabled = session?.method === "passkey";
  const { data: passkeys } = useQuery({ ...passkeysQuery(), enabled });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["auth"] });

  const add = useMutation({
    mutationFn: () => auth.addPasskey(),
    onSuccess: () => {
      refresh();
      toast.success(t("passkeyAdded"));
    },
    onError: (error) => {
      if (!cancelled(error)) toast.error(error.message);
    },
  });
  const remove = useMutation({
    mutationFn: auth.removePasskey,
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const signOut = useMutation({
    mutationFn: auth.signOut,
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });

  if (!enabled) return null;
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("passkeys")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("passkeysDescription")}
      </p>
      <AddDevice />
      {passkeys && passkeys.length > 0 && (
        <ul
          className="divide-y rounded-2xl border bg-muted/20"
          aria-label={t("passkeys")}
        >
          {passkeys.map((passkey) => (
            <PasskeyRow
              key={passkey.id}
              passkey={passkey}
              current={passkey.id === session?.passkey}
              removing={remove.isPending && remove.variables === passkey.id}
              onRemove={() => remove.mutate(passkey.id)}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => add.mutate()}
          disabled={add.isPending}
        >
          {add.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {t("addPasskey")}
        </Button>
        {session?.method === "passkey" && (
          <Button
            variant="ghost"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            <LogOut />
            {t("signOut")}
          </Button>
        )}
      </div>
    </section>
  );
}

function PasskeyRow({
  passkey,
  current,
  removing,
  onRemove,
}: {
  passkey: Passkey;
  current: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const { t, formatDate } = useI18n();
  const date = (time: number) =>
    formatDate(new Date(time), { dateStyle: "medium" });
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <KeyRound className="size-11 shrink-0 rounded-xl bg-muted p-3 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">
          {passkey.name}
          {current && (
            <span className="ml-2 font-normal text-muted-foreground text-xs">
              {t("thisBrowser")}
            </span>
          )}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {t("passkeyDates", {
            created: date(passkey.createdAt),
            used: date(passkey.lastUsedAt),
          })}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={t("removePasskey", { name: passkey.name })}
        title={current ? t("removeCurrentPasskey") : undefined}
        onClick={onRemove}
        disabled={removing}
      >
        {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </li>
  );
}
