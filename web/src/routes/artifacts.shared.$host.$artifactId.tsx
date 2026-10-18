import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import {
  ArtifactCaution,
  ArtifactPreview,
  ArtifactPrint,
} from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import { ArrowLeft, Printer } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ApiError } from "~/lib/pim-api";
import { sharedArtifactQuery } from "~/lib/queries";

export const Route = createFileRoute("/artifacts/shared/$host/$artifactId")({
  component: SharedArtifactPage,
});

/**
 * An artifact someone shared with you, as its latest version: to use, and
 * print, but not to change. Its page runs here as yours does: what it keeps
 * for you stays in your Pim, and the model and apps it asks for are yours.
 */
function SharedArtifactPage() {
  const { t } = useI18n();
  const { host, artifactId } = Route.useParams();
  const { data: artifact, error } = useQuery(
    sharedArtifactQuery(host, artifactId),
  );
  const [printing, setPrinting] = useState(false);
  const donePrinting = useCallback(() => setPrinting(false), []);

  if (error) {
    const gone = error instanceof ApiError && [403, 404].includes(error.status);
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {gone ? t("sharedArtifactGone", { host }) : error.message}
        </p>
        <Button asChild variant="outline">
          <Link to="/artifacts">{t("allArtifacts")}</Link>
        </Button>
      </main>
    );
  }
  if (!artifact) return null;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <Link to="/artifacts" aria-label={t("allArtifacts")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-semibold">
          {artifact.title}
        </h1>
        <span className="text-muted-foreground text-sm">
          {t("sharedBy", { host })}
        </span>
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
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
        <div className="min-h-0 flex-1">
          <ArtifactPreview
            id={artifact.id}
            version={artifact.version}
            kind={artifact.kind}
            title={artifact.title}
            from={{ host }}
            fill
          />
        </div>
        <ArtifactCaution kind={artifact.kind} />
        {printing && (
          <ArtifactPrint
            id={artifact.id}
            version={artifact.version}
            kind={artifact.kind}
            title={artifact.title}
            from={{ host }}
            onDone={donePrinting}
          />
        )}
      </div>
    </main>
  );
}
