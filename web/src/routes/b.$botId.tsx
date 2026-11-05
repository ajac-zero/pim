import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AgentIcon } from "~/components/agent-icon";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { KeyRound, Loader2 } from "~/components/icons";
import { ProviderButtons } from "~/components/provider-buttons";
import { Join } from "~/components/register";
import { Button } from "~/components/ui/button";
import {
  alreadyRegistered,
  auth,
  authSessionQuery,
  cancelled,
} from "~/lib/auth";
import { ApiError, pim } from "~/lib/pim-api";

export const Route = createFileRoute("/b/$botId")({ component: BotPage });

/**
 * A bot's public link: what the bot is, and joining to chat with it as a
 * guest, or signing in again. The root shows it alone, signed in or not;
 * a guest of this bot goes on to their chats.
 */
function BotPage() {
  const { botId } = Route.useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const { data: bot, error } = useQuery({
    queryKey: ["public-bot", botId],
    queryFn: () => pim.publicBot(botId),
    retry: false,
  });
  const { data: session } = useQuery(authSessionQuery());
  const { data: guest } = useQuery({
    queryKey: ["guest-bot"],
    queryFn: pim.guestBot,
    enabled: session?.account?.role === "guest",
  });
  const own = guest?.bot?.id === botId;
  useEffect(() => {
    if (own) void navigate({ to: "/", replace: true });
  }, [own, navigate]);
  useEffect(() => {
    if (bot) document.title = `${bot.name} · Pim`;
  }, [bot]);

  if (error) {
    return (
      <main className="flex min-h-svh items-center justify-center px-6 text-center text-muted-foreground">
        {error instanceof ApiError && error.status === 404
          ? t("botGone")
          : error.message}
      </main>
    );
  }
  if (!bot || !session || own) {
    return (
      <main className="flex min-h-svh items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </main>
    );
  }
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-start gap-3">
          <AgentIcon
            agent={{
              id: bot.id,
              icon: null,
              symbol: bot.symbol,
              color: bot.color,
            }}
            src={
              bot.icon === null
                ? undefined
                : `/api/bots/${bot.id}/icon?v=${bot.icon}`
            }
            tile
            className="size-12 shrink-0 rounded-xl"
          />
          <div className="min-w-0">
            <h1 className="font-semibold text-2xl">{bot.name}</h1>
            <p className="text-[13px] text-muted-foreground">
              {t("guestBotBy", { author: bot.authorName ?? `@${bot.author}` })}
            </p>
          </div>
        </div>
        {bot.description && (
          <p className="mt-4 text-[15px]">{bot.description}</p>
        )}
        <div className="mt-8">
          {session.signedIn ? (
            <SignedInElsewhere
              username={session.account?.username ?? ""}
              guest={session.account?.role === "guest"}
            />
          ) : (
            <JoinOrSignIn botId={bot.id} />
          )}
        </div>
      </div>
      <p className="mt-12 flex items-center gap-2 text-[13px] text-muted-foreground">
        <PimMark className="h-3 w-6" />
        {t("guestPoweredBy")}
      </p>
    </main>
  );
}

/** Signed out: join to chat with the bot, or sign in again to the account that joined before. */
function JoinOrSignIn({ botId }: { botId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { data: session } = useQuery(authSessionQuery());
  const [joining, setJoining] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const signIn = useMutation({
    mutationFn: auth.signIn,
    onMutate: () => setError(null),
    onSuccess: () => queryClient.invalidateQueries(),
    onError: (failure) =>
      setError(
        cancelled(failure)
          ? null
          : alreadyRegistered(failure)
            ? t("passkeyAlreadyHere")
            : failure.message,
      ),
  });
  if (joining) {
    return <Join mode="bot" bot={botId} onBack={() => setJoining(false)} />;
  }
  return (
    <>
      <Button
        size="lg"
        className="w-full"
        onClick={() => signIn.mutate()}
        disabled={signIn.isPending}
      >
        {signIn.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        {t("signInWithPasskey")}
      </Button>
      <ProviderButtons
        providers={session?.providers}
        onError={(failure) => setError(failure.message)}
      />
      {error && (
        <p role="alert" className="mt-4 text-destructive text-sm">
          {error}
        </p>
      )}
      <Button
        variant="ghost"
        className="mt-3 w-full text-muted-foreground"
        onClick={() => setJoining(true)}
      >
        {t("botJoinInstead")}
      </Button>
    </>
  );
}

/** Signed in as someone who isn't this bot's guest: a member, the admin, or another bot's guest. */
function SignedInElsewhere({
  username,
  guest,
}: {
  username: string;
  guest: boolean;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: auth.signOut,
    onSuccess: () => queryClient.invalidateQueries(),
  });
  return (
    <div className="rounded-2xl border bg-muted/20 p-4 text-[15px]">
      <p>{t(guest ? "botSignedInAsGuest" : "botSignedInAs", { username })}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {!guest && (
          <Button size="sm" asChild>
            <Link to="/">{t("botOpenPim")}</Link>
          </Button>
        )}
        <Button
          size="sm"
          variant={guest ? "default" : "secondary"}
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
        >
          {t("signOut")}
        </Button>
      </div>
    </div>
  );
}
