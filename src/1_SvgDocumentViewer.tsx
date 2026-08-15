import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { clampPanZoom, pinchPanZoom, wheelZooms } from "./0_PanZoomViewport";
import { sanitizeSvgDocument } from "./0_svgSanitize";
import { panSvgBox, svgBoxAtZoom, svgNativeBox, svgSourceBox, type SvgBox } from "./0_svgViewport";
import { openExternalUrl } from "./0_openExternal";
import { useLiveProbeLifecycle, useLiveProbeRender } from "./1_LiveProbe";

export function SvgDocumentViewer({
  path,
  source,
  onOpenHref = openExternalUrl,
}: {
  path: string;
  source: string;
  onOpenHref?: (href: string) => void | Promise<void>;
}) {
  useLiveProbeRender("SvgDocumentViewer", path);
  useLiveProbeLifecycle("SvgDocumentViewer", path);
  const clean = useMemo(() => sanitizeSvgDocument(source), [source]);
  const original = useMemo(() => svgSourceBox(clean) ?? { x: 0, y: 0, width: 1, height: 1 }, [clean]);
  const url = useMemo(() => URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" })), [clean]);
  const object = useRef<HTMLObjectElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; box: SvgBox; href: string | null; moved: boolean } | null>(null);
  const native = useRef(original);
  const visibleBox = useRef(original);
  const followsNative = useRef(true);
  const pendingBox = useRef<SvgBox | null>(null);
  const frame = useRef<number | null>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);

  const writeBox = (next: SvgBox) => {
    visibleBox.current = next;
    const root = object.current?.contentDocument?.documentElement;
    root?.setAttribute("viewBox", `${next.x} ${next.y} ${next.width} ${next.height}`);
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(native.current.width / next.width * 100)}%`;
  };
  const flushBox = () => {
    frame.current = null;
    const next = pendingBox.current;
    pendingBox.current = null;
    if (next) writeBox(next);
  };
  const scheduleBox = (next: SvgBox) => {
    pendingBox.current = next;
    if (frame.current === null) frame.current = requestAnimationFrame(flushBox);
  };
  const currentBox = () => pendingBox.current ?? visibleBox.current;
  const resetNative = () => {
    const element = stage.current;
    if (!element) return;
    native.current = svgNativeBox(original, element.clientWidth, element.clientHeight);
    if (followsNative.current) writeBox(native.current);
  };

  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    followsNative.current = true;
    resetNative();
    const observer = new ResizeObserver(resetNative);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [original]);

  const setZoom = (next: number, focusX = 0.5, focusY = 0.5) => {
    followsNative.current = false;
    scheduleBox(svgBoxAtZoom(native.current, currentBox(), next, focusX, focusY));
  };
  const anchorAt = (clientX: number, clientY: number): string | null => {
    const element = object.current;
    const document = element?.contentDocument;
    if (!element || !document) return null;
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(clientX - rect.left, clientY - rect.top)?.closest("a");
    return target?.getAttribute("href") ?? target?.getAttribute("xlink:href") ?? null;
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLDivElement;
    target.focus({ preventScroll: true });
    if (wheelZooms(event.ctrlKey, event.metaKey)) {
      const rect = target.getBoundingClientRect();
      setZoom(
        pinchPanZoom(native.current.width / currentBox().width, event.deltaY),
        (event.clientX - rect.left) / Math.max(1, rect.width),
        (event.clientY - rect.top) / Math.max(1, rect.height),
      );
      return;
    }
    const deltaX = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    const deltaY = event.shiftKey && event.deltaX === 0 ? 0 : event.deltaY;
    const viewportWidth = target.clientWidth;
    const viewportHeight = target.clientHeight;
    followsNative.current = false;
    scheduleBox(panSvgBox(currentBox(), deltaX, deltaY, viewportWidth, viewportHeight));
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      box: currentBox(),
      href: anchorAt(event.clientX, event.clientY),
      moved: false,
    };
    (event.currentTarget as HTMLDivElement).setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    const active = drag.current;
    const el = stage.current;
    if (!active || active.pointerId !== event.pointerId || !el) {
      if (el) el.style.cursor = anchorAt(event.clientX, event.clientY) ? "pointer" : "grab";
      return;
    }
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 4) active.moved = true;
    followsNative.current = false;
    scheduleBox(panSvgBox(active.box, active.x - event.clientX, active.y - event.clientY, el.clientWidth, el.clientHeight));
  };
  const onPointerEnd = (event: PointerEvent) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    const active = drag.current;
    drag.current = null;
    (event.currentTarget as HTMLDivElement).releasePointerCapture(event.pointerId);
    if (active.href && !active.moved) void Promise.resolve(onOpenHref(active.href)).catch(console.error);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.metaKey || !event.shiftKey) return;
    const zoom = native.current.width / currentBox().width;
    if (event.key === "+" || event.key === "=") setZoom(zoom * 1.2);
    else if (event.key === "-" || event.key === "_") setZoom(zoom / 1.2);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerEnd);
    element.addEventListener("pointercancel", onPointerEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
    };
  });

  return (
    <div className="svg-document-viewer">
      <div className="file-image-tools">
        <button type="button" onClick={() => setZoom(clampPanZoom(native.current.width / currentBox().width / 1.2))} title="zoom out">−</button>
        <button type="button" onClick={() => { followsNative.current = true; scheduleBox(native.current); }} title="show one SVG unit per screen pixel">100%</button>
        <span ref={zoomLabel}>100%</span>
        <button type="button" onClick={() => setZoom(clampPanZoom(native.current.width / currentBox().width * 1.2))} title="zoom in">+</button>
        <button type="button" onClick={() => { followsNative.current = false; scheduleBox(original); }} title="fit the complete SVG">Fit</button>
        <button type="button" onClick={() => void openPath(path).catch(console.error)} title="open in the OS default app">↗ external</button>
      </div>
      <div
        ref={stage}
        className="svg-document-stage"
        role="presentation"
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <object
          ref={object}
          data={url}
          type="image/svg+xml"
          aria-label={path}
          onLoad={() => {
            const root = object.current?.contentDocument?.documentElement;
            root?.setAttribute("viewBox", `${currentBox().x} ${currentBox().y} ${currentBox().width} ${currentBox().height}`);
          }}
        />
      </div>
    </div>
  );
}
