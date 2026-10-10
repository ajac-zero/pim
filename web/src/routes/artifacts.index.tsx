import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Shapes } from "lucide-react";
import { ArtifactIcon, formatBytes } from "~/components/artifact";
import { useI18n } from "~/components/i18n";
import { EmptyState, Page } from "~/components/page";
import { artifactsQuery } from "~/lib/queries";

export const Route = createFileRoute("/artifacts/")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(artifactsQuery()),
  component: ArtifactsPage,
});

function ArtifactsPage() {
  const { t, formatDate, formatNumber } = useI18n();
  const { data } = useQuery(artifactsQuery());
  const artifacts = data?.artifacts ?? [];
  return (
    <Page title={t("artifacts")} description={t("artifactsDescription")}>
      {artifacts.length === 0 ? (
        <EmptyState
          icon={<Shapes className="size-5" />}
          text={t("noArtifacts")}
        />
      ) : (
        <ul className="divide-y rounded-xl border">
          {artifacts.map((artifact) => (
            <li key={artifact.id}>
              <Link
                to="/artifacts/$artifactId"
                params={{ artifactId: artifact.id }}
                search={{ v: artifact.version }}
                className="flex items-center gap-3 p-4 hover:bg-accent/40"
              >
                <ArtifactIcon
                  kind={artifact.kind}
                  className="size-5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-sm">
                    {artifact.title}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("artifactSummary", {
                      version: artifact.version,
                      kind: artifact.kind === "html" ? "HTML" : "Markdown",
                      size: formatBytes(artifact.size, formatNumber),
                    })}
                  </p>
                </div>
                <time className="shrink-0 text-muted-foreground text-xs">
                  {formatDate(new Date(artifact.updatedAt), {
                    dateStyle: "medium",
                  })}
                </time>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
