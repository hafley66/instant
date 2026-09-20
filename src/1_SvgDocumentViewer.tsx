import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { wheelZooms } from "./0_PanZoomViewport";
import { sanitizeSvgDocument } from "./0_svgSanitize";
import { panSvgBox, svgBoxAtZoom, svgCssTransform, svgFitBox, svgMinimumZoom, svgNeedsRepaint, svgPaintBox, svgNativeBox, svgSourceBox, type SvgBox } from "./0_svgViewport";
import { openExternal, openExternalUrl } from "./0_openExternal";
import { showError } from "./core";
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
  const [url, setUrl] = useState("");
  const object = useRef<HTMLObjectElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; box: SvgBox; href: string | null; moved: boolean } | null>(null);
  const native = useRef(original);
  const visibleBox = useRef(original);
  const followsNative = useRef(true);
  const pendingBox = useRef<SvgBox | null>(null);
  const frame = useRef<number | null>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const viewport = useRef({ width: 1, height: 1 });
  const hasLinks = useRef(false);
  const paintedBox = useRef<SvgBox | null>(null);
  const hoverFrame = useRef<number | null>(null);
  const hoverPoint = useRef({ x: 0, y: 0 });

  const writeBox = (next: SvgBox) => {
    visibleBox.current = next;
    const element = object.current;
    const root = element?.contentDocument?.documentElement;
    if (root && element) {
      if (!paintedBox.current || svgNeedsRepaint(paintedBox.current, next)) {
        paintedBox.current = svgPaintBox(next);
        const box = paintedBox.current;
        root.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
      }
      element.style.transform = svgCssTransform(paintedBox.current, next, viewport.current.width, viewport.current.height);
    }
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
    const width = element.clientWidth, height = element.clientHeight;
    if (width <= 0 || height <= 0) return;
    viewport.current = { width, height };
    paintedBox.current = null;
    if (object.current) {
      object.current.style.width = `${width * 3}px`;
      object.current.style.height = `${height * 3}px`;
    }
    native.current = svgNativeBox(original, viewport.current.width, viewport.current.height);
    const next = followsNative.current ? native.current : svgFitBox(currentBox(), width, height);
    pendingBox.current = null;
    writeBox(next);
  };

  useEffect(() => {
    const next = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [clean]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    followsNative.current = true;
    pendingBox.current = null;
    drag.current = null;
    resetNative();
    const observer = new ResizeObserver(resetNative);
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (hoverFrame.current !== null) cancelAnimationFrame(hoverFrame.current);
      frame.current = hoverFrame.current = null;
      pendingBox.current = null;
    };
  }, [original]);

  const setZoom = (next: number, focusX = 0.5, focusY = 0.5) => {
    followsNative.current = false;
    const fitted = svgFitBox(original, viewport.current.width, viewport.current.height);
    const minimum = svgMinimumZoom(native.current, fitted);
    scheduleBox(svgBoxAtZoom(native.current, currentBox(), Math.min(64, Math.max(minimum, next)), focusX, focusY));
  };
  const anchorAt = (clientX: number, clientY: number): string | null => {
    const element = object.current;
    const document = element?.contentDocument;
    if (!hasLinks.current || !element || !document) return null;
    const rect = element.getBoundingClientRect();
    const scale = rect.width / Math.max(1, element.clientWidth);
    const target = document.elementFromPoint((clientX - rect.left) / scale, (clientY - rect.top) / scale)?.closest("a");
    return target?.getAttribute("href") ?? target?.getAttribute("xlink:href") ?? null;
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const target = event.currentTarget as HTMLDivElement;
    target.focus({ preventScroll: true });
    if (wheelZooms(event.ctrlKey, event.metaKey)) {
      const rect = target.getBoundingClientRect();
      setZoom(
        native.current.width / currentBox().width * Math.exp(-event.deltaY * 0.01),
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
    // preventDefault below cancels the compatibility mousedown, which is what
    // dockview watches to activate a panel. Focus explicitly so panning a media
    // tab still marks it active and cmd+W closes this tab rather than the last
    // one that happened to be focused.
    (event.currentTarget as HTMLElement).focus({ preventScroll: true });
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
      if (el && hasLinks.current) {
        hoverPoint.current = { x: event.clientX, y: event.clientY };
        if (hoverFrame.current === null) hoverFrame.current = requestAnimationFrame(() => {
          hoverFrame.current = null;
          el.style.cursor = anchorAt(hoverPoint.current.x, hoverPoint.current.y) ? "pointer" : "grab";
        });
      }
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
    const element = event.currentTarget as HTMLDivElement;
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
    if (event.type === "pointerup" && active.href && !active.moved) void Promise.resolve(onOpenHref(active.href)).catch(console.error);
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
        <button type="button" onClick={() => setZoom(native.current.width / currentBox().width / 1.2)} title="zoom out">−</button>
        <button type="button" onClick={() => { followsNative.current = true; scheduleBox(native.current); }} title="show one SVG unit per screen pixel">100%</button>
        <span ref={zoomLabel}>100%</span>
        <button type="button" onClick={() => setZoom(native.current.width / currentBox().width * 1.2)} title="zoom in">+</button>
        <button type="button" onClick={() => { followsNative.current = false; scheduleBox(svgFitBox(original, viewport.current.width, viewport.current.height)); }} title="fit the complete SVG">Fit</button>
        <button type="button" onClick={() => void openExternal(path).catch((error) => showError("open external", error))} title="open in the OS default app">↗ external</button>
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
          data={url || undefined}
          type="image/svg+xml"
          aria-label={path}
          style={{ transformOrigin: "0 0", willChange: "transform", display: "block" }}
          onLoad={() => {
            const root = object.current?.contentDocument?.documentElement;
            if (!root) return;
            root.style.width = "100%";
            root.style.height = "100%";
            root.style.maxWidth = "none";
            root.style.maxHeight = "none";
            paintedBox.current = null;
            hasLinks.current = !!root.querySelector("a");
            if (stage.current) stage.current.style.cursor = "grab";
            writeBox(currentBox());
          }}
        />
      </div>
    </div>
  );
}
