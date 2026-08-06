import { openPath } from "@tauri-apps/plugin-opener";
import { PanZoomViewport } from "./0_PanZoomViewport";
import { SvgDocumentViewer } from "./1_SvgDocumentViewer";
import { PdfDocumentViewer } from "./1_PdfDocumentViewer";

export function FileImageViewer({
  path,
  url,
  svg,
  pdf,
  onOpenHref,
}: {
  path: string;
  url?: string;
  svg?: string;
  pdf?: string;
  onOpenHref?: (href: string) => void | Promise<void>;
}) {
  if (pdf) return <PdfDocumentViewer path={path} url={pdf} onOpenHref={onOpenHref} />;
  if (svg) return <SvgDocumentViewer path={path} source={svg} onOpenHref={onOpenHref} />;
  return (
    <PanZoomViewport
      className="file-image-viewer"
      controls={({ zoom, zoomIn, zoomOut, reset }) => (
        <div className="file-image-tools">
          <button type="button" onClick={zoomOut} title="zoom out">−</button>
          <button type="button" onClick={reset} title="fit image">Fit</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={zoomIn} title="zoom in">+</button>
          <button type="button" onClick={() => void openPath(path).catch(console.error)} title="open in the OS default app">↗ external</button>
        </div>
      )}
    >
      <img className="fs-preview-img" src={url} alt={path.split("/").pop() ?? path} draggable={false} />
    </PanZoomViewport>
  );
}
