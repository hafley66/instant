import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { clampPanZoom, pinchPanZoom, wheelZooms } from "./0_PanZoomViewport";
import { sanitizeSvgDocument } from "./0_svgSanitize";
import { panSvgBox, svgBoxAtZoom, svgNativeBox, svgSourceBox, type SvgBox } from "./0_svgViewport";
import { openExternalUrl } from "./0_openExternal";

export function SvgDocumentViewer({
  path,
  source,
  onOpenHref = openExternalUrl,
}: {
  path: string;
  source: string;
  onOpenHref?: (href: string) => void | Promise<void>;
}) {
  const clean = useMemo(() => sanitizeSvgDocument(source), [source]);
  const original = useMemo(() => svgSourceBox(clean) ?? { x: 0, y: 0, width: 1, height: 1 }, [clean]);
  const url = useMemo(() => URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" })), [clean]);
  const object = useRef<HTMLObjectElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; box: SvgBox; href: string | null; moved: boolean } | null>(null);
  const [viewport, setViewport] = useState({ width: 1, height: 1 });
  const native = useMemo(() => svgNativeBox(original, viewport.width, viewport.height), [original, viewport]);
  const [box, setBox] = useState<SvgBox | null>(null);
  const visibleBox = box ?? native;
  const zoom = native.width / visibleBox.width;

  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => setBox(null), [original]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const root = object.current?.contentDocument?.documentElement;
    root?.setAttribute("viewBox", `${visibleBox.x} ${visibleBox.y} ${visibleBox.width} ${visibleBox.height}`);
  }, [visibleBox, url]);

  const setZoom = (next: number, focusX = 0.5, focusY = 0.5) =>
    setBox((current) => svgBoxAtZoom(native, current ?? native, next, focusX, focusY));
  const anchorAt = (clientX: number, clientY: number): string | null => {
    const element = object.current;
    const document = element?.contentDocument;
    if (!element || !document) return null;
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(clientX - rect.left, clientY - rect.top)?.closest("a");
    return target?.getAttribute("href") ?? target?.getAttribute("xlink:href") ?? null;
  };
  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    if (wheelZooms(event.ctrlKey, event.metaKey)) {
      const rect = event.currentTarget.getBoundingClientRect();
      setZoom(
        pinchPanZoom(zoom, event.deltaY),
        (event.clientX - rect.left) / Math.max(1, rect.width),
        (event.clientY - rect.top) / Math.max(1, rect.height),
      );
      return;
    }
    const deltaX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    const deltaY = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
    const viewportWidth = event.currentTarget.clientWidth;
    const viewportHeight = event.currentTarget.clientHeight;
    setBox((current) => panSvgBox(current ?? native, deltaX, deltaY, viewportWidth, viewportHeight));
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      box: visibleBox,
      href: anchorAt(event.clientX, event.clientY),
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    const el = stage.current;
    if (!active || active.pointerId !== event.pointerId || !el) {
      if (el) el.style.cursor = anchorAt(event.clientX, event.clientY) ? "pointer" : "grab";
      return;
    }
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 4) active.moved = true;
    setBox(panSvgBox(active.box, active.x - event.clientX, active.y - event.clientY, el.clientWidth, el.clientHeight));
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const active = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.href && !active.moved) void Promise.resolve(onOpenHref(active.href)).catch(console.error);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.metaKey || !event.shiftKey) return;
    if (event.key === "+" || event.key === "=") setZoom(zoom * 1.2);
    else if (event.key === "-" || event.key === "_") setZoom(zoom / 1.2);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className="svg-document-viewer">
      <div className="file-image-tools">
        <button type="button" onClick={() => setZoom(clampPanZoom(zoom / 1.2))} title="zoom out">−</button>
        <button type="button" onClick={() => setBox(null)} title="show one SVG unit per screen pixel">100%</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" onClick={() => setZoom(clampPanZoom(zoom * 1.2))} title="zoom in">+</button>
        <button type="button" onClick={() => setBox(original)} title="fit the complete SVG">Fit</button>
        <button type="button" onClick={() => void openPath(path).catch(console.error)} title="open in the OS default app">↗ external</button>
      </div>
      <div
        ref={stage}
        className="svg-document-stage"
        role="presentation"
        tabIndex={0}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <object
          ref={object}
          data={url}
          type="image/svg+xml"
          aria-label={path}
          onLoad={() => {
            const root = object.current?.contentDocument?.documentElement;
            root?.setAttribute("viewBox", `${visibleBox.x} ${visibleBox.y} ${visibleBox.width} ${visibleBox.height}`);
          }}
        />
      </div>
    </div>
  );
}
