import type { PDFDocumentProxy } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "~/components/i18n";
import { Button } from "~/components/ui/button";

/** The widest a page is drawn, in CSS pixels. */
const MAX_PAGE_WIDTH = 900;

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;

const pageKey = (path: string) => `pim.pdfPage:${path}`;

/** The page last read in a file, kept in this browser so it survives reloads. */
export function savedPdfPage(path: string) {
  try {
    const page = Number(localStorage.getItem(pageKey(path)));
    return Number.isInteger(page) && page >= 1 ? page : 1;
  } catch {
    return 1;
  }
}

export function savePdfPage(path: string, page: number) {
  try {
    localStorage.setItem(pageKey(path), String(page));
  } catch {}
}

/** How long a PDF stays loaded after its tab or chat is left, so coming back is instant. */
const KEEP_LOADED_MS = 10 * 60_000;

const loaded = new Map<
  string,
  { document: Promise<PDFDocumentProxy>; users: number; timer?: number }
>();

/**
 * The parsed PDF for `key`, loaded once and shared by whoever shows it. It is
 * let go a while after the last one stops, and not before, so switching to
 * another chat or tab and back doesn't fetch and parse the file again.
 */
function holdDocument(key: string, url: string) {
  let entry = loaded.get(key);
  if (!entry) {
    const document = (async () => {
      const [pdfjs, worker] = await Promise.all([
        import("pdfjs-dist"),
        import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const response = await fetch(url);
      if (!response.ok) throw new Error(String(response.status));
      return pdfjs.getDocument({
        data: new Uint8Array(await response.arrayBuffer()),
      }).promise;
    })();
    entry = { document, users: 0 };
    loaded.set(key, entry);
    // A failed load isn't kept, so the next try fetches again.
    document.catch(() => loaded.delete(key));
  }
  window.clearTimeout(entry.timer);
  entry.users++;
  const held = entry;
  return {
    document: held.document,
    release: () => {
      if (--held.users > 0) return;
      held.timer = window.setTimeout(() => {
        loaded.delete(key);
        void held.document
          .then((document) => document.loadingTask.destroy())
          .catch(() => {});
      }, KEEP_LOADED_MS);
    },
  };
}

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
  version,
  zoom,
  onZoom,
  page,
  onPage,
  onPages,
}: {
  url: string;
  name: string;
  /** Changes when the file does, so a newer version is loaded instead of the kept one. */
  version?: string;
  zoom: number;
  onZoom: (update: (current: number) => number) => void;
  /** The page being read: scrolled to when it changes, and updated as the reader scrolls. */
  page: number;
  onPage: (page: number) => void;
  onPages: (pages: number) => void;
}) {
  const { t } = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const wanted = useRef(page);
  const shown = useRef(0);
  const callbacks = useRef({ onPage, onPages });
  callbacks.current = { onPage, onPages };

  const scrollTo = useCallback((number: number) => {
    const target = pages.current?.children[number - 1];
    if (!target) return false;
    target.scrollIntoView({ block: "start" });
    shown.current = number;
    return true;
  }, []);

  // Moving to another page (the arrows, or the page last read when the file
  // opens) scrolls to it; scrolling by hand reports the page at the top.
  useEffect(() => {
    if (page === shown.current) return;
    wanted.current = page;
    scrollTo(page);
  }, [page, scrollTo]);

  useEffect(() => {
    const scroller = frame.current?.parentElement;
    const container = pages.current;
    if (!scroller || !container) return;
    const onScroll = () => {
      // Hidden (another tab is showing) or still scrolling to the saved page.
      if (scroller.clientHeight === 0 || wanted.current !== shown.current)
        return;
      const top = scroller.getBoundingClientRect().top + 20;
      let current = 1;
      for (let i = 0; i < container.children.length; i++) {
        const child = container.children[i];
        if (child && child.getBoundingClientRect().top <= top) current = i + 1;
      }
      if (container.children.length === 0 || current === shown.current) return;
      shown.current = wanted.current = current;
      callbacks.current.onPage(current);
    };
    // A tab that was hidden loses its scroll position, so it comes back to the page.
    let visible = scroller.clientHeight > 0;
    const observer = new ResizeObserver(() => {
      const now = scroller.clientHeight > 0;
      if (now && !visible) scrollTo(wanted.current);
      visible = now;
    });
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scrollTo]);

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

  // The file is fetched and parsed once per version; zooming only redraws.
  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setDocument(null);
    pages.current?.replaceChildren();
    shown.current = 0;
    const held = holdDocument(`${url}\n${version ?? ""}`, url);
    held.document
      .then((loaded) => {
        if (cancelled) return;
        callbacks.current.onPages(loaded.numPages);
        setDocument(loaded);
      })
      .catch(() => {
        if (!cancelled) setState("failed");
      });
    return () => {
      cancelled = true;
      held.release();
    };
  }, [url, version]);

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
        // The page last read is scrolled to once it has been drawn.
        if (number === wanted.current && shown.current !== number) {
          scrollTo(number);
        }
      }
    };
    draw().catch(() => {
      if (!cancelled) setState("failed");
    });
    return () => {
      cancelled = true;
    };
  }, [document, name, zoom, scrollTo]);

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

/** The current page and arrows to turn it, kept in the file's header. */
export function PdfPageControls({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  const { t } = useI18n();
  if (pages < 1) return null;
  return (
    <div className="flex shrink-0 items-center gap-1 text-sm">
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t("previousPage")}
        title={t("previousPage")}
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </Button>
      <span className="min-w-12 text-center text-muted-foreground tabular-nums">
        {page} / {pages}
      </span>
      <Button
        size="icon"
        variant="ghost"
        className="size-7"
        aria-label={t("nextPage")}
        title={t("nextPage")}
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        ›
      </Button>
    </div>
  );
}
