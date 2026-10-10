import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, Download, Loader2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { type AccountsSession, auth, type Registered } from "~/lib/auth";
import { cn } from "~/lib/utils";

/** The username as typed, the way the service will read it. */
const normalize = (name: string) => name.trim().toLowerCase();

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Pimling's front door: pick a username, get a Pimling at
 * `<username>.<domain>`, save the recovery codes, then go there to make the
 * first passkey.
 */
export function Register({ session }: { session: AccountsSession }) {
  const { t } = useI18n();
  const [registered, setRegistered] = useState<Registered | null>(null);
  // People who already have a Pimling come here too: send them to it.
  const [returning, setReturning] = useState(session.registration === "closed");
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <PimMark className="mb-6 size-10" />
        {registered ? (
          <RecoveryCodes registered={registered} />
        ) : returning ? (
          <FindPimling session={session} />
        ) : (
          <RegistrationForm session={session} onRegistered={setRegistered} />
        )}
        {!registered && (
          <p className="mt-6 border-t pt-4 text-center text-muted-foreground text-sm">
            {returning && session.registration !== "closed" ? (
              <>
                {t("needPimling")}{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => setReturning(false)}
                >
                  {t("createOne")}
                </button>
              </>
            ) : !returning ? (
              <>
                {t("havePimling")}{" "}
                <button
                  type="button"
                  className="font-medium text-foreground underline-offset-2 hover:underline"
                  onClick={() => setReturning(true)}
                >
                  {t("signInToIt")}
                </button>
              </>
            ) : null}
          </p>
        )}
      </div>
    </main>
  );
}

/** Signing in again: the username leads to the person's own Pimling, where their passkey works. */
function FindPimling({ session }: { session: AccountsSession }) {
  const { t } = useI18n();
  const id = useId();
  const [username, setUsername] = useState("");
  const find = useMutation({
    mutationFn: () => auth.findPimling(normalize(username)),
    // Only an address the service gave, on its own domain, is followed.
    onSuccess: ({ url }) => {
      const target = new URL(url);
      if (target.hostname.endsWith(`.${session.domain}`))
        window.location.assign(target.origin);
    },
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (normalize(username)) find.mutate();
      }}
    >
      <h1 className="font-semibold text-2xl">{t("findPimlingTitle")}</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {t("findPimlingBody")}
      </p>
      <label htmlFor={id} className="mt-6 block font-medium text-sm">
        {t("username")}
      </label>
      <div className="mt-1.5 flex h-10 items-center rounded-md border bg-transparent pr-3 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <input
          id={id}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
        />
        <span className="shrink-0 text-muted-foreground text-sm">
          .{session.domain}
        </span>
      </div>
      <Button
        type="submit"
        size="lg"
        className="mt-6 w-full"
        disabled={!normalize(username) || find.isPending}
      >
        {find.isPending && <Loader2 className="animate-spin" />}
        {t("goToMyPimling")}
      </Button>
      {find.isError && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {find.error.message}
        </p>
      )}
    </form>
  );
}

function RegistrationForm({
  session,
  onRegistered,
}: {
  session: AccountsSession;
  onRegistered: (registered: Registered) => void;
}) {
  const { t } = useI18n();
  const usernameId = useId();
  const inviteId = useId();
  const [username, setUsername] = useState("");
  const [invite, setInvite] = useState("");
  const name = useDebounced(normalize(username), 300);
  const availability = useQuery({
    queryKey: ["username", name],
    queryFn: () => auth.usernameAvailable(name),
    enabled: name.length > 0,
    staleTime: 10_000,
  });
  const register = useMutation({
    mutationFn: () =>
      auth.register({
        username: normalize(username),
        ...(session.registration === "invite" ? { invite: invite.trim() } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: onRegistered,
  });

  if (session.registration === "closed") {
    return (
      <>
        <h1 className="font-semibold text-2xl">{t("registerTitle")}</h1>
        <p className="mt-2 text-muted-foreground text-sm">
          {t("registrationClosed")}
        </p>
      </>
    );
  }

  const current = name === normalize(username) ? availability.data : undefined;
  const ready =
    current?.available === true &&
    (session.registration !== "invite" || invite.trim() !== "");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) register.mutate();
      }}
    >
      <h1 className="font-semibold text-2xl">{t("registerTitle")}</h1>
      <p className="mt-2 text-muted-foreground text-sm">{t("registerBody")}</p>

      <label htmlFor={usernameId} className="mt-6 block font-medium text-sm">
        {t("username")}
      </label>
      <div className="mt-1.5 flex h-10 items-center rounded-md border bg-transparent pr-3 shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <input
          id={usernameId}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={32}
          className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
          aria-describedby={`${usernameId}-hint`}
        />
        <span className="shrink-0 text-muted-foreground text-sm">
          .{session.domain}
        </span>
      </div>
      <p
        id={`${usernameId}-hint`}
        className={cn(
          "mt-1.5 flex min-h-5 items-center gap-1.5 text-xs",
          current?.available === false
            ? "text-destructive"
            : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {name === "" ? (
          t("usernameHint")
        ) : !current ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : current.available ? (
          <>
            <Check className="size-3.5 text-primary" />
            {t("usernameAvailable", { host: `${name}.${session.domain}` })}
          </>
        ) : (
          <>
            <X className="size-3.5" />
            {current.reason}
          </>
        )}
      </p>

      {session.registration === "invite" && (
        <>
          <label htmlFor={inviteId} className="mt-4 block font-medium text-sm">
            {t("inviteCode")}
          </label>
          <Input
            id={inviteId}
            value={invite}
            onChange={(event) => setInvite(event.target.value)}
            spellCheck={false}
            className="mt-1.5 h-10 font-mono"
          />
        </>
      )}

      <Button
        type="submit"
        size="lg"
        className="mt-6 w-full"
        disabled={!ready || register.isPending}
      >
        {register.isPending && <Loader2 className="animate-spin" />}
        {t("createMyPimling")}
      </Button>
      {register.isError && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {register.error.message}
        </p>
      )}
      <p className="mt-6 text-muted-foreground text-xs">
        {t("registerFootnote")}
      </p>
    </form>
  );
}

/** Shown once: the codes that get the person back in without a passkey. */
function RecoveryCodes({ registered }: { registered: Registered }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `${t("recoveryCodesFileHeader", { host: new URL(registered.url).host })}\n\n${registered.recoveryCodes.join("\n")}\n`;
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = `pimling-${registered.username}-recovery-codes.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <>
      <h1 className="font-semibold text-2xl">{t("saveRecoveryCodesTitle")}</h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {t("saveRecoveryCodesBody")}
      </p>
      <ul
        className="mt-6 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border bg-card px-4 py-3 font-mono text-sm"
        aria-label={t("recoveryCodes")}
      >
        {registered.recoveryCodes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("copied") : t("copy")}
        </Button>
        <Button variant="outline" size="sm" onClick={download}>
          <Download />
          {t("download")}
        </Button>
      </div>
      <label className="mt-6 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.target.checked)}
          className="mt-0.5 size-4 accent-primary"
        />
        {t("savedRecoveryCodes")}
      </label>
      <Button
        size="lg"
        className="mt-4 w-full"
        disabled={!saved}
        onClick={() => window.location.assign(registered.setupUrl)}
      >
        {t("continueTo", { host: new URL(registered.url).host })}
      </Button>
      <p className="mt-4 text-muted-foreground text-xs">
        {t("setupLinkLasts")}
      </p>
    </>
  );
}
