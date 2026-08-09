import { openPath } from "@tauri-apps/plugin-opener";
import { PanZoomViewport } from "./0_PanZoomViewport";
import { SvgDocumentViewer } from "./1_SvgDocumentViewer";
import { PdfDocumentViewer } from "./1_PdfDocumentViewer";
import { LiveProbePanel, useLiveProbeLifecycle, useLiveProbeRender } from "./1_LiveProbe";
import { useRef } from "react";

export function FileImageViewer({
  path,
  url,
  svg,
  pdf,
  onOpenHref,
  probeRoot,
}: {
  path: string;
  url?: string;
  svg?: string;
  pdf?: string;
  onOpenHref?: (href: string) => void | Promise<void>;
  probeRoot?: HTMLElement;
}) {
  useLiveProbeRender("FileImageViewer", path, { kind: pdf ? "pdf" : svg ? "svg" : "image" });
  useLiveProbeLifecycle("FileImageViewer", path);
  const localRoot = useRef<HTMLDivElement>(null);
  const content = pdf
    ? <PdfDocumentViewer path={path} url={pdf} onOpenHref={onOpenHref} />
    : svg
      ? <SvgDocumentViewer path={path} source={svg} onOpenHref={onOpenHref} />
      : (
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
  return (
    <div className="file-media-with-probe" ref={localRoot}>
      <div className="file-media-content">{content}</div>
      <LiveProbePanel rootRef={localRoot} root={probeRoot} scope={path} />
    </div>
  );
}
