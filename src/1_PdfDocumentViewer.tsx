import { useEffect, useRef, useState } from "react";
import type { PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import type { PDFDocumentLoadingTask } from "pdfjs-dist/types/src/pdf.d.ts";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { openExternal } from "./0_openExternal";

function dataUrlBytes(url: string): Uint8Array {
  const encoded = url.slice(url.indexOf(",") + 1);
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

export function PdfDocumentViewer({
  path,
  url,
  onOpenHref,
}: {
  path: string;
  url: string;
  onOpenHref?: (href: string) => void | Promise<void>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const pages = useRef<HTMLDivElement>(null);
  const viewer = useRef<PDFViewer | null>(null);
  const [status, setStatus] = useState("loading PDF.js…");
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const containerElement = container.current;
    const pagesElement = pages.current;
    if (!containerElement || !pagesElement) return;
    let disposed = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let instance: PDFViewer | null = null;

    void import("pdfjs-dist/build/pdf.mjs").then(async (pdfjs) => {
      if (disposed) return;
      (globalThis as typeof globalThis & { pdfjsLib: typeof pdfjs }).pdfjsLib = pdfjs;
      const [web] = await Promise.all([
        import("pdfjs-dist/web/pdf_viewer.mjs"),
        import("pdfjs-dist/web/pdf_viewer.css"),
      ]);
      if (disposed) return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      const eventBus = new web.EventBus();
      const linkService = new web.PDFLinkService({ eventBus, externalLinkTarget: web.LinkTarget.BLANK });
      instance = new web.PDFViewer({
        container: containerElement,
        viewer: pagesElement,
        eventBus,
        linkService,
        textLayerMode: 1,
        removePageBorders: false,
      });
      viewer.current = instance;
      linkService.setViewer(instance);
      eventBus.on("pagesinit", () => {
        if (!instance || disposed) return;
        instance.currentScaleValue = "page-width";
        setZoom(instance.currentScale);
      });
      eventBus.on("scalechanging", ({ scale }: { scale: number }) => setZoom(scale));

      const task = pdfjs.getDocument({ data: dataUrlBytes(url) });
      loadingTask = task;
      const loaded = await task.promise;
      if (disposed) return;
      linkService.setDocument(loaded);
      instance.setDocument(loaded);
      setStatus(`${loaded.numPages} pages`);
    }).catch((error) => {
      console.error(error);
      if (!disposed) setStatus(String(error));
    });

    return () => {
      disposed = true;
      viewer.current = null;
      instance?.cleanup();
      void loadingTask?.destroy();
    };
  }, [url]);

  const zoomBy = (factor: number) => {
    const current = viewer.current;
    if (current) current.currentScale = current.currentScale * factor;
  };

  return (
    <div className="pdf-document-viewer">
      <div className="file-image-tools">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} title="zoom out">−</button>
        <button
          type="button"
          onClick={() => {
            if (viewer.current) viewer.current.currentScaleValue = "page-width";
          }}
          title="fit page width"
        >
          Width
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => zoomBy(1.2)} title="zoom in">+</button>
        <span>{status}</span>
        <button type="button" onClick={() => void openExternal(path).catch(console.error)} title="open in the OS default app">
          ↗ external
        </button>
      </div>
      <div
        ref={container}
        className="pdf-document-container"
        tabIndex={0}
        onClickCapture={(event) => {
          if (!onOpenHref) return;
          const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
          const href = anchor?.getAttribute("href");
          if (!href || href.startsWith("#")) return;
          event.preventDefault();
          event.stopPropagation();
          void Promise.resolve(onOpenHref(href)).catch(console.error);
        }}
      >
        <div ref={pages} className="pdfViewer" />
      </div>
    </div>
  );
}
