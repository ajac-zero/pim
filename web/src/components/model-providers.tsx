import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { toast } from "sonner";
import { CHATGPT_USAGE_URL, ChatGPTLogo } from "~/components/chatgpt-logo";
import { useI18n } from "~/components/i18n";
import { ExternalLink, Loader2, Plus, Server } from "~/components/icons";
import { ModelProviderLogo } from "~/components/model-logo";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import {
  admin as adminApi,
  type ModelProvider,
  type ModelSettings,
  type ProviderInput,
  pim,
} from "~/lib/pim-api";
import { modelName } from "~/lib/utils";

const WELCOMED_KEY = "pim-chatgpt-welcomed";

/**
 * Where the person's models run: Workers AI, built in; their ChatGPT plan;
 * and model services or custom endpoints, which the admin added
 * for everyone or the person added for themselves. Only the admin changes
 * the admin's.
 */
export function ProvidersSection({
  settings,
  admin,
}: {
  settings: ModelSettings;
  admin: boolean;
}) {
  const { t } = useI18n();
  const [adding, setAdding] = useState(false);
  return (
    <section className="mt-10 space-y-3">
      <div>
        <h2 className="font-medium text-muted-foreground text-sm">
          {t("providers")}
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("providersHint")}
        </p>
      </div>
      <ul
        className="divide-y overflow-hidden rounded-2xl border bg-muted/20"
        aria-label={t("providers")}
      >
        <li>
          <Row
            icon={
              <ModelProviderLogo provider="cloudflare" className="size-6" />
            }
            title={t("workersAI")}
            actions={
              <span className="text-muted-foreground text-sm">
                {t("providerOn")}
              </span>
            }
          />
        </li>
        <li>
          <ChatGPTProvider settings={settings} />
        </li>
        {settings.providers.map((provider) => (
          <li key={provider.provider}>
            <CustomProvider provider={provider} admin={admin} />
          </li>
        ))}
      </ul>
      {adding ? (
        <ProviderForm admin={admin} onDone={() => setAdding(false)} />
      ) : (
        <Button variant="outline" onClick={() => setAdding(true)}>
          <Plus className="size-4" />
          {t("addProvider")}
        </Button>
      )}
    </section>
  );
}

/** One provider: its tile, its name and what it is, and what can be done with it. */
function Row({
  icon,
  title,
  detail,
  actions,
  children,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium text-sm">{title}</span>
          {detail && (
            <span className="block text-muted-foreground text-xs">
              {detail}
            </span>
          )}
        </span>
        {actions && (
          <span className="flex shrink-0 items-center gap-1">{actions}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function CustomProvider({
  provider,
  admin,
}: {
  provider: ModelProvider;
  admin: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const editable = !provider.shared || admin;
  const remove = useMutation({
    mutationFn: () =>
      provider.shared
        ? adminApi.removeProvider(provider.id)
        : pim.removeProvider(provider.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["model"] });
      toast.success(t("providerRemoved", { name: provider.name }));
    },
    onError: (error) => toast.error(error.message),
  });
  const host = URL.parse(provider.url)?.host ?? provider.url;
  const models = provider.models
    .map((model) => modelName(model.name))
    .join(", ");
  return (
    <Row
      icon={<Server className="size-4" />}
      title={provider.name}
      detail={[provider.shared && t("providerShared"), host, models]
        .filter(Boolean)
        .join(" · ")}
      actions={
        editable &&
        !editing && (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              aria-label={t("editProviderNamed", { name: provider.name })}
            >
              {t("edit")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              aria-label={t("removeProviderNamed", { name: provider.name })}
            >
              {t("remove")}
            </Button>
          </>
        )
      }
    >
      {editing && (
        <ProviderForm
          admin={admin}
          provider={provider}
          onDone={() => setEditing(false)}
        />
      )}
    </Row>
  );
}

/**
 * Adds a provider, or changes `provider`. Saving reads its models from the
 * server again. A key left empty stays as it was.
 */
function ProviderForm({
  provider,
  admin,
  onDone,
}: {
  provider?: ModelProvider;
  admin: boolean;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState(provider?.name ?? "");
  const [url, setUrl] = useState(provider?.url ?? "");
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [models, setModels] = useState(provider?.chosen?.join(", ") ?? "");
  const [shared, setShared] = useState(false);
  const [structured, setStructured] = useState(
    provider?.structuredOutput ?? false,
  );
  const [kind, setKind] = useState(
    provider?.builtin ?? (provider ? "custom" : "anthropic"),
  );
  const [selected, setSelected] = useState<string[]>(provider?.chosen ?? []);
  const [search, setSearch] = useState("");
  const {
    data: catalog,
    error: catalogError,
    isPending: catalogPending,
  } = useQuery({
    queryKey: ["builtin-providers"],
    queryFn: pim.builtinProviders,
  });
  const builtin = kind !== "custom";
  const preset = catalog?.providers.find((entry) => entry.id === kind);
  const canSave = builtin
    ? !!preset && selected.length > 0 && (!!key.trim() || !!provider?.hasKey)
    : !!name.trim() && !!url.trim();
  const keyId = useId();
  const save = useMutation({
    mutationFn: () => {
      const input: ProviderInput = {
        ...(builtin
          ? { builtin: kind, models: selected }
          : {
              name: name.trim(),
              url: url.trim(),
              models: models
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean),
              structuredOutput: structured,
            }),
        ...(key.trim() ? { key: key.trim() } : removeKey ? { key: "" } : {}),
      };
      const api = (provider ? provider.shared : shared) ? adminApi : pim;
      return provider
        ? api.updateProvider(provider.id, input)
        : api.addProvider(input);
    },
    onSuccess: ({ provider: saved }) => {
      queryClient.invalidateQueries({ queryKey: ["model"] });
      toast.success(t("providerSaved", { name: saved.name }));
      onDone();
    },
    onError: (error) => toast.error(error.message),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canSave) save.mutate();
  };
  const field = "h-9";
  return (
    <form
      onSubmit={submit}
      className="mt-3 space-y-3 rounded-xl border bg-background p-4"
    >
      <div className="space-y-1">
        <span className="text-[13px] text-muted-foreground">
          {t("providerService")}
        </span>
        <Select
          value={kind}
          disabled={!!provider}
          onValueChange={(value) => {
            setKind(value);
            setSelected([]);
            setSearch("");
            setKey("");
            setRemoveKey(false);
          }}
        >
          <SelectTrigger className="w-full" aria-label={t("providerService")}>
            <SelectValue placeholder={t("providerService")} />
          </SelectTrigger>
          <SelectContent>
            {catalog?.providers.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>
                <ModelProviderLogo provider={entry.id} className="size-4" />
                {entry.name}
              </SelectItem>
            ))}
            <SelectItem value="custom">
              <Server className="size-4" />
              {t("providerCustom")}
            </SelectItem>
          </SelectContent>
        </Select>
        {catalogError && (
          <p className="text-destructive text-xs" role="alert">
            {catalogError.message}
          </p>
        )}
        {builtin && (
          <p className="text-muted-foreground text-xs">
            {t("providerApiBilling")}
          </p>
        )}
      </div>
      {!builtin && (
        <>
          <label className="block space-y-1">
            <span className="text-[13px] text-muted-foreground">
              {t("providerName")}
            </span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="LM Studio"
              className={field}
              required
              autoFocus
            />
          </label>
          <label className="block space-y-1">
            <span className="text-[13px] text-muted-foreground">
              {t("providerAddress")}
            </span>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://localhost:1234/v1"
              className={`${field} font-mono text-xs`}
              required
            />
            <span className="block text-muted-foreground text-xs">
              {t("providerAddressHint")}
            </span>
          </label>
        </>
      )}
      <div className="space-y-1">
        <span className="flex items-center justify-between">
          <label htmlFor={keyId} className="text-[13px] text-muted-foreground">
            {t("providerKey")}
          </label>
          {!builtin && provider?.hasKey && !removeKey && (
            <button
              type="button"
              className="text-link text-xs hover:underline"
              onClick={() => {
                setRemoveKey(true);
                setKey("");
              }}
            >
              {t("removeKey")}
            </button>
          )}
        </span>
        <Input
          id={keyId}
          type="password"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={
            provider?.hasKey && !removeKey
              ? t("providerKeyKept")
              : builtin
                ? t("providerKey")
                : t("providerKeyOptional")
          }
          className={field}
          autoComplete="off"
          required={builtin && !provider?.hasKey}
        />
        {removeKey && !key && (
          <span className="block text-muted-foreground text-xs">
            {t("keyRemoved")}
          </span>
        )}
      </div>
      {builtin ? (
        <fieldset className="space-y-2">
          <legend className="text-[13px] text-muted-foreground">
            {t("providerModels")} ·{" "}
            {t("providerModelsSelected", { count: selected.length })}
          </legend>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("providerSearchModels")}
            aria-label={t("providerSearchModels")}
            className={field}
          />
          <div className="max-h-48 overflow-y-auto rounded-xl bg-muted/30 p-2">
            {catalogPending && <Loader2 className="m-2 size-4 animate-spin" />}
            {preset?.models
              .filter((model) =>
                `${model.name} ${model.id}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              )
              .map((model) => (
                <label
                  key={model.id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    className="mt-1 accent-primary"
                    checked={selected.includes(model.id)}
                    disabled={
                      !selected.includes(model.id) && selected.length >= 50
                    }
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, model.id]
                          : selected.filter((id) => id !== model.id),
                      )
                    }
                  />
                  <span className="min-w-0 text-sm">
                    {modelName(model.name)}
                  </span>
                </label>
              ))}
            {preset &&
              !preset.models.some((model) =>
                `${model.name} ${model.id}`
                  .toLowerCase()
                  .includes(search.toLowerCase()),
              ) && (
                <p className="p-2 text-muted-foreground text-sm">
                  {t("providerNoModels")}
                </p>
              )}
          </div>
          <p className="text-muted-foreground text-xs">
            {t("providerChooseModels")}
          </p>
        </fieldset>
      ) : (
        <label className="block space-y-1">
          <span className="text-[13px] text-muted-foreground">
            {t("providerModels")}
          </span>
          <Input
            value={models}
            onChange={(event) => setModels(event.target.value)}
            placeholder={t("providerModelsAll")}
            className={field}
          />
          <span className="block text-muted-foreground text-xs">
            {t("providerModelsHint")}
          </span>
        </label>
      )}
      {!builtin && (
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>
            {t("providerStructured")}
            <span className="block text-muted-foreground text-xs">
              {t("providerStructuredHint")}
            </span>
          </span>
          <Switch checked={structured} onCheckedChange={setStructured} />
        </label>
      )}
      {admin && !provider && (
        <label className="flex items-center justify-between gap-3 text-sm">
          {t("providerForEveryone")}
          <Switch checked={shared} onCheckedChange={setShared} />
        </label>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("cancel")}
        </Button>
        <Button type="submit" disabled={!canSave || save.isPending}>
          {save.isPending && <Loader2 className="size-4 animate-spin" />}
          {provider ? t("save") : t("add")}
        </Button>
      </div>
    </form>
  );
}

/** The ChatGPT plan: signing in takes pasting back the address OpenAI sends the browser to. */
function ChatGPTProvider({ settings }: { settings: ModelSettings }) {
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
      <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <ChatGPTLogo className="size-8" />
        <h3 className="font-semibold text-lg">{t("usingYourPlanTitle")}</h3>
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
      </div>
    );
  }

  return (
    <Row
      icon={<ChatGPTLogo className="size-5 text-foreground" />}
      title={t("chatGPTPlan")}
      detail={
        connected
          ? t("connectedAs", { email: email ?? t("yourAccount") })
          : undefined
      }
      actions={
        connected ? (
          <>
            <Button variant="ghost" size="sm" asChild>
              <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
                {t("manageUsage")} <ExternalLink className="size-3.5" />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
            >
              {t("disconnect")}
            </Button>
          </>
        ) : (
          !waiting && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => start.mutate()}
              disabled={start.isPending}
            >
              {t("connect")}
            </Button>
          )
        )
      }
    >
      {!connected && waiting && (
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
      )}
    </Row>
  );
}
