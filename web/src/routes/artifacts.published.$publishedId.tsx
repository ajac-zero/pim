import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  ARTIFACT_KIND_NAMES,
  ArtifactCaution,
  ArtifactPreview,
  ArtifactPrint,
} from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import { ArrowLeft, Copy, Printer, Trash2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ApiError, admin, pim } from "~/lib/pim-api";
import { accountQuery, publishedArtifactQuery } from "~/lib/queries";

export const Route = createFileRoute("/artifacts/published/$publishedId")({
  component: PublishedArtifactPage,
});

const PUBLISHED = { published: true } as const;

/**
 * An artifact someone published for everyone on this Pim, as the version
 * they published. It runs here as your own do: what it keeps for you stays
 * in your Pim, and the model and apps it asks for are yours. Making it your
 * own copies it into your artifacts, to change.
 */
function PublishedArtifactPage() {
  const { t, formatDate } = useI18n();
  const { publishedId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: account } = useQuery(accountQuery());
  const { data: artifact, error } = useQuery(
    publishedArtifactQuery(publishedId),
  );
  const [printing, setPrinting] = useState(false);
  const donePrinting = useCallback(() => setPrinting(false), []);
  const use = useMutation({
    mutationFn: () => pim.adoptArtifact(publishedId),
    onSuccess: (copy) => {
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      void queryClient.invalidateQueries({
        queryKey: ["published-artifacts"],
      });
      toast.success(t("artifactMadeYourOwn", { title: copy.title }));
      void navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId: copy.id },
      });
    },
    onError: (failure) => toast.error(failure.message),
  });
  const takeDown = useMutation({
    mutationFn: () => admin.removePublishedArtifact(publishedId),
    onSuccess: () => {
      queryClient.removeQueries({
        queryKey: ["published-artifacts", publishedId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["published-artifacts"],
      });
      toast.success(t("artifactTakenDown"));
      void navigate({ to: "/", search: { dialog: "discover" } });
    },
    onError: (failure) => toast.error(failure.message),
  });

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {gone ? t("publishedArtifactGone") : error.message}
        </p>
        <Button asChild variant="outline">
          <Link to="/" search={{ dialog: "discover" }}>
            {t("backToDiscover")}
          </Link>
        </Button>
      </main>
    );
  }
  if (!artifact) return null;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <Link
            to="/"
            search={{ dialog: "discover" }}
            aria-label={t("backToDiscover")}
          >
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{artifact.title}</h1>
          <p className="truncate text-muted-foreground text-xs">
            {ARTIFACT_KIND_NAMES[artifact.kind]} · {t("publishedBy")}{" "}
            <Link
              to="/people/$username"
              params={{ username: artifact.author }}
              className="text-foreground underline underline-offset-2"
            >
              {artifact.authorName ?? `@${artifact.author}`}
            </Link>
            {" · "}
            {formatDate(new Date(artifact.publishedAt), {
              dateStyle: "medium",
            })}
            {artifact.uses > 0 &&
              ` · ${t("templateUses", { count: artifact.uses })}`}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label={t("artifactPrint")}
          title={t("artifactPrint")}
          disabled={printing}
          onClick={() => setPrinting(true)}
        >
          <Printer className="size-4" />
        </Button>
        {account?.role === "admin" && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-destructive"
            disabled={takeDown.isPending}
            onClick={() => {
              if (
                window.confirm(
                  t("artifactTakeDownConfirm", { title: artifact.title }),
                )
              ) {
                takeDown.mutate();
              }
            }}
          >
            <Trash2 className="size-3.5" />
            {t("artifactTakeDown")}
          </Button>
        )}
        <Button
          size="sm"
          className="h-8"
          disabled={use.isPending}
          onClick={() => use.mutate()}
        >
          <Copy className="size-3.5" />
          {t("makeItYourOwn")}
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
        <div className="min-h-0 flex-1">
          <ArtifactPreview
            id={artifact.id}
            version={artifact.version}
            kind={artifact.kind}
            title={artifact.title}
            from={PUBLISHED}
            fill
          />
        </div>
        <ArtifactCaution />
        {printing && (
          <ArtifactPrint
            id={artifact.id}
            version={artifact.version}
            kind={artifact.kind}
            title={artifact.title}
            from={PUBLISHED}
            onDone={donePrinting}
          />
        )}
      </div>
    </main>
  );
}
