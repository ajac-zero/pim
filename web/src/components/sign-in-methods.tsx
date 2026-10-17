import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useI18n } from "~/components/i18n";
import { Check, Copy, ExternalLink } from "~/components/icons";
import { ProviderLogo } from "~/components/provider-buttons";
import { DASHBOARD_URL } from "~/components/sign-in";
import { Button } from "~/components/ui/button";
import { admin, type SignInProviderSettings } from "~/lib/pim-api";
import { accountQuery } from "~/lib/queries";

/** Where the admin makes each provider's client ID and secret. */
const CONSOLES: Partial<Record<SignInProviderSettings["id"], string>> = {
  google: "https://console.cloud.google.com/apis/credentials",
  github: "https://github.com/settings/applications/new",
};

/**
 * Which other ways to sign in besides passkeys are on: Google, GitHub, or a
 * single sign-on provider. The deployment's secrets turn each on, so this
 * only shows which are, and how to set one up: the callback URL to give the
 * provider, and the secrets to add in the Cloudflare dashboard.
 */
export function SignInMethodsSection() {
  const { t } = useI18n();
  const { data: account } = useQuery(accountQuery());
  const isAdmin = account?.role === "admin";
  const { data: providers } = useQuery({
    queryKey: ["admin", "sign-in"],
    queryFn: admin.signInProviders,
    enabled: isAdmin,
  });
  const [open, setOpen] = useState<SignInProviderSettings["id"] | null>(null);
  if (!isAdmin || !providers) return null;
  return (
    <section className="mt-10 space-y-3">
      <h2 className="font-medium text-muted-foreground text-sm">
        {t("signInMethods")}
      </h2>
      <p className="text-[13px] text-muted-foreground">
        {t("signInMethodsDescription")}
      </p>
      <ul
        className="divide-y rounded-2xl border bg-muted/20"
        aria-label={t("signInMethods")}
      >
        {providers.map((provider) => (
          <li key={provider.id} className="px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                <ProviderLogo provider={provider.id} className="size-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-sm">
                  {provider.id === "oidc" && !provider.enabled
                    ? t("customSignIn")
                    : provider.name}
                </span>
                <span className="block text-muted-foreground text-xs">
                  {provider.problem
                    ? t("signInMethodIncomplete", { problem: provider.problem })
                    : provider.enabled
                      ? t("signInMethodOn")
                      : t("signInMethodOff")}
                </span>
              </span>
              <Button
                variant="outline"
                size="sm"
                aria-expanded={open === provider.id}
                onClick={() =>
                  setOpen(open === provider.id ? null : provider.id)
                }
              >
                {open === provider.id
                  ? t("close")
                  : provider.enabled
                    ? t("details")
                    : t("setUp")}
              </Button>
            </div>
            {open === provider.id && <SetUpSteps provider={provider} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** How to turn a provider on: an app at the provider, then its ID and secret as the Worker's secrets. */
function SetUpSteps({ provider }: { provider: SignInProviderSettings }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const custom = provider.id === "oidc";
  const consoleUrl = CONSOLES[provider.id];
  const link =
    "inline-flex items-center gap-1 font-medium text-foreground underline-offset-2 hover:underline";
  return (
    <div className="mt-3 space-y-3 border-t pt-3 text-[13px]">
      <p className="text-muted-foreground">
        {t(custom ? "customSignInSteps" : "providerSignInSteps", {
          provider: provider.name,
        })}{" "}
        {consoleUrl && (
          <a
            href={consoleUrl}
            target="_blank"
            rel="noreferrer"
            className={link}
          >
            {t("openProviderConsole", { provider: provider.name })}
            <ExternalLink className="size-3" />
          </a>
        )}
      </p>
      <div>
        <span className="block">{t("callbackUrl")}</span>
        <div className="mt-1 flex gap-2">
          <code className="flex min-h-9 min-w-0 flex-1 items-center break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
            {provider.callbackUrl}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            onClick={async () => {
              await navigator.clipboard.writeText(provider.callbackUrl);
              setCopied(true);
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      </div>
      <div>
        <span className="block">
          {t(custom ? "customSignInSecrets" : "providerSignInSecrets")}
        </span>
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {provider.secrets.map((name) => (
            <li
              key={name}
              className="rounded-md bg-muted px-2 py-1 font-mono text-xs"
            >
              {name}
            </li>
          ))}
        </ul>
      </div>
      <a href={DASHBOARD_URL} target="_blank" rel="noreferrer" className={link}>
        {t("openCloudflareDashboard")}
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}
