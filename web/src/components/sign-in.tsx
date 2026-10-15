import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { PimMark } from "~/components/agent-icon";
import { useI18n } from "~/components/i18n";
import { Join } from "~/components/register";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  type AuthSession,
  alreadyRegistered,
  auth,
  cancelled,
  claimCode,
  deviceCode,
  forgetDeviceCode,
  forgetSetupCode,
  inviteCode,
  setupCode,
} from "~/lib/auth";

/** Where Workers Logs live; the dashboard picks the account. */
const DASHBOARD_URL =
  "https://dash.cloudflare.com/?to=/:account/workers-and-pages";

/**
 * Shown instead of the app until a passkey signs this browser in. Links open
 * here too: a setup link or a device link makes a passkey, a claim link or
 * an invite makes an account. A Pim with no admin yet is set up here by
 * whoever opens it in the minutes after a deploy; after that, by a link the
 * Worker writes to its logs, which only someone signed in to the Cloudflare
 * account can read. People who lost their passkey use a recovery code, and
 * the admin can also get a setup link from the logs.
 */
export function SignIn({ session }: { session: AuthSession }) {
  const { claimed = true, canClaim = false, registration = "invite" } = session;
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [setup, setSetup] = useState(setupCode);
  const [device, setDevice] = useState(deviceCode);
  const [claim, setClaim] = useState(claimCode);
  const [invite, setInvite] = useState(inviteCode);
  // Joining stays on screen until it's done: making the account changes the session (this Pim
  // is claimed now), and the recovery codes and the first passkey come after.
  const [view, setView] = useState<
    "signIn" | "claim" | "join" | "recover" | "logs"
  >(() =>
    !claimed && (canClaim || claimCode())
      ? "claim"
      : inviteCode()
        ? "join"
        : "signIn",
  );
  const [error, setError] = useState<string | null>(null);
  // While adding this device with a link: it already has a passkey for this Pim, so offer to sign
  // in with it instead. Other screens show the same news as an ordinary error.
  const [hasPasskeyHere, setHasPasskeyHere] = useState(false);
  const enrolling = device !== null;
  // A link pasted into this tab changes only the hash; nothing reloads.
  useEffect(() => {
    const update = () => {
      setSetup(setupCode());
      setDevice(deviceCode());
      setClaim(claimCode());
      setInvite(inviteCode());
      if (claimCode()) setView("claim");
      else if (inviteCode()) setView("join");
    };
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  const show = (next: typeof view) => {
    setView(next);
    setError(null);
  };

  // Loaders ran while signed out and kept their errors: run them again.
  const onSuccess = async () => {
    await queryClient.invalidateQueries();
    await router.invalidate();
  };
  const onError = (failure: Error) => {
    if (alreadyRegistered(failure) && enrolling) setHasPasskeyHere(true);
    setError(
      cancelled(failure)
        ? null
        : alreadyRegistered(failure)
          ? t("passkeyAlreadyHere")
          : failure.message,
    );
  };
  const signIn = useMutation({
    mutationFn: auth.signIn,
    onMutate: () => setError(null),
    onSuccess,
    onError,
  });
  /**
   * Leaves the enrollment for a plain sign-in with the passkey this device
   * already has. The device code is dropped first, so it's never sent again
   * from this page; the link itself stays good until it's used or expires, or
   * the device that made it cancels it.
   */
  const signInInstead = () => {
    forgetDeviceCode();
    setDevice(null);
    setHasPasskeyHere(false);
    signIn.mutate();
  };
  const create = useMutation({
    mutationFn: (recovery?: { username: string; code: string }) =>
      auth.addPasskey(
        recovery
          ? { username: recovery.username, recovery: recovery.code }
          : device
            ? { device }
            : setup
              ? { setup }
              : {},
      ),
    onMutate: () => setError(null),
    onSuccess: () => {
      forgetSetupCode();
      forgetDeviceCode();
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
        {device ? (
          <>
            <h1 className="font-semibold text-2xl">
              {t("addThisDeviceTitle")}
            </h1>
            {/* Which Pim this adds the device to: check it before making a passkey for it. */}
            <p className="mt-3 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t("addingTo")} </span>
              {/* Breaks only after a dot, so no part of the name is split. */}
              <span className="font-medium font-mono">
                {location.host.replaceAll(".", ".\u200b")}
              </span>
            </p>
            {/* Said here, where the choice is, instead of as an error below everything. */}
            <p className="mt-3 text-muted-foreground text-sm">
              {hasPasskeyHere
                ? t("passkeyAlreadyHere")
                : t("addThisDeviceBody")}
            </p>
            {hasPasskeyHere ? (
              <Button
                className="mt-6 w-full"
                size="lg"
                onClick={signInInstead}
                disabled={pending}
              >
                {icon}
                {t("signInWithThisPasskey")}
              </Button>
            ) : (
              <Button
                className="mt-6 w-full"
                size="lg"
                onClick={() => create.mutate(undefined)}
                disabled={pending}
              >
                {icon}
                {t("createPasskey")}
              </Button>
            )}
            <p className="mt-4 text-muted-foreground text-xs">
              {t("addThisDeviceNote")}
            </p>
            <Button
              variant="ghost"
              className="mt-2 w-full text-muted-foreground"
              onClick={() => {
                forgetDeviceCode();
                setDevice(null);
                setHasPasskeyHere(false);
                setError(null);
              }}
            >
              {t("notMyPim")}
            </Button>
          </>
        ) : setup ? (
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
              onClick={() => create.mutate(undefined)}
              disabled={pending}
            >
              {icon}
              {t("createPasskey")}
            </Button>
          </>
        ) : view === "claim" ? (
          <Join mode="claim" claim={claim} />
        ) : !claimed ? (
          <SetupLinkSteps firstPasskey />
        ) : view === "join" ? (
          <Join
            mode={registration === "open" ? "open" : "invite"}
            invite={invite}
            onBack={() => {
              forgetSetupCode();
              setInvite(null);
              show("signIn");
            }}
          />
        ) : view === "recover" ? (
          <RecoveryCodeSteps
            pending={pending}
            onSubmit={(username, code) => create.mutate({ username, code })}
            onLogs={() => show("logs")}
            onBack={() => show("signIn")}
          />
        ) : view === "logs" ? (
          <SetupLinkSteps firstPasskey={false} onBack={() => show("signIn")} />
        ) : (
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
              onClick={() => show("recover")}
            >
              {t("lostPasskey")}
            </Button>
            {/* The commonest snag: a passkey made on another device that this one doesn't have. */}
            <div className="mt-6 rounded-lg border px-4 py-3 text-sm">
              <p className="font-medium">{t("newDeviceTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("newDeviceBody")}</p>
            </div>
            <p className="mt-6 border-t pt-4 text-center text-muted-foreground text-sm">
              {registration === "open" ? (
                <>
                  {t("newHere")}{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                    onClick={() => show("join")}
                  >
                    {t("createAccount")}
                  </button>
                </>
              ) : registration === "invite" ? (
                t("joinByInvite")
              ) : (
                t("registrationClosed")
              )}
            </p>
          </>
        )}

        {error && !(enrolling && hasPasskeyHere) && (
          <p role="alert" className="mt-4 text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

/** A recovery code from joining adds a passkey, once, with the username it belongs to. */
function RecoveryCodeSteps({
  pending,
  onSubmit,
  onLogs,
  onBack,
}: {
  pending: boolean;
  onSubmit: (username: string, code: string) => void;
  onLogs: () => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  const ready = username.trim() !== "" && code.trim() !== "";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit(username.trim(), code.trim());
      }}
    >
      <h1 className="font-semibold text-2xl">{t("recoveryCodeTitle")}</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {t("recoveryCodeBody")}
      </p>
      <Input
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        placeholder={t("username")}
        aria-label={t("username")}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        className="mt-6 h-10"
        autoFocus
      />
      <Input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="xxxxx-xxxxx-xxxxx"
        aria-label={t("recoveryCode")}
        autoComplete="one-time-code"
        spellCheck={false}
        className="mt-3 h-10 font-mono"
      />
      <Button
        type="submit"
        className="mt-3 w-full"
        size="lg"
        disabled={pending || !ready}
      >
        {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {t("createPasskey")}
      </Button>
      <p className="mt-6 text-muted-foreground text-xs">
        {t("adminLostPasskey")}{" "}
        <button
          type="button"
          className="font-medium text-foreground underline-offset-2 hover:underline"
          onClick={onLogs}
        >
          {t("getSetupLinkFromLogs")}
        </button>
      </p>
      <Button
        type="button"
        variant="ghost"
        className="mt-3 w-full text-muted-foreground"
        onClick={onBack}
      >
        {t("backToSignIn")}
      </Button>
    </form>
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
