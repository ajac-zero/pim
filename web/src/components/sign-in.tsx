import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { auth, cancelled, forgetSetupCode, setupCode } from "~/lib/auth";

/** Where Workers Logs live; the dashboard picks the account. */
const DASHBOARD_URL =
  "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

/**
 * Shown instead of the app until a passkey signs this browser in. Without
 * one, it has the Worker write a setup link to its logs, which only the
 * Cloudflare account's owner can read; opening that link creates a passkey.
 */
export function SignIn({ hasPasskeys }: { hasPasskeys: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [setup, setSetup] = useState(setupCode);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A link pasted into this tab changes only the hash; nothing reloads.
  useEffect(() => {
    const update = () => setSetup(setupCode());
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);

  // Loaders ran while signed out and kept their errors: run them again.
  const onSuccess = async () => {
    await queryClient.invalidateQueries();
    await router.invalidate();
  };
  const onError = (failure: Error) =>
    setError(cancelled(failure) ? null : failure.message);
  const signIn = useMutation({
    mutationFn: auth.signIn,
    onMutate: () => setError(null),
    onSuccess,
    onError,
  });
  const create = useMutation({
    mutationFn: () => auth.addPasskey(setup ?? undefined),
    onMutate: () => setError(null),
    onSuccess: () => {
      forgetSetupCode();
      return onSuccess();
    },
    onError,
  });

  const pending = signIn.isPending || create.isPending;
  const icon = pending ? <Loader2 className="animate-spin" /> : <KeyRound />;

  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <PimMark className="mb-6 size-10" />
        {setup ? (
          <>
            <h1 className="font-semibold text-2xl">
              {t("createPasskeyTitle")}
            </h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("createPasskeyBody")}
            </p>
            <Button
              className="mt-6 w-full"
              size="lg"
              onClick={() => create.mutate()}
              disabled={pending}
            >
              {icon}
              {t("createPasskey")}
            </Button>
          </>
        ) : hasPasskeys && !recovering ? (
          <>
            <h1 className="font-semibold text-2xl">{t("signInTitle")}</h1>
            <p className="mt-2 text-muted-foreground text-sm">
              {t("signInBody")}
            </p>
            <Button
              className="mt-6 w-full"
              size="lg"
              onClick={() => signIn.mutate()}
              disabled={pending}
            >
              {icon}
              {t("signInWithPasskey")}
            </Button>
            <Button
              variant="ghost"
              className="mt-3 w-full text-muted-foreground"
              onClick={() => {
                setRecovering(true);
                setError(null);
              }}
            >
              {t("lostPasskey")}
            </Button>
          </>
        ) : (
          <SetupLinkSteps
            firstPasskey={!hasPasskeys}
            onBack={hasPasskeys ? () => setRecovering(false) : undefined}
          />
        )}

        {error && (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

/** Asks the Worker for a setup link, and says where to find it. */
function SetupLinkSteps({
  firstPasskey,
  onBack,
}: {
  firstPasskey: boolean;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const request = useMutation({ mutationFn: auth.requestSetupLink });
  const { mutate } = request;
  useEffect(() => mutate(), [mutate]);

  return (
    <>
      <h1 className="font-semibold text-2xl">
        {firstPasskey ? t("setUpTitle") : t("getSetupLinkTitle")}
      </h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {firstPasskey ? t("setUpBody") : t("getSetupLinkBody")}
      </p>
      <ol className="mt-6 list-decimal space-y-2 pl-5 text-sm">
        <li>{t("setupStepDashboard")}</li>
        <li>{t("setupStepOpen")}</li>
      </ol>
      <Button className="mt-6 w-full" asChild>
        <a href={DASHBOARD_URL} target="_blank" rel="noreferrer">
          {t("openCloudflareDashboard")}
          <ExternalLink />
        </a>
      </Button>
      <p
        className="mt-4 flex items-center gap-2 text-muted-foreground text-xs"
        aria-live="polite"
      >
        {request.isPending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : request.isSuccess ? (
          <Check className="size-3.5" />
        ) : null}
        {request.isError
          ? request.error.message
          : request.isSuccess
            ? t("setupLinkWritten")
            : t("writingSetupLink")}
      </p>
      <div className="mt-4 flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => request.mutate()}
          disabled={request.isPending}
        >
          {t("writeLinkAgain")}
        </Button>
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            {t("backToSignIn")}
          </Button>
        )}
      </div>
    </>
  );
}
