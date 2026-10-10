import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Download, History, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  ArtifactCaution,
  ArtifactPreview,
  formatBytes,
} from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import { SessionLink } from "~/components/page";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import { ApiError, artifactDownloadUrl, pim } from "~/lib/pim-api";
import { artifactQuery, artifactVersionQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/artifacts/$artifactId")({
  validateSearch: (search: Record<string, unknown>): { v?: number } => {
    const v = Number(search.v);
    return Number.isSafeInteger(v) && v > 0 ? { v } : {};
  },
  component: ArtifactPage,
});

function ArtifactPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { artifactId } = Route.useParams();
  const { v } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<"preview" | "source">("preview");
  const { data: artifact, error } = useQuery(artifactQuery(artifactId));
  const version = v ?? artifact?.version;
  const source = useQuery({
    ...artifactVersionQuery(artifactId, version ?? 0),
    enabled: view === "source" && version !== undefined,
  });

  const restore = useMutation({
    mutationFn: ({ from, base }: { from: number; base: number }) =>
      pim.restoreArtifact(artifactId, from, base),
    onSuccess: (restored, { from }) => {
      toast.success(
        t("artifactRestored", { from, version: restored.restored }),
      );
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      void navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId },
        search: { v: restored.restored },
      });
    },
    onError: (failure) => {
      toast.error(failure.message);
      void queryClient.invalidateQueries({
        queryKey: ["artifacts", artifactId],
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => pim.deleteArtifact(artifactId),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["artifacts", artifactId] });
      void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
      toast.success(t("artifactDeletedToast"));
      void navigate({ to: "/artifacts" });
    },
    onError: (failure) => toast.error(failure.message),
  });

  if (error) {
    const gone = error instanceof ApiError && error.status === 404;
    return (
      <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-muted-foreground">
          {gone ? t("artifactDeleted") : error.message}
        </p>
        <Button asChild variant="outline">
          <Link to="/artifacts">{t("allArtifacts")}</Link>
        </Button>
      </main>
    );
  }
  if (!artifact || version === undefined) return null;
  const current = artifact.history.find((entry) => entry.version === version);
  const isLatest = version === artifact.version;

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <Link to="/artifacts" aria-label={t("allArtifacts")}>
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <h1 className="min-w-0 flex-1 truncate font-semibold">
          {artifact.title}
        </h1>
        <label className="flex items-center gap-1.5 text-sm">
          <History className="size-4 text-muted-foreground" />
          <span className="sr-only">{t("artifactHistory")}</span>
          <select
            value={version}
            onChange={(event) =>
              void navigate({
                to: "/artifacts/$artifactId",
                params: { artifactId },
                search: { v: Number(event.target.value) },
              })
            }
            className="h-8 max-w-48 rounded-md border bg-transparent px-2 text-sm"
          >
            {artifact.history.map((entry) => (
              <option key={entry.version} value={entry.version}>
                {t(
                  entry.source === "restore"
                    ? "artifactVersionRestoredOption"
                    : "artifactVersionOption",
                  {
                    version: entry.version,
                    from: entry.restoredFrom ?? 0,
                    date: formatDate(new Date(entry.createdAt), {
                      dateStyle: "short",
                      timeStyle: "short",
                    }),
                  },
                )}
              </option>
            ))}
          </select>
        </label>
        <div className="flex rounded-md border p-0.5 text-sm">
          {(["preview", "source"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={view === mode}
              onClick={() => setView(mode)}
              className={cn(
                "rounded px-2.5 py-1",
                view === mode && "bg-accent font-medium",
              )}
            >
              {t(mode === "preview" ? "artifactPreview" : "artifactSource")}
            </button>
          ))}
        </div>
        <Button asChild size="sm" variant="outline" className="h-8">
          <a href={artifactDownloadUrl(artifactId, version)} download>
            <Download className="size-3.5" />
            {t("download")}
          </a>
        </Button>
        {!isLatest && (
          <Button
            size="sm"
            className="h-8"
            disabled={restore.isPending}
            onClick={() =>
              restore.mutate({ from: version, base: artifact.version })
            }
          >
            {t("artifactRestore", { version })}
          </Button>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-destructive"
          aria-label={t("artifactDelete")}
          disabled={remove.isPending}
          onClick={() => {
            if (
              window.confirm(
                t("artifactDeleteConfirm", {
                  title: artifact.title,
                  versions: artifact.versions,
                }),
              )
            ) {
              remove.mutate();
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 md:p-3">
        {view === "preview" ? (
          <div className="min-h-0 flex-1">
            <ArtifactPreview
              id={artifactId}
              version={version}
              kind={artifact.kind}
              title={artifact.title}
              fill
            />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {source.data ? (
              <CodeBlock
                code={source.data.content}
                language={artifact.kind === "html" ? "html" : "markdown"}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                {source.error?.message ?? t("loading")}
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <ArtifactCaution />
          <p className="text-muted-foreground text-xs">
            {current &&
              t("artifactVersionDetails", {
                version,
                latest: artifact.version,
                size: formatBytes(current.size, formatNumber),
                sha: current.sha256.slice(0, 12),
              })}
            {artifact.session && (
              <>
                {" · "}
                <SessionLink session={artifact.session} />
              </>
            )}
          </p>
        </div>
      </div>
    </main>
  );
}
