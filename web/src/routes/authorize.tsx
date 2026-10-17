import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { PimMark } from "~/components/app-sidebar";
import { useI18n } from "~/components/i18n";
import { Loader2, TriangleAlert } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { auth } from "~/lib/auth";
import { majordomoQuery } from "~/lib/queries";

export const Route = createFileRoute("/authorize")({
  component: AuthorizePage,
});

/**
 * Where an MCP client, such as Claude or ChatGPT, asks to be let in to talk
 * with the person's majordomo. The client's request is this page's query;
 * the Worker checks it and says who is asking and where access would go
 * (src/mcp-auth.ts). The answer sends the browser back to the client. The
 * root shows it alone, without the app around it, once signed in.
 */
function AuthorizePage() {
  const { t } = useI18n();
  const search = window.location.search;
  // Asking starts a request that is answered once, in this browser: ask once per visit.
  const request = useQuery({
    queryKey: ["auth", "authorize", search],
    queryFn: () => auth.authorizationRequest(search),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const { data: majordomo } = useQuery(majordomoQuery());
  const answer = useMutation({
    mutationFn: async (allow: boolean) => {
      if (!request.data || !("handle" in request.data)) return;
      const { redirectTo } = await auth.answerAuthorization(
        request.data.handle,
        allow,
      );
      window.location.assign(redirectTo);
      // The page is leaving: stay pending until it does.
      await new Promise(() => {});
    },
  });
  const redirectTo =
    request.data && "redirectTo" in request.data
      ? request.data.redirectTo
      : null;
  useEffect(() => {
    if (redirectTo) window.location.replace(redirectTo);
  }, [redirectTo]);

  const error = request.error ?? answer.error;
  const asking = request.data && "handle" in request.data ? request.data : null;
  return (
    <main className="flex min-h-svh flex-col items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <PimMark className="mb-8 h-8 w-16" />
        {error ? (
          <>
            <h1 className="font-semibold text-2xl">
              {t("authorizeFailedTitle")}
            </h1>
            <p role="alert" className="mt-3 text-destructive text-sm">
              {error.message}
            </p>
            <p className="mt-3 text-muted-foreground text-sm">
              {t("authorizeFailedBody")}
            </p>
          </>
        ) : !asking || !majordomo ? (
          <Loader2
            className="size-5 animate-spin text-muted-foreground"
            aria-label={t("loading")}
          />
        ) : (
          <>
            <h1 className="font-semibold text-2xl">
              {t("authorizeTitle", {
                client: asking.client.name,
                majordomo: majordomo.agent.name,
              })}
            </h1>
            <p className="mt-3 text-muted-foreground text-sm">
              {t("authorizeBody", {
                client: asking.client.name,
                majordomo: majordomo.agent.name,
              })}
            </p>
            {/* Where access goes: the one fact about the client Pim can vouch for. */}
            <p className="mt-4 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">
                {t("authorizeSendsTo")}{" "}
              </span>
              <span className="break-all font-medium font-mono">
                {asking.client.redirectHost}
              </span>
            </p>
            {asking.client.local && (
              <p className="mt-3 flex gap-2 text-sm">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                {t("authorizeLocal")}
              </p>
            )}
            <Button
              className="mt-6 w-full"
              size="lg"
              onClick={() => answer.mutate(true)}
              disabled={answer.isPending}
            >
              {answer.isPending && answer.variables && (
                <Loader2 className="animate-spin" />
              )}
              {t("authorizeAllow")}
            </Button>
            <Button
              variant="ghost"
              className="mt-2 w-full text-muted-foreground"
              onClick={() => answer.mutate(false)}
              disabled={answer.isPending}
            >
              {t("deny")}
            </Button>
          </>
        )}
      </div>
    </main>
  );
}
