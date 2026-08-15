import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getMdviewHost } from "./ports";
import { copyText } from "./0_copyText";
import "./0_diagramLightbox.css";

export function diagramSvgMarkup(svg: string): string {
  return svg;
}

export type DiagramLightboxEntry = {
  id: string;
  svg: string;
  language: "mermaid" | "d2";
  dark: boolean;
  code: string;
  locator: string;
  bufferStart: number;
  bufferEnd: number;
  inferred: boolean;
};

type DiagramLightboxHistoryProps = {
  entries: DiagramLightboxEntry[];
  activeIndex: number;
  label: string;
  onSelect: (index: number) => void;
  onClose: () => void;
};

type DiagramLightboxSingleProps = {
  svg: string;
  label: string;
  language: "mermaid" | "d2";
  dark: boolean;
  onClose: () => void;
};

export function DiagramLightbox(props: DiagramLightboxHistoryProps | DiagramLightboxSingleProps) {
  const PanZoomViewport = getMdviewHost().PanZoomViewport;
  const entries = "entries" in props ? props.entries : [{
    id: "markdown-diagram",
    svg: props.svg,
    language: props.language,
    dark: props.dark,
    code: "",
    locator: "markdown preview",
    bufferStart: 0,
    bufferEnd: 0,
    inferred: false,
  }];
  const activeIndex = "activeIndex" in props ? props.activeIndex : 0;
  const onSelect = "onSelect" in props ? props.onSelect : () => {};
  const { label, onClose } = props;
  const active = entries[activeIndex];
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [onClose]);

  const select = (index: number) => {
    setCopied(false);
    onSelect(index);
  };

  const copySource = async () => {
    await copyText(active.code);
    setCopied(true);
  };

  return createPortal(
    <div className="diagram-lightbox" data-language={active.language} data-diagram-theme={active.dark ? "dark" : "light"} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <PanZoomViewport
        key={active.id}
        className="diagram-lightbox-viewport"
        controls={({ zoom, zoomIn, zoomOut, reset }) => (
          <div className="diagram-lightbox-tools" onClick={(event) => event.stopPropagation()}>
            <button type="button" title="Previous clicked diagram" disabled={activeIndex === 0} onClick={() => select(activeIndex - 1)}>←</button>
            <span className="diagram-lightbox-count">{activeIndex + 1}/{entries.length}</span>
            <button type="button" title="Next clicked diagram" disabled={activeIndex === entries.length - 1} onClick={() => select(activeIndex + 1)}>→</button>
            <button type="button" title="Zoom out" onClick={zoomOut}>−</button>
            <button type="button" title="Reset zoom and pan" onClick={reset}>Fit</button>
            <span className="diagram-lightbox-count">{Math.round(zoom * 100)}%</span>
            <button type="button" title="Zoom in" onClick={zoomIn}>+</button>
            <button type="button" title="Copy diagram source" onClick={() => void copySource()}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" title="Close" onClick={onClose}>×</button>
          </div>
        )}
      >
        <div className="diagram-lightbox-canvas" onClick={(event) => event.stopPropagation()} dangerouslySetInnerHTML={{ __html: diagramSvgMarkup(active.svg) }} />
      </PanZoomViewport>
      <details className="diagram-lightbox-debug" onClick={(event) => event.stopPropagation()}>
        <summary>Source and debug data</summary>
        <dl>
          <dt>Locator</dt><dd>{active.locator}</dd>
          <dt>Language</dt><dd>{active.language}</dd>
          <dt>Buffer rows</dt><dd>{active.bufferStart}–{active.bufferEnd}</dd>
          <dt>Detection</dt><dd>{active.inferred ? "inferred" : "fenced or ledger"}</dd>
        </dl>
        <pre>{active.code}</pre>
      </details>
    </div>,
    document.body,
  );
}
