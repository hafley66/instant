import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { createPortal } from "react-dom";
import mermaid from "mermaid";

let nextDiagramId = 0;

export function MermaidDiagram({ code, dark }: { code: string; dark: boolean }) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    let disposed = false;
    const id = `instant-mermaid-${nextDiagramId++}`;
    mermaid.initialize({
      startOnLoad: false,
      theme: dark ? "dark" : "default",
      fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Arial, sans-serif",
      securityLevel: "strict",
      suppressErrorRendering: true,
    });
    void mermaid.render(id, code)
      .then(({ svg: rendered }) => {
        if (!disposed) {
          setError("");
          setSvg(rendered);
        }
      })
      .catch((reason: unknown) => {
        if (!disposed) {
          setSvg("");
          setError(reason instanceof Error ? reason.message : "Failed to render Mermaid diagram");
        }
      });
    return () => {
      disposed = true;
    };
  }, [code, dark]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

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

  if (error) return <pre className="mdview-mermaid-error">{error}</pre>;

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className="mdview-mermaid"
        title="Open diagram"
        onClick={() => setOpen(true)}
        onKeyDown={(event: ReactKeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {open && createPortal(
        <div className="mdview-mermaid-lightbox" role="dialog" aria-modal="true" aria-label="Mermaid diagram" onClick={() => setOpen(false)}>
          <div className="mdview-mermaid-lightbox-tools" onClick={(event) => event.stopPropagation()}>
            <button type="button" title="Zoom out" onClick={() => setZoom((current) => Math.max(0.25, current / 1.2))}>−</button>
            <button type="button" title="Reset zoom and pan" onClick={reset}>Reset</button>
            <button type="button" title="Zoom in" onClick={() => setZoom((current) => Math.min(8, current * 1.2))}>+</button>
            <button type="button" title="Close" onClick={() => setOpen(false)}>×</button>
          </div>
          <div
            className="mdview-mermaid-lightbox-stage"
            role="presentation"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onWheel={onWheel}
          >
            <div
              className="mdview-mermaid-lightbox-canvas"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
