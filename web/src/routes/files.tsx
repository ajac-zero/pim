import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { BundledLanguage } from "shiki";
import { toast } from "sonner";
import { formatBytes } from "~/components/artifact";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import { Download, Trash2 } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import { baseName, displayPath, parentOf, previewOf } from "~/lib/files";
import { ApiError, FILES_ROOT, fileContentUrl, pim } from "~/lib/pim-api";
import { filesQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The largest text file the page shows; bigger ones are for downloading. */
const MAX_TEXT_PREVIEW = 1_000_000;

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

function FileMissing({ message }: { message?: string }) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-muted-foreground">{message ?? t("fileMissing")}</p>
      <Button asChild variant="outline">
        <Link to="/" search={{ panel: "files" }}>
          {t("allFiles")}
        </Link>
      </Button>
    </main>
  );
}

/** One of your files, shown as well as the app can, to read or download. */
function FileView({ path }: { path: string }) {
  const { t, formatNumber } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const preview = previewOf(baseName(path));
  const textual = ["markdown", "code", "text"].includes(preview.kind);
  // The folder's listing says whether the file is there, and its size.
  const listing = useQuery(filesQuery(parentOf(path) ?? FILES_ROOT));
  const entry = listing.data?.entries.find(
    (candidate) => candidate.path === path && candidate.type === "file",
  );
  const showText = textual && !!entry && entry.size <= MAX_TEXT_PREVIEW;
  const content = useQuery({
    // A newer version of the file is another key, so the page shows what the agent just wrote.
    queryKey: ["files", "content", path, entry?.updatedAt],
    enabled: showText,
    retry: false,
    queryFn: async () => {
      const response = await fetch(fileContentUrl(path));
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(response.status, t("fileMissing"));
      }
      return response.text();
    },
  });
  const remove = useMutation({
    mutationFn: () => pim.deleteFile(path),
    onSuccess: () => {
      toast.success(t("fileDeleted", { name: baseName(path) }));
      void queryClient.invalidateQueries({ queryKey: ["files"] });
      void navigate({ to: "/", search: { panel: "files" } });
    },
    onError: (failure) => toast.error(failure.message),
  });

  const error = listing.error ?? content.error;
  if (error && !(error instanceof ApiError && error.status === 404)) {
    return <FileMissing message={error.message} />;
  }
  if (error || (listing.data && !entry)) return <FileMissing />;
  const name = baseName(path);
  const folder = displayPath(parentOf(path) ?? FILES_ROOT);
  const url = fileContentUrl(path);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate font-semibold">{name}</h1>
          <p className="truncate text-muted-foreground text-xs">
            {[
              folder || t("files"),
              entry && formatBytes(entry.size, formatNumber),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Button asChild size="sm" variant="outline" className="h-8">
          <a href={fileContentUrl(path, true)} download>
            <Download className="size-3.5" />
            {t("download")}
          </a>
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-8 text-destructive"
          aria-label={t("deleteFileNamed", { name })}
          disabled={remove.isPending}
          onClick={() => {
            if (window.confirm(t("deleteFileConfirm", { name }))) {
              remove.mutate();
            }
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </header>
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-auto p-2 scrollbar-thin md:p-4",
          preview.kind === "image" && "items-center justify-center",
        )}
      >
        {!entry ? (
          <p className="text-muted-foreground text-sm">{t("loading")}</p>
        ) : preview.kind === "image" ? (
          <img
            src={url}
            alt={name}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        ) : preview.kind === "audio" ? (
          // biome-ignore lint/a11y/useMediaCaption: the person's own recording, with no captions to give.
          <audio src={url} controls className="w-full max-w-xl" />
        ) : preview.kind === "video" ? (
          // biome-ignore lint/a11y/useMediaCaption: the person's own video, with no captions to give.
          <video src={url} controls className="max-h-full max-w-full" />
        ) : !showText ? (
          <p className="m-auto text-muted-foreground text-sm">
            {t("noFilePreview")}
          </p>
        ) : content.data === undefined ? (
          <p className="text-muted-foreground text-sm">{t("loading")}</p>
        ) : preview.kind === "markdown" ? (
          <div className="mx-auto w-full max-w-3xl px-2 py-1">
            <Markdown text={content.data} untrusted />
          </div>
        ) : (
          <CodeBlock
            code={content.data}
            language={
              preview.kind === "code"
                ? preview.language
                : ("text" as BundledLanguage)
            }
          />
        )}
      </div>
    </main>
  );
}
