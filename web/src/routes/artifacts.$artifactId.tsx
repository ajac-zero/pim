import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArtifactView } from "~/components/artifact-view";

export const Route = createFileRoute("/artifacts/$artifactId")({
  validateSearch: (search: Record<string, unknown>): { v?: number } => {
    const v = Number(search.v);
    return Number.isSafeInteger(v) && v > 0 ? { v } : {};
  },
  component: ArtifactPage,
});

/** An artifact on a page of its own, for one whose chat is gone or that was opened from elsewhere. */
function ArtifactPage() {
  const { artifactId } = Route.useParams();
  const { v } = Route.useSearch();
  const navigate = useNavigate();
  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <ArtifactView
        artifactId={artifactId}
        version={v}
        onVersion={(version) =>
          void navigate({
            to: "/artifacts/$artifactId",
            params: { artifactId },
            search: { v: version },
          })
        }
        onDeleted={() => void navigate({ to: "/artifacts" })}
      />
    </main>
  );
}
