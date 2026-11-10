import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { BundledLanguage } from "shiki";
import { toast } from "sonner";
import { Markdown } from "~/components/chat/markdown";
import { useI18n } from "~/components/i18n";
import { Download, Trash2, X } from "~/components/icons";
import {
  PdfPageControls,
  PdfView,
  PdfZoomControls,
  savedPdfPage,
  savePdfPage,
} from "~/components/pdf-view";
import { Button } from "~/components/ui/button";
import { CodeBlock } from "~/components/ui/code-block";
import { baseName, parentOf, previewOf } from "~/lib/files";
import { ApiError, FILES_ROOT, fileContentUrl, pim } from "~/lib/pim-api";
import { filesQuery } from "~/lib/queries";
import { cn } from "~/lib/utils";

/** The largest text file the page shows; bigger ones are for downloading. */
const MAX_TEXT_PREVIEW = 1_000_000;

export function FileMissing({
  message,
  onClose,
}: {
  message?: string;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-muted-foreground">{message ?? t("fileMissing")}</p>
      {onClose && (
        <Button variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
      )}
    </main>
  );
}

/** One of your files, shown as well as the app can, to read or download. */
export function FileView({
  path,
  tabs,
  onClose,
}: {
  path: string;
  /** The canvas's tabs, which take the place of this file's title. */
  tabs?: ReactNode;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [zoom, setZoom] = useState(1);
  const [page, setPage] = useState(() => savedPdfPage(path));
  const [pageCount, setPageCount] = useState(0);
  const turnPage = (next: number) => {
    setPage(next);
    savePdfPage(path, next);
  };
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
      if (onClose) onClose();
      else void navigate({ to: "/" });
    },
    onError: (failure) => toast.error(failure.message),
  });

  const error = listing.error ?? content.error;
  if (error && !(error instanceof ApiError && error.status === 404)) {
    return <FileMissing message={error.message} onClose={onClose} />;
  }
  if (error || (listing.data && !entry))
    return <FileMissing onClose={onClose} />;
  const name = baseName(path);
  const url = fileContentUrl(path);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header
        className={cn("flex items-center gap-2 border-b px-4", !tabs && "py-2")}
      >
        {tabs ?? (
          <h1 className="min-w-0 flex-1 truncate font-semibold">{name}</h1>
        )}
        {preview.kind === "pdf" && (
          <>
            <PdfPageControls
              page={page}
              pages={pageCount}
              onPage={(next) =>
                turnPage(Math.min(pageCount, Math.max(1, next)))
              }
            />
            <PdfZoomControls zoom={zoom} onZoom={setZoom} />
          </>
        )}
        <Button asChild size="icon" variant="ghost" className="size-8 shrink-0">
          <a
            href={fileContentUrl(path, true)}
            download
            aria-label={t("download")}
            title={t("download")}
          >
            <Download className="size-4" />
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
        {onClose && (
          <Button
            size="icon"
            variant="ghost"
            className="size-8 shrink-0"
            aria-label={t("close")}
            title={t("close")}
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        )}
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
        ) : preview.kind === "pdf" ? (
          <PdfView
            url={url}
            name={name}
            version={entry.updatedAt}
            zoom={zoom}
            onZoom={setZoom}
            page={page}
            onPage={turnPage}
            onPages={setPageCount}
          />
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
