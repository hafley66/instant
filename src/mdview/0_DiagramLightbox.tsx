import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import "./0_diagramLightbox.css";

export function diagramSvgMarkup(svg: string): string {
  return svg;
}

export function DiagramLightbox({
  svg,
  label,
  language,
  dark,
  onClose,
}: {
  svg: string;
  label: string;
  language: "mermaid" | "d2";
  dark: boolean;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
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
    <div className="diagram-lightbox" data-language={language} data-diagram-theme={dark ? "dark" : "light"} role="dialog" aria-modal="true" aria-label={label} onClick={onClose}>
      <div className="diagram-lightbox-tools" onClick={(event) => event.stopPropagation()}>
        <button type="button" title="Zoom out" onClick={() => setZoom((current) => Math.max(0.25, current / 1.2))}>−</button>
        <button type="button" title="Reset zoom and pan" onClick={reset}>Reset</button>
        <button type="button" title="Zoom in" onClick={() => setZoom((current) => Math.min(8, current * 1.2))}>+</button>
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
          dangerouslySetInnerHTML={{ __html: diagramSvgMarkup(svg) }}
        />
      </div>
    </div>,
    document.body,
  );
}
