import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AccountSection,
  DeleteAccountSection,
  McpSection,
  PreferencesSection,
  TokensSection,
} from "~/components/account-settings";
import { AddDevice } from "~/components/add-device";
import { ChatGPTLogo } from "~/components/chatgpt-logo";
import { ComputerSection } from "~/components/computer-settings";
import { CuaEvaluationSection } from "~/components/cua-evaluation";
import { DeploymentSection } from "~/components/deployment-settings";
import { type TranslationKey, useI18n } from "~/components/i18n";
import {
  AlertCircle,
  Bell,
  Check,
  KeyRound,
  Loader2,
  LogOut,
  type LucideIcon,
  Mail,
  MessageCircle,
  Monitor,
  Moon,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UserRound,
  Users,
  X,
} from "~/components/icons";
import { MembersSection } from "~/components/members";
import { MemorySection } from "~/components/memory-settings";
import { ModelProviderLogo } from "~/components/model-logo";
import { ProvidersSection } from "~/components/model-providers";
import { ProviderLogo } from "~/components/provider-buttons";
import { SignInMethodsSection } from "~/components/sign-in-methods";
import { useTheme } from "~/components/theme";
import { ToolPermissionList } from "~/components/tool-permissions";
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
  auth,
  authError,
  authSessionQuery,
  cancelled,
  forgetAuthError,
  identitiesQuery,
  type LinkedIdentity,
  type Passkey,
  type ProviderId,
  passkeysQuery,
} from "~/lib/auth";
import {
  CHATGPT_PROVIDER,
  type EmailState,
  type ModelInfo,
  type ModelSettings,
  pim,
} from "~/lib/pim-api";
import { enablePush, pushEnabled, pushSupported } from "~/lib/push";
import { accountQuery, emailQuery, modelQuery } from "~/lib/queries";
import { cn, modelName } from "~/lib/utils";

/** Shown once, the first time Pim is connected to a ChatGPT plan. */

export const SETTINGS_TABS = [
  "general",
  "model",
  "computer",
  "permissions",
  "memory",
  "account",
  "members",
  "deployment",
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABELS: Record<SettingsTab, [TranslationKey, LucideIcon]> = {
  general: ["settingsGeneral", SlidersHorizontal],
  model: ["settingsModel", Sparkles],
  computer: ["settingsComputer", Server],
  permissions: ["settingsPermissions", ShieldCheck],
  memory: ["memory", MessageCircle],
  account: ["settingsAccount", UserRound],
  members: ["settingsMembers", Users],
  deployment: ["settingsDeployment", Settings],
};

/**
 * Settings, as a dialog over whatever is open: a tab for each part, so a
 * change is a click or two away and closing it leaves you where you were.
 */
export function SettingsDialog({
  open,
  tab,
  onOpenChange,
}: {
  open: boolean;
  tab?: SettingsTab;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex flex-col overflow-clip bg-background data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(720px,calc(100dvh-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:flex-row sm:rounded-2xl sm:border sm:shadow-xl"
        >
          <SettingsTabs initial={tab ?? "general"} />
          {/* On narrow screens the tabs scroll sideways beneath it. */}
          <Dialog.Close className="absolute top-4 right-4 rounded-md bg-sidebar p-1 text-muted-foreground ring-8 ring-sidebar hover:bg-accent hover:text-foreground sm:bg-transparent sm:ring-0">
            <X className="size-4" />
            <span className="sr-only">{t("close")}</span>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SettingsTabs({ initial }: { initial: SettingsTab }) {
  const { t } = useI18n();
  const { data: model } = useQuery(modelQuery());
  const { data: account } = useQuery(accountQuery());
  // Members, how they sign in, and how the deployment runs are the admin's.
  const tabs = SETTINGS_TABS.filter(
    (tab) =>
      (tab !== "members" && tab !== "deployment") || account?.role === "admin",
  );
  const [tab, setTab] = useState(tabs.includes(initial) ? initial : "general");
  return (
    <>
      <nav
        aria-label={t("settings")}
        className="flex shrink-0 gap-1 overflow-x-auto bg-sidebar p-3 pr-14 sm:w-52 sm:flex-col sm:overflow-visible sm:pr-3"
      >
        <Dialog.Title className="sr-only px-3 pt-1 pb-3 font-semibold text-xl sm:not-sr-only">
          {t("settings")}
        </Dialog.Title>
        {tabs.map((value) => {
          const [label, Icon] = TAB_LABELS[value];
          return (
            <button
              key={value}
              type="button"
              aria-current={tab === value ? "page" : undefined}
              onClick={() => setTab(value)}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent",
                tab === value
                  ? "bg-sidebar-accent text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
              {t(label)}
            </button>
          );
        })}
      </nav>
      <div
        key={tab}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-6 scrollbar-thin sm:px-8 [&>*:first-child]:mt-0"
      >
        {tab === "general" && (
          <>
            <PreferencesSection />
            <EmailSection />
            <PushSection />
            <AppearanceSection />
          </>
        )}
        {tab === "model" && model && (
          <>
            <section className="mt-10 space-y-3">
              <h2 className="font-medium text-muted-foreground text-sm">
                {t("model")}
              </h2>
              <ModelChoices settings={model} />
              <UtilityModelSelect settings={model} />
            </section>
            <ProvidersSection
              settings={model}
              admin={account?.role === "admin"}
            />
          </>
        )}
        {tab === "computer" && (
          <>
            <CuaEvaluationSection />
            <ComputerSection />
          </>
        )}
        {tab === "memory" && <MemorySection />}
        {tab === "permissions" && <ToolPermissionsSection />}
        {tab === "account" && (
          <>
            <AccountSection />
            <SignInSection />
            <McpSection />
            <TokensSection />
            <DeleteAccountSection />
          </>
        )}
        {tab === "members" && (
          <>
            <MembersSection />
            <SignInMethodsSection />
          </>
        )}
        {tab === "deployment" && <DeploymentSection />}
      </div>
    </>
  );
}

/** The provider someone added that a model runs on, if it isn't Workers AI or the ChatGPT plan. */
const providerOf = (settings: ModelSettings, choice: ModelInfo) =>
  settings.providers.find((provider) => provider.provider === choice.provider);

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
                    {providerOf(settings, choice) ? (
                      <Server className="size-4" />
                    ) : (
                      <ModelProviderLogo
                        provider="cloudflare"
                        className="size-6"
                      />
                    )}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">
                    {modelName(choice.name)}
                  </span>
                  {choice.images && (
                    <span className="block truncate text-muted-foreground text-xs">
                      {t("seesImages")}
                    </span>
                  )}
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
      {!settings.chatgpt.connected && settings.providers.length === 0 && (
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

/** The utility model for side jobs: the deployment's small one by default, or any model Pim may use. */
function UtilityModelSelect({ settings }: { settings: ModelSettings }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { model, choices } = settings.utility;
  const choose = useMutation({
    mutationFn: (choice: ModelInfo) => pim.chooseUtilityModel(choice),
    onSuccess: ({ model }) => {
      queryClient.invalidateQueries({ queryKey: ["model"] });
      if (model) toast.success(t("utilityModelChanged", { model: model.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  const selected = choices.findIndex(
    (choice) => choice.provider === model?.provider && choice.id === model.id,
  );
  return (
    <label className="block space-y-1 pt-3">
      <span className="font-medium text-sm">{t("utilityModel")}</span>
      <Select
        value={selected === -1 ? undefined : String(selected)}
        onValueChange={(index) => {
          const choice = choices[Number(index)];
          if (choice) choose.mutate(choice);
        }}
        disabled={choose.isPending}
      >
        <SelectTrigger className="w-full" aria-label={t("utilityModel")}>
          <SelectValue placeholder={t("noUtilityModel")} />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice, index) => (
            <SelectItem
              key={`${choice.provider}/${choice.id}`}
              value={String(index)}
            >
              {modelName(choice.name)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="block text-muted-foreground text-xs">
        {t("utilityModelHint")}
      </span>
    </label>
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
              aria-label={theme.name}
              onClick={() => setColorTheme(theme.id)}
              className={cn(
                "rounded-2xl border p-1.5 text-left transition-colors",
                checked
                  ? "border-ring ring-2 ring-ring/40"
                  : "hover:border-foreground/30",
              )}
            >
              {/* Each miniature window uses its own colors, fonts and icons. */}
              <div
                data-theme={theme.id}
                className={cn(
                  "flex h-28 overflow-hidden rounded-xl border bg-background text-foreground",
                  resolved === "dark" && "dark",
                )}
                aria-hidden="true"
              >
                <div className="flex w-8 shrink-0 flex-col items-center gap-3 border-r bg-sidebar py-3 text-muted-foreground">
                  <MessageCircle className="size-4" />
                  <Bell className="size-4" />
                  <SlidersHorizontal className="size-4" />
                </div>
                <div className="flex min-w-0 flex-1 flex-col justify-center gap-2 p-2">
                  <div className="flex items-center gap-1.5 text-xs">
                    <Sparkles className="size-3.5 shrink-0" />
                    <span>Pim</span>
                  </div>
                  <div className="ml-auto max-w-full truncate rounded-full bg-bubble px-2 py-1 text-bubble-foreground text-xs">
                    {t("newChat")}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="h-2 w-3/5 rounded-full bg-muted" />
                    <code className="font-mono text-muted-foreground text-xs">
                      Aa
                    </code>
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
  const {
    data: enabled = false,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["push"],
    queryFn: pushEnabled,
    enabled: supported,
  });
  const allow = useMutation({
    mutationFn: enablePush,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["push"] }),
    onError: (error) => {
      if (error.message !== "notifications-blocked") toast.error(error.message);
    },
  });
  const granted = supported && Notification.permission === "granted";
  const blocked = supported && Notification.permission === "denied";

  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("pushNotifications")}
      </h2>
      <div className="space-y-3 rounded-2xl border bg-muted/20 p-4">
        <p className="text-sm">{t("pushDescription")}</p>
        {supported && !blocked && !granted && (
          <Button disabled={allow.isPending} onClick={() => allow.mutate()}>
            {t("pushAllow")}
          </Button>
        )}
        {granted && (
          <div className="space-y-2">
            <p role="status" className="text-[13px] text-muted-foreground">
              {t(
                error
                  ? "pushRegistrationFailed"
                  : enabled
                    ? "pushRegistered"
                    : "pushRegistering",
              )}
            </p>
            {error && (
              <Button
                variant="secondary"
                disabled={isFetching}
                onClick={() => void refetch()}
              >
                {t("tryAgain")}
              </Button>
            )}
          </div>
        )}
      </div>
      {(!supported || blocked) && (
        <p className="text-[13px] text-muted-foreground">
          {t(supported ? "pushBlocked" : "pushUnsupported")}
        </p>
      )}
    </section>
  );
}

/** The passkeys and linked accounts that sign in to this Pim, and signing out. */
function SignInSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  // The dev server signs you in itself; there is no sign-in to manage.
  const enabled =
    session?.method === "passkey" || session?.method === "identity";
  const { data: passkeys } = useQuery({ ...passkeysQuery(), enabled });
  const { data: identities } = useQuery({ ...identitiesQuery(), enabled });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["auth"] });
  // Linking sends the browser to the provider and back here, with why it didn't work.
  useEffect(() => {
    const error = authError();
    if (error) toast.error(error);
    forgetAuthError();
  }, []);

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
  const unlink = useMutation({
    mutationFn: auth.unlinkIdentity,
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const link = useMutation({
    mutationFn: (provider: ProviderId) => auth.withProvider(provider),
    onError: (error) => toast.error(error.message),
  });
  const providers = session?.providers ?? [];
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
      </div>
      {(providers.length > 0 || (identities?.length ?? 0) > 0) && (
        <>
          <h3 className="pt-4 font-medium text-sm">{t("linkedAccounts")}</h3>
          <p className="text-[13px] text-muted-foreground">
            {t("linkedAccountsDescription")}
          </p>
          {identities && identities.length > 0 && (
            <ul
              className="divide-y rounded-2xl border bg-muted/20"
              aria-label={t("linkedAccounts")}
            >
              {identities.map((identity) => (
                <IdentityRow
                  key={identity.id}
                  identity={identity}
                  providerName={
                    providers.find((p) => p.id === identity.provider)?.name ??
                    null
                  }
                  current={identity.id === session?.credential}
                  removing={
                    unlink.isPending && unlink.variables === identity.id
                  }
                  onRemove={() => unlink.mutate(identity.id)}
                />
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {providers.map((provider) => (
              <Button
                key={provider.id}
                variant="outline"
                onClick={() => link.mutate(provider.id)}
                disabled={link.isPending}
              >
                {link.isPending && link.variables === provider.id ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <ProviderLogo provider={provider.id} />
                )}
                {t("linkProvider", { provider: provider.name })}
              </Button>
            ))}
          </div>
        </>
      )}
      <div className="pt-2">
        <Button
          variant="ghost"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
        >
          <LogOut />
          {t("signOut")}
        </Button>
      </div>
    </section>
  );
}

function IdentityRow({
  identity,
  providerName,
  current,
  removing,
  onRemove,
}: {
  identity: LinkedIdentity;
  /** Null when the admin turned that provider off: it can't sign in for now. */
  providerName: string | null;
  current: boolean;
  removing: boolean;
  onRemove: () => void;
}) {
  const { t, formatDate } = useI18n();
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <ProviderLogo provider={identity.provider} className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">
          {identity.label}
          {current && (
            <span className="ml-2 font-normal text-muted-foreground text-xs">
              {t("thisBrowser")}
            </span>
          )}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          {providerName
            ? t("identityDates", {
                provider: providerName,
                used: formatDate(new Date(identity.lastUsedAt), {
                  dateStyle: "medium",
                }),
              })
            : t("providerTurnedOff")}
        </span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={t("unlinkIdentity", { name: identity.label })}
        title={current ? t("unlinkCurrentIdentity") : undefined}
        onClick={onRemove}
        disabled={removing}
      >
        {removing ? <Loader2 className="animate-spin" /> : <Trash2 />}
      </Button>
    </li>
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
