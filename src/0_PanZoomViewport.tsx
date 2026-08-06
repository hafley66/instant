import { useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import "./0_panZoomViewport.css";

export type PanZoomApi = {
  zoom: number;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
};

export function clampPanZoom(value: number): number {
  return Math.min(64, Math.max(0.1, value));
}

export function wheelPanZoom(current: number, deltaY: number): number {
  return clampPanZoom(current * (deltaY < 0 ? 1.12 : 1 / 1.12));
}

export function PanZoomViewport({
  children,
  controls,
  className = "",
}: {
  children: ReactNode;
  controls?: (api: PanZoomApi) => ReactNode;
  className?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };
  const api: PanZoomApi = {
    zoom,
    zoomIn: () => setZoom((current) => clampPanZoom(current * 1.2)),
    zoomOut: () => setZoom((current) => clampPanZoom(current / 1.2)),
    reset,
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
    setZoom((current) => wheelPanZoom(current, event.deltaY));
  };

  return (
    <div className={`panzoom-viewport ${className}`.trim()}>
      {controls?.(api)}
      <div
        className="panzoom-stage"
        role="presentation"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onWheel={onWheel}
      >
        <div className="panzoom-canvas" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
          {children}
        </div>
      </div>
    </div>
  );
}
