import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { copyText } from "./0_copyText";
import { isSequenceDiagramSource, parseSequenceSource, sequenceFocusFromElement, sequenceMarkup } from "./1_sequence";
import "./0_diagramLightbox.css";

type SvgBox = { x: number; y: number; width: number; height: number };

function sourceBox(svg: SVGSVGElement): SvgBox {
  const parts = svg.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (parts?.length === 4 && parts.every(Number.isFinite)) {
    return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
  }
  return { x: 0, y: 0, width: svg.width.baseVal.value || 1, height: svg.height.baseVal.value || 1 };
}

function VectorDiagramViewport({
  svg,
  language,
  code,
  toolbarStart,
}: {
  svg: string;
  language: "mermaid" | "d2";
  code: string;
  toolbarStart: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const original = useRef<SvgBox>({ x: 0, y: 0, width: 1, height: 1 });
  const current = useRef<SvgBox>(original.current);
  const drag = useRef<{ pointerId: number; x: number; y: number; box: SvgBox } | null>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const actorLane = useRef<HTMLDivElement>(null);
  const syncActorLane = useRef<() => void>(() => {});
  const sequence = useMemo(() => parseSequenceSource(language, code), [code, language]);
  const sequenceEnabled = isSequenceDiagramSource(language, code) && sequence.actors.length > 0;
  const decoratedSvg = useMemo(() => sequenceEnabled ? sequenceMarkup(svg, language, code) : svg, [code, language, sequenceEnabled, svg]);
  const [stickyActors, setStickyActors] = useState(true);
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([]);
  const [focus, setFocus] = useState<{ entityId?: string; actorIds: string[] } | null>(null);

  const write = (box: SvgBox) => {
    current.current = box;
    host.current?.querySelector("svg")?.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(original.current.width / box.width * 100)}%`;
    requestAnimationFrame(syncActorLane.current);
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
  }, [decoratedSvg]);

  useEffect(() => {
    const stage = host.current;
    const lane = actorLane.current;
    const svg = stage?.querySelector<SVGSVGElement>("svg");
    if (!stage || !lane || !svg || !sequenceEnabled) return;

    lane.replaceChildren();
    const entries = sequence.actors.flatMap((actor) => {
      const label = Array.from(svg.querySelectorAll<SVGGraphicsElement>('[data-sequence-role="actor-label"]'))
        .find((candidate) => candidate.getAttribute("data-sequence-actors") === actor.id);
      if (!label) return [];

      const labelBox = label.getBBox();
      const labelArea = Math.max(1, labelBox.width * labelBox.height);
      const ancestors: SVGGraphicsElement[] = [];
      let candidate: Element | null = label.parentNode instanceof Element ? label.parentNode : null;
      while (candidate && candidate !== svg) {
        if (candidate instanceof SVGGraphicsElement) ancestors.push(candidate);
        candidate = candidate.parentNode instanceof Element ? candidate.parentNode : null;
      }
      const source = ancestors
        .map((element) => ({ element, box: element.getBBox() }))
        .filter(({ box }) => box.width * box.height >= labelArea)
        .sort((left, right) => left.box.width * left.box.height - right.box.width * right.box.height)[0];
      if (!source) return [];

      source.element.setAttribute("data-sequence-role", "actor-source");
      source.element.setAttribute("data-sequence-actor-id", actor.id);
      source.element.setAttribute("data-sequence-actors", actor.id);

      const item = document.createElement("div");
      item.className = "diagram-sequence-actor";
      item.dataset.sequenceActorId = actor.id;
      item.dataset.sequenceVisible = "false";
      const localSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      localSvg.setAttribute("viewBox", `${source.box.x} ${source.box.y} ${Math.max(1, source.box.width)} ${Math.max(1, source.box.height)}`);
      localSvg.setAttribute("aria-label", actor.label);
      localSvg.append(source.element.cloneNode(true));
      item.append(localSvg);
      lane.append(item);
      return [{ actorId: actor.id, source: source.element, item }];
    });

    const sync = () => {
      const viewportRect = stage.getBoundingClientRect();
      const laneRect = lane.getBoundingClientRect();
      for (const entry of entries) {
        const sourceRect = entry.source.getBoundingClientRect();
        const active = focus?.actorIds.includes(entry.actorId) ?? false;
        const aboveLane = sourceRect.bottom <= laneRect.bottom;
        const belowViewport = sourceRect.top >= viewportRect.bottom;
        const outsideX = sourceRect.right <= viewportRect.left || sourceRect.left >= viewportRect.right;
        const visible = stickyActors && (aboveLane || belowViewport || (active && outsideX));
        const width = Math.min(Math.max(1, sourceRect.width), Math.max(1, viewportRect.width - 8));
        const sourceLeft = sourceRect.left - viewportRect.left;
        const clampedLeft = Math.min(Math.max(4, sourceLeft), Math.max(4, viewportRect.width - width - 4));
        entry.item.style.setProperty("--sequence-actor-left", `${clampedLeft}px`);
        entry.item.style.setProperty("--sequence-actor-width", `${width}px`);
        entry.item.dataset.sequenceVisible = visible ? "true" : "false";
        entry.item.dataset.sequenceActive = active ? "true" : "false";
        entry.source.dataset.sequenceSourceVisible = visible ? "false" : "true";
      }
    };

    syncActorLane.current = sync;
    const observer = new MutationObserver(sync);
    observer.observe(svg, { attributes: true, attributeFilter: ["viewBox"] });
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(stage);
    sync();
    return () => {
      observer.disconnect();
      resizeObserver.disconnect();
      syncActorLane.current = () => {};
      lane.replaceChildren();
    };
  }, [decoratedSvg, focus, sequence, sequenceEnabled, stickyActors]);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const activeActorIds = new Set(focus?.actorIds ?? []);
    for (const element of root.querySelectorAll<SVGElement>("[data-sequence-entity]")) {
      const entityId = element.getAttribute("data-sequence-entity");
      const actorIds = (element.getAttribute("data-sequence-actors") ?? "").split(",").filter(Boolean);
      const active = entityId === focus?.entityId || actorIds.some((actorId) => activeActorIds.has(actorId));
      if (active) element.setAttribute("data-sequence-active", "true");
      else element.removeAttribute("data-sequence-active");
      const groups = (element.getAttribute("data-sequence-groups") ?? "").split(" ").filter(Boolean);
      if (groups.some((groupId) => collapsedGroupIds.includes(groupId))) element.setAttribute("data-sequence-collapsed", "true");
      else element.removeAttribute("data-sequence-collapsed");
    }
  }, [collapsedGroupIds, decoratedSvg, focus]);

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

  const pointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (!sequenceEnabled || !(event.target instanceof Element)) return;
    const element = event.target.closest("[data-sequence-entity]");
    if (!element || !event.currentTarget.contains(element)) return;
    setFocus(sequenceFocusFromElement(element));
  };

  return (
    <div
      className={`diagram-vector-viewport${sequenceEnabled ? " diagram-vector-sequence" : ""}`}
      data-sequence-diagram={sequenceEnabled ? "true" : "false"}
      data-sequence-sticky-actors={stickyActors ? "true" : "false"}
      data-sequence-collapsed-groups={collapsedGroupIds.join(" ")}
    >
      <div className="file-image-tools">
        {toolbarStart}
        {sequenceEnabled && (
          <>
            <button
              type="button"
              title="Toggle sticky sequence actor names"
              aria-pressed={stickyActors}
              data-sequence-sticky-toggle="true"
              onClick={() => setStickyActors((value) => !value)}
            >
              Actors
            </button>
            {sequence.groups.map((group) => {
              const collapsed = collapsedGroupIds.includes(group.id);
              return (
                <button
                  key={group.id}
                  type="button"
                  title={`${collapsed ? "Expand" : "Collapse"} ${group.label}`}
                  aria-pressed={collapsed}
                  data-sequence-group-toggle={group.id}
                  onClick={() => setCollapsedGroupIds((currentGroups) => collapsed ? currentGroups.filter((id) => id !== group.id) : [...currentGroups, group.id])}
                >
                  {collapsed ? "＋" : "－"} {group.label}
                </button>
              );
            })}
          </>
        )}
        <button type="button" title="zoom out" onClick={() => setZoom(original.current.width / current.current.width / 1.2)}>−</button>
        <button type="button" title="fit the complete SVG" onClick={() => write(original.current)}>Fit</button>
        <span ref={zoomLabel}>100%</span>
        <button type="button" title="zoom in" onClick={() => setZoom(original.current.width / current.current.width * 1.2)}>+</button>
      </div>
      {sequenceEnabled && <div ref={actorLane} className="diagram-sequence-actors" data-sequence-actors-sticky={stickyActors ? "true" : "false"} aria-label="Sequence actors" />}
      <div
        ref={host}
        className="diagram-vector-stage"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerOver={pointerOver}
        onPointerLeave={() => setFocus(null)}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        dangerouslySetInnerHTML={{ __html: decoratedSvg }}
      />
    </div>
  );
}

export function diagramSvgMarkup(svg: string, language?: "mermaid" | "d2", code?: string): string {
  if (!language || code === undefined) return svg;
  return sequenceMarkup(svg, language, code);
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
  code?: string;
  onClose: () => void;
};

export function DiagramLightbox(props: DiagramLightboxHistoryProps | DiagramLightboxSingleProps) {
  const entries = "entries" in props ? props.entries : [{
    id: "markdown-diagram",
    svg: props.svg,
    language: props.language,
    dark: props.dark,
    code: props.code ?? "",
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
          language={active.language}
          code={active.code}
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
