import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";

/** The widest a page is drawn, in CSS pixels. */
const MAX_PAGE_WIDTH = 900;

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

export const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));

/**
 * A PDF's pages, drawn on canvases the width of the space they have. The
 * browser's own viewer isn't used: the file is served sandboxed (see
 * `fileHeaders`), which keeps it from opening.
 */
export function PdfView({
  url,
  name,
  zoom,
  onZoom,
}: {
  url: string;
  name: string;
  zoom: number;
  onZoom: (update: (current: number) => number) => void;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);

  // Pinching a trackpad or turning the wheel with Ctrl held zooms the pages
  // instead of the whole browser page.
  useEffect(() => {
    const container = pages.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      onZoom((current) => clampZoom(current * Math.exp(-event.deltaY / 100)));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [onZoom]);

  // The file is fetched and parsed once per url; zooming only redraws.
  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | undefined;
    setState("loading");
    setDocument(null);
    pages.current?.replaceChildren();
    const load = async () => {
      const [pdfjs, worker] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      task = pdfjs.getDocument({
        data: new Uint8Array(await response.arrayBuffer()),
      });
      const loaded = await task.promise;
      if (!cancelled) setDocument(loaded);
    };
    load().catch(() => {
      if (!cancelled) setState("failed");
    });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url]);

  // Each page is redrawn off screen and swapped in when ready, so the pages
  // already shown stay put (resized to the new zoom at once) instead of
  // disappearing while they render again.
  useEffect(() => {
    const container = pages.current;
    if (!container || !document) return;
    let cancelled = false;
    const width =
      Math.min(frame.current?.clientWidth ?? 0, MAX_PAGE_WIDTH) * zoom;
    for (const existing of container.children) {
      (existing as HTMLElement).style.width = `${width}px`;
    }
    const draw = async () => {
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({
          scale: (width / base.width) * window.devicePixelRatio,
        });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${width}px`;
        canvas.style.maxWidth = "none";
        canvas.className = "rounded bg-white shadow-sm";
        canvas.setAttribute("role", "img");
        canvas.setAttribute(
          "aria-label",
          `${name}, ${number}/${document.numPages}`,
        );
        await page.render({ canvas, viewport }).promise;
        if (cancelled) return;
        const old = container.children[number - 1];
        if (old) old.replaceWith(canvas);
        else container.append(canvas);
        if (number === 1) setState("ready");
      }
    };
    draw().catch(() => {
      if (!cancelled) setState("failed");
    });
    return () => {
      cancelled = true;
    };
  }, [document, name, zoom]);

  return (
    <>
      {state === "loading" && (
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      )}
      {state === "failed" && (
        <p className="m-auto text-muted-foreground text-sm">
          {t("noFilePreview")}
        </p>
      )}
      <div ref={frame} className="mx-auto w-full max-w-[900px] shrink-0">
        {/* Zoomed pages are wider than the frame; this grows to hold them so the whole width can be scrolled to. */}
        <div
          ref={pages}
          className="flex w-max min-w-full flex-col items-center gap-3"
        />
      </div>
    </>
  );
}

/** Zoom buttons for a PDF, kept in the file's header. */
export function PdfZoomControls({
  zoom,
  onZoom,
}: {
  zoom: number;
  onZoom: (update: (current: number) => number) => void;
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
        disabled={zoom <= MIN_ZOOM}
        onClick={() => onZoom((current) => clampZoom(current - 0.25))}
      >
        −
      </Button>
      <button
        type="button"
        className="min-w-12 text-center text-muted-foreground tabular-nums"
        onClick={() => onZoom(() => 1)}
      >
        {Math.round(zoom * 100)}%
      </button>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t("zoomIn")}
        title={t("zoomIn")}
        disabled={zoom >= MAX_ZOOM}
        onClick={() => onZoom((current) => clampZoom(current + 0.25))}
      >
        +
      </Button>
    </div>
  );
}
