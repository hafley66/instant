import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
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
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);

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

  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const select = (index: number) => {
    reset();
    setCopied(false);
    onSelect(index);
  };

  const copySource = async () => {
    await copyText(active.code);
    setCopied(true);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setPan({ x: active.panX + event.clientX - active.x, y: active.panY + event.clientY - active.y });
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    setZoom((current) => Math.min(8, Math.max(0.25, current * (event.deltaY < 0 ? 1.12 : 1 / 1.12))));
  };

  return createPortal(
    <div className="diagram-lightbox" data-language={active.language} data-diagram-theme={active.dark ? "dark" : "light"} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className="diagram-lightbox-tools" onClick={(event) => event.stopPropagation()}>
        <button type="button" title="Previous clicked diagram" disabled={activeIndex === 0} onClick={() => select(activeIndex - 1)}>←</button>
        <span className="diagram-lightbox-count">{activeIndex + 1}/{entries.length}</span>
        <button type="button" title="Next clicked diagram" disabled={activeIndex === entries.length - 1} onClick={() => select(activeIndex + 1)}>→</button>
        <button type="button" title="Zoom out" onClick={() => setZoom((current) => Math.max(0.25, current / 1.2))}>−</button>
        <button type="button" title="Reset zoom and pan" onClick={reset}>Reset</button>
        <button type="button" title="Zoom in" onClick={() => setZoom((current) => Math.min(8, current * 1.2))}>+</button>
        <button type="button" title="Copy diagram source" onClick={() => void copySource()}>{copied ? "Copied" : "Copy"}</button>
        <button type="button" title="Close" onClick={onClose}>×</button>
      </div>
      <div
        className="diagram-lightbox-stage"
        role="presentation"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onWheel={onWheel}
      >
        <div
          className="diagram-lightbox-canvas"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          dangerouslySetInnerHTML={{ __html: diagramSvgMarkup(active.svg) }}
        />
      </div>
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
