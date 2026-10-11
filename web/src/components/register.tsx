import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Check, Copy, Download, KeyRound, Loader2, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  alreadyRegistered,
  auth,
  cancelled,
  forgetSetupCode,
  type Registered,
} from "~/lib/auth";
import { MAX_PIM_NAME, pim } from "~/lib/pim-api";
import { personasQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The username as typed, the way the Worker will read it. */
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
 * Joining this Pim: pick a username, save the recovery codes, make the
 * first passkey, right here, then name your Pim. `claim` is for the first person on a Pim with no
 * admin, who becomes it: in the minutes after a deploy (no code), or with
 * the link from the Worker's logs.
 */
export function Join({
  mode,
  claim,
  invite,
  onBack,
}: {
  mode: "claim" | "invite" | "open";
  claim?: string | null;
  invite?: string | null;
  onBack?: () => void;
}) {
  const [registered, setRegistered] = useState<Registered | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  return signedIn ? (
    <NamePim />
  ) : registered ? (
    <RecoveryCodes
      registered={registered}
      onSignedIn={() => setSignedIn(true)}
    />
  ) : (
    <RegistrationForm
      mode={mode}
      claim={claim}
      invite={invite}
      onRegistered={(fresh) => {
        // The claim or invite is used: keep it out of the address bar and history.
        forgetSetupCode();
        setRegistered(fresh);
      }}
      onBack={onBack}
    />
  );
}

function RegistrationForm({
  mode,
  claim,
  invite: given,
  onRegistered,
  onBack,
}: {
  mode: "claim" | "invite" | "open";
  claim?: string | null;
  invite?: string | null;
  onRegistered: (registered: Registered) => void;
  onBack?: () => void;
}) {
  const { t } = useI18n();
  const usernameId = useId();
  const inviteId = useId();
  const [username, setUsername] = useState("");
  const [invite, setInvite] = useState(given ?? "");
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
        ...(mode === "invite" ? { invite: invite.trim() } : {}),
        ...(mode === "claim" && claim ? { claim } : {}),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    onSuccess: onRegistered,
  });

  const current = name === normalize(username) ? availability.data : undefined;
  const ready =
    current?.available === true && (mode !== "invite" || invite.trim() !== "");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) register.mutate();
      }}
    >
      <h1 className="font-semibold text-2xl">
        {mode === "claim" ? t("setUpTitle") : t("registerTitle")}
      </h1>
      <p className="mt-2 text-muted-foreground text-sm">
        {mode === "claim" ? t("claimBody") : t("registerBody")}
      </p>

      <label htmlFor={usernameId} className="mt-6 block font-medium text-sm">
        {t("username")}
      </label>
      <Input
        id={usernameId}
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={32}
        className="mt-1.5 h-10"
        aria-describedby={`${usernameId}-hint`}
        autoFocus
      />
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
            {t("usernameAvailable", { username: name })}
          </>
        ) : (
          <>
            <X className="size-3.5" />
            {current.reason}
          </>
        )}
      </p>

      {/* An invite link fills it in; typed only when someone sent the code alone. */}
      {mode === "invite" && !given && (
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
        {mode === "claim" ? t("becomeAdmin") : t("createAccount")}
      </Button>
      {register.isError && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {register.error.message}
        </p>
      )}
      <p className="mt-6 text-muted-foreground text-xs">
        {t("registerFootnote")}
      </p>
      {onBack && (
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full text-muted-foreground"
          onClick={onBack}
        >
          {t("backToSignIn")}
        </Button>
      )}
    </form>
  );
}

/** Shown once: the codes that get the person back in without a passkey, then their first passkey. */
function RecoveryCodes({
  registered,
  onSignedIn,
}: {
  registered: Registered;
  onSignedIn: () => void;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = `${t("recoveryCodesFileHeader", { username: registered.username, host: location.host })}\n\n${registered.recoveryCodes.join("\n")}\n`;
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    link.download = `pim-${registered.username}-recovery-codes.txt`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  // The setup code works for a day, so a cancelled prompt can be tried again.
  const create = useMutation({
    mutationFn: () => auth.addPasskey({ setup: registered.setup }),
    onSuccess: onSignedIn,
  });
  const error =
    create.error && !cancelled(create.error)
      ? alreadyRegistered(create.error)
        ? t("passkeyAlreadyHere")
        : create.error.message
      : null;

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
        disabled={!saved || create.isPending}
        onClick={() => create.mutate()}
      >
        {create.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {t("createPasskey")}
      </Button>
      <p className="mt-4 text-muted-foreground text-xs">
        {t("firstPasskeyNote")}
      </p>
      {error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * Last, signed in: name the Pim you'll talk with. It starts as the one the
 * admin chose for everyone (or a plain one), and you can change it later in
 * Your Pims. Leaving the page here keeps the name it came with.
 */
function NamePim() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const router = useRouter();
  const nameId = useId();
  const { data: personas } = useQuery(personasQuery());
  const mine = personas?.find((candidate) => candidate.default);
  const [name, setName] = useState<string | null>(null);
  const shown = name ?? mine?.name ?? "";
  const start = useMutation({
    mutationFn: async () => {
      if (mine && shown.trim() !== mine.name) {
        await pim.updatePersona(mine.id, { name: shown.trim() });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await router.invalidate();
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        start.mutate();
      }}
    >
      <h1 className="font-semibold text-2xl">{t("namePimTitle")}</h1>
      <p className="mt-2 text-muted-foreground text-sm">{t("namePimBody")}</p>
      {mine?.source && (
        <div className="mt-6 rounded-xl border bg-card px-4 py-3 text-sm">
          <p className="text-muted-foreground text-xs">
            {t("namePimTemplate", { author: mine.source.author })}
          </p>
          {mine.description && <p className="mt-1">{mine.description}</p>}
        </div>
      )}
      <label htmlFor={nameId} className="mt-6 block font-medium text-sm">
        {t("namePimLabel")}
      </label>
      <Input
        id={nameId}
        value={shown}
        onChange={(event) => setName(event.target.value)}
        maxLength={MAX_PIM_NAME}
        className="mt-1.5 h-10"
        disabled={!mine}
        required
        autoFocus
      />
      <Button
        type="submit"
        size="lg"
        className="mt-6 w-full"
        disabled={!mine || shown.trim() === "" || start.isPending}
      >
        {start.isPending && <Loader2 className="animate-spin" />}
        {t("namePimStart")}
      </Button>
      {start.isError && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {start.error.message}
        </p>
      )}
    </form>
  );
}
