import { createFileRoute } from "@tanstack/react-router";
import { FileMissing, FileView } from "~/components/file-view";
import { FILES_ROOT } from "~/lib/pim-api";

export const Route = createFileRoute("/files")({
  validateSearch: (search: Record<string, unknown>): { path?: string } =>
    typeof search.path === "string" && search.path.startsWith(`${FILES_ROOT}/`)
      ? { path: search.path }
      : {},
  component: FilePage,
});

function FilePage() {
  const { path } = Route.useSearch();
  return path ? <FileView key={path} path={path} /> : <FileMissing />;
}
