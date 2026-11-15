import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { lazy, type ReactNode, Suspense, useRef, useState } from "react";
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
import { useStoredSize } from "~/components/ui/resize-handle";
import type { FileSession, SessionStatus } from "~/lib/file-session";
import {
  clampEditorFontSize,
  defaultEditorFontSize,
  EDITOR_FONT_SIZE_KEY,
  EDITOR_FONT_STEP,
  MAX_EDITOR_FONT_SIZE,
  MAX_VIEWABLE_BYTES,
  MIN_EDITOR_FONT_SIZE,
} from "~/lib/file-text";
import { baseName, parentOf, previewOf } from "~/lib/files";
import { ApiError, FILES_ROOT, fileContentUrl, pim } from "~/lib/pim-api";
import { computerQuery, filesQuery } from "~/lib/queries";
import { useFileSession } from "~/lib/use-file-session";
import { cn } from "~/lib/utils";

// CodeMirror is its own chunk, fetched when a text file first opens.
const FileEditor = lazy(() => import("~/components/file-editor"));

/** The code editor's font size, kept in this browser and shared by every open file. */
function useEditorFontSize(): [number, (next: number | null) => void] {
  const [stored, store] = useStoredSize(
    EDITOR_FONT_SIZE_KEY,
    defaultEditorFontSize(),
  );
  return [
    clampEditorFontSize(stored),
    (next) => store(next === null ? null : clampEditorFontSize(next)),
  ];
}

/** Font size buttons for the code editor, kept in the file's header. */
function EditorFontControls({
  fontSize,
  onChange,
}: {
  fontSize: number;
  onChange: (next: number | null) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center gap-1 text-sm">
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t("zoomOut")}
        title={t("zoomOut")}
        disabled={fontSize <= MIN_EDITOR_FONT_SIZE}
        onClick={() => onChange(fontSize - EDITOR_FONT_STEP)}
      >
        −
      </Button>
      <button
        type="button"
        className="min-w-10 text-center text-muted-foreground tabular-nums"
        onClick={() => onChange(null)}
      >
        {fontSize}px
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t("zoomIn")}
        title={t("zoomIn")}
        disabled={fontSize >= MAX_EDITOR_FONT_SIZE}
        onClick={() => onChange(fontSize + EDITOR_FONT_STEP)}
      >
        +
      </Button>
    </div>
  );
}

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

const STATUS_LABELS = {
  clean: "fileStatusClean",
  dirty: "fileStatusDirty",
  saving: "fileStatusSaving",
  saved: "fileStatusSaved",
  conflict: "fileStatusConflict",
  error: "fileStatusError",
  readonly: "fileStatusReadOnly",
} as const;

/** Whether the file's edits are safe: clean, unsaved, being saved, saved, in conflict, failed, or not editable. */
function SaveStatus({ status }: { status: SessionStatus }) {
  const { t } = useI18n();
  if (status === "loading") return null;
  return (
    <span
      role="status"
      data-status={status}
      className={cn(
        "shrink-0 text-muted-foreground text-xs",
        (status === "conflict" || status === "error") && "text-destructive",
      )}
    >
      {t(STATUS_LABELS[status])}
    </span>
  );
}

/** Files live on the person's computer: without one there is nothing to open, and the way to get one is shown instead of an error. */
function NoComputer({ onClose }: { onClose?: () => void }) {
  const { t } = useI18n();
  return (
    <main className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-muted-foreground">{t("fileNoComputer")}</p>
      <Button asChild>
        <Link
          to="."
          search={(prev) => ({ ...prev, dialog: "settings", tab: "computer" })}
        >
          {t("connectComputer")}
        </Link>
      </Button>
      {onClose && (
        <Button variant="outline" onClick={onClose}>
          {t("close")}
        </Button>
      )}
    </main>
  );
}

/** The file changed on disk where it was being edited: the buffer is kept, and the person picks what happens. */
export function ConflictBanner({ session }: { session: FileSession }) {
  const { t } = useI18n();
  const { disk } = session.getState();
  const deleted = disk !== null && disk.hash === null;
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => {
    setBusy(true);
    action()
      .catch((failure: Error) => toast.error(failure.message))
      .finally(() => setBusy(false));
  };
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 border-b bg-muted px-4 py-2 text-sm"
    >
      <p className="basis-full">
        {t(deleted ? "fileConflictDeleted" : "fileConflict")}
      </p>
      {disk?.text != null && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => session.markConflicts()}
        >
          {t("fileMarkConflicts")}
        </Button>
      )}
      {!deleted && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => run(() => session.reloadFromDisk())}
        >
          {t("fileReloadFromDisk")}
        </Button>
      )}
      <Button
        size="sm"
        disabled={busy}
        onClick={() => run(() => session.overwrite())}
      >
        {t("fileOverwrite")}
      </Button>
    </div>
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
  // Markdown opens rendered; "Edit" swaps in the editor, over the same session, so the buffer survives toggling.
  const [editing, setEditing] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fontSize, setFontSize] = useEditorFontSize();
  const [page, setPage] = useState(() => savedPdfPage(path));
  const [pageCount, setPageCount] = useState(0);
  const turnPage = (next: number) => {
    setPage(next);
    savePdfPage(path, next);
  };
  const preview = previewOf(baseName(path));
  const textual = ["markdown", "code", "text", "none"].includes(preview.kind);
  // The folder's listing says whether the file is there, and its size.
  const listing = useQuery(filesQuery(parentOf(path) ?? FILES_ROOT));
  const entry = listing.data?.entries.find(
    (candidate) => candidate.path === path && candidate.type === "file",
  );
  // A file deleted under unsaved typing stays open, so the typing isn't lost with it.
  const keep = useRef(false);
  const { load, state } = useFileSession(
    path,
    textual && ((!!entry && entry.size <= MAX_VIEWABLE_BYTES) || keep.current),
  );
  keep.current = load.phase === "ready" && state.status === "conflict";
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

  const computer = useQuery(computerQuery());
  if (computer.data?.state === "none") return <NoComputer onClose={onClose} />;
  const error =
    listing.error ?? (load.phase === "failed" ? new Error(load.message) : null);
  if (load.phase === "missing") return <FileMissing onClose={onClose} />;
  if (error && !(error instanceof ApiError && error.status === 404)) {
    return <FileMissing message={error.message} onClose={onClose} />;
  }
  if (error || (listing.data && !entry && !keep.current))
    return <FileMissing onClose={onClose} />;
  const name = baseName(path);
  const showEditor = preview.kind !== "markdown" || editing === path;
  const url = fileContentUrl(path);

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <header
        className={cn("flex items-center gap-2 border-b px-4", !tabs && "py-2")}
      >
        {tabs ?? (
          <h1 className="min-w-0 flex-1 truncate font-semibold">{name}</h1>
        )}
        {load.phase === "ready" && <SaveStatus status={state.status} />}
        {load.phase === "ready" && preview.kind === "markdown" && (
          <div
            role="group"
            aria-label={name}
            className="flex shrink-0 rounded-md border p-0.5 text-xs"
          >
            {[false, true].map((edit) => (
              <button
                key={String(edit)}
                type="button"
                aria-pressed={showEditor === edit}
                className={cn(
                  "rounded px-2 py-0.5",
                  showEditor === edit
                    ? "bg-muted font-medium"
                    : "text-muted-foreground",
                )}
                onClick={() => setEditing(edit ? path : null)}
              >
                {t(edit ? "fileEdit" : "filePreview")}
              </button>
            ))}
          </div>
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
        {load.phase === "ready" && textual && showEditor && (
          <EditorFontControls fontSize={fontSize} onChange={setFontSize} />
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
      {load.phase === "ready" && state.status === "conflict" && (
        <ConflictBanner session={load.session} />
      )}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-auto p-2 scrollbar-thin md:p-4",
          preview.kind === "image" && "items-center justify-center",
        )}
      >
        {!entry && !keep.current ? (
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
            version={entry?.updatedAt}
            zoom={zoom}
            onZoom={setZoom}
            page={page}
            onPage={turnPage}
            onPages={setPageCount}
          />
        ) : load.phase === "refused" ||
          (textual && (entry?.size ?? 0) > MAX_VIEWABLE_BYTES) ? (
          <p className="m-auto text-muted-foreground text-sm">
            {t("noFilePreview")}
          </p>
        ) : !textual ? (
          <p className="m-auto text-muted-foreground text-sm">
            {t("noFilePreview")}
          </p>
        ) : load.phase !== "ready" ? (
          <p className="text-muted-foreground text-sm">{t("loading")}</p>
        ) : !showEditor ? (
          <div className="mx-auto w-full max-w-3xl px-2 py-1">
            <Markdown text={load.session.text} untrusted />
          </div>
        ) : (
          <Suspense
            fallback={
              <p className="text-muted-foreground text-sm">{t("loading")}</p>
            }
          >
            <FileEditor
              session={load.session}
              name={name}
              readOnly={state.status === "readonly"}
              fontSize={fontSize}
              onFontSizeChange={setFontSize}
            />
          </Suspense>
        )}
      </div>
    </main>
  );
}
