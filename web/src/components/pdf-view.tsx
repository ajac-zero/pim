import { useEffect, useRef, useState } from "react";
import { useI18n } from "~/components/i18n";

/** The widest a page is drawn, in CSS pixels. */
const MAX_PAGE_WIDTH = 900;

/**
 * A PDF's pages, drawn on canvases the width of the space they have. The
 * browser's own viewer isn't used: the file is served sandboxed (see
 * `fileHeaders`), which keeps it from opening.
 */
export function PdfView({ url, name }: { url: string; name: string }) {
  const { t } = useI18n();
  const pages = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

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
          const width = Math.min(container.clientWidth, MAX_PAGE_WIDTH);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({
            scale: (width / base.width) * window.devicePixelRatio,
          });
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${width}px`;
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
  }, [url, name]);

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
      <div
        ref={pages}
        className="mx-auto flex w-full max-w-[900px] flex-col items-center gap-3"
      />
    </>
  );
}
