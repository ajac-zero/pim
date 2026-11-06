import { useEffect, useRef, useState } from "react";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";

/** The widest a page is drawn, in CSS pixels. */
const MAX_PAGE_WIDTH = 900;

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

const clampZoom = (zoom: number) =>
  Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));

/**
 * A PDF's pages, drawn on canvases the width of the space they have. The
 * browser's own viewer isn't used: the file is served sandboxed (see
 * `fileHeaders`), which keeps it from opening.
 */
export function PdfView({ url, name }: { url: string; name: string }) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [zoom, setZoom] = useState(1);

  // Pinching a trackpad or turning the wheel with Ctrl held zooms the pages
  // instead of the whole browser page.
  useEffect(() => {
    const container = pages.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setZoom((current) => clampZoom(current * Math.exp(-event.deltaY / 100)));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const container = pages.current;
    if (!container) return;
    let cancelled = false;
    setState("loading");
    container.replaceChildren();

    const draw = async () => {
      const [pdfjs, worker] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      const task = pdfjs.getDocument({
        data: new Uint8Array(await response.arrayBuffer()),
      });
      const document = await task.promise;
      try {
        for (let number = 1; number <= document.numPages; number++) {
          const page = await document.getPage(number);
          if (cancelled) return;
          const width =
            Math.min(frame.current?.clientWidth ?? 0, MAX_PAGE_WIDTH) * zoom;
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
          container.append(canvas);
          await page.render({ canvas, viewport }).promise;
          if (number === 1) setState("ready");
        }
      } finally {
        void task.destroy();
      }
    };
    draw().catch(() => {
      if (!cancelled) setState("failed");
    });
    return () => {
      cancelled = true;
    };
  }, [url, name, zoom]);

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
      <div className="sticky top-0 z-10 mx-auto mb-2 shrink-0 flex items-center gap-1 rounded-lg border bg-background/90 p-1 text-sm backdrop-blur">
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("zoomOut")}
          title={t("zoomOut")}
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((current) => clampZoom(current - 0.25))}
        >
          −
        </Button>
        <button
          type="button"
          className="min-w-12 text-center text-muted-foreground tabular-nums"
          onClick={() => setZoom(1)}
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
          onClick={() => setZoom((current) => clampZoom(current + 0.25))}
        >
          +
        </Button>
      </div>
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
