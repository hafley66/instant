import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyText } from "./0_copyText";
import "./0_diagramLightbox.css";

type SvgBox = { x: number; y: number; width: number; height: number };

function sourceBox(svg: SVGSVGElement): SvgBox {
  const parts = svg.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (parts?.length === 4 && parts.every(Number.isFinite)) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return { x: 0, y: 0, width: svg.width.baseVal.value || 1, height: svg.height.baseVal.value || 1 };
}

function VectorDiagramViewport({ svg, toolbarStart }: { svg: string; toolbarStart: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const original = useRef<SvgBox>({ x: 0, y: 0, width: 1, height: 1 });
  const current = useRef<SvgBox>(original.current);
  const drag = useRef<{ pointerId: number; x: number; y: number; box: SvgBox } | null>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);

  const write = (box: SvgBox) => {
    current.current = box;
    host.current?.querySelector("svg")?.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(original.current.width / box.width * 100)}%`;
  };
  const setZoom = (next: number) => {
    const value = Math.min(64, Math.max(0.1, next));
    const box = current.current;
    const width = original.current.width / value;
    const height = original.current.height / value;
    write({ x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height });
  };

  useEffect(() => {
    const root = host.current;
    const element = root?.querySelector("svg");
    if (!root || !element) return;
    original.current = sourceBox(element);
    write(original.current);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        setZoom(original.current.width / current.current.width * Math.exp(-event.deltaY * 0.01));
        return;
      }
      const box = current.current;
      write({
        ...box,
        x: box.x + event.deltaX * box.width / Math.max(1, root.clientWidth),
        y: box.y + event.deltaY * box.height / Math.max(1, root.clientHeight),
      });
    };
    root.addEventListener("wheel", wheel, { passive: false });
    return () => root.removeEventListener("wheel", wheel);
  }, [svg]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, box: current.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    const root = host.current;
    if (!active || active.pointerId !== event.pointerId || !root) return;
    write({
      ...active.box,
      x: active.box.x - (event.clientX - active.x) * active.box.width / Math.max(1, root.clientWidth),
      y: active.box.y - (event.clientY - active.y) * active.box.height / Math.max(1, root.clientHeight),
    });
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div className="diagram-vector-viewport">
      <div className="file-image-tools">
        {toolbarStart}
        <button type="button" title="zoom out" onClick={() => setZoom(original.current.width / current.current.width / 1.2)}>−</button>
        <button type="button" title="fit the complete SVG" onClick={() => write(original.current)}>Fit</button>
        <span ref={zoomLabel}>100%</span>
        <button type="button" title="zoom in" onClick={() => setZoom(original.current.width / current.current.width * 1.2)}>+</button>
      </div>
      <div ref={host} className="diagram-vector-stage" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd} dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

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
      <div className="diagram-lightbox-vector" onClick={(event) => event.stopPropagation()}>
        <VectorDiagramViewport
          key={active.id}
          svg={active.svg}
          toolbarStart={(
            <>
              <button type="button" title="Previous clicked diagram" disabled={activeIndex === 0} onClick={() => select(activeIndex - 1)}>←</button>
              <span className="diagram-lightbox-count">{activeIndex + 1}/{entries.length}</span>
              <button type="button" title="Next clicked diagram" disabled={activeIndex === entries.length - 1} onClick={() => select(activeIndex + 1)}>→</button>
              <button type="button" title="Copy diagram source" onClick={() => void copySource()}>{copied ? "Copied" : "Copy"}</button>
              <button type="button" title="Close" onClick={onClose}>×</button>
            </>
          )}
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
