import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertCircle,
  Check,
  ExternalLink,
  KeyRound,
  Loader2,
  LogOut,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { Page } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  auth,
  authSessionQuery,
  cancelled,
  type Passkey,
  passkeysQuery,
} from "~/lib/auth";
import {
  CHATGPT_PROVIDER,
  type ModelInfo,
  type ModelSettings,
  pim,
} from "~/lib/pim-api";
import { modelQuery } from "~/lib/queries";
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
      <ChatGPTCard settings={data} />
      <section className="mt-10 space-y-3">
        <h2 className="font-medium text-muted-foreground text-sm">
          {t("model")}
        </h2>
        <ModelChoices settings={data} />
      </section>
      <PasskeysSection />
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
      <ul className="divide-y rounded-xl border" aria-label={t("model")}>
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
                  <span className="flex size-5 shrink-0 items-center justify-center rounded bg-orange-500 font-bold text-[10px] text-white">
                    CF
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-sm">
                    {choice.name}
                  </span>
                  <span className="block truncate text-muted-foreground text-xs">
                    {plan ? t("usesChatGPTPlan") : t("runsOnWorkersAI")}
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
        <p className="px-1 text-muted-foreground text-xs">
          {t("connectForMoreModels")}
        </p>
      )}
      {settings.chatgpt.error && (
        <p className="flex items-start gap-2 px-1 text-destructive text-xs">
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
    <section className="rounded-xl border bg-card p-5 shadow-xs">
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
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            <li>{t("chatGPTStepApprove")}</li>
            <li>{t("chatGPTStepCopy")}</li>
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
        </form>
      ) : (
        <Button
          className="mt-4 bg-black text-white hover:bg-black/85 dark:bg-white dark:text-black dark:hover:bg-white/85"
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
      <p className="px-1 text-muted-foreground text-xs">
        {t("passkeysDescription")}
      </p>
      {passkeys && passkeys.length > 0 && (
        <ul className="divide-y rounded-xl border" aria-label={t("passkeys")}>
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
      <KeyRound className="size-5 shrink-0 text-muted-foreground" />
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
