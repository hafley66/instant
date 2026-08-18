import type { Geometry } from "@hafley66/grapht";
import { PixiProjection } from "@hafley66/grapht-render-pixijs";
import { useEffect, useMemo, useRef } from "react";
import type { AgentSessionNode } from "./plugins/harnessTrace/0_types";

const MAX_NODES = 128;
const HEIGHT = 76;

function depthOf(node: AgentSessionNode, byId: Map<string, AgentSessionNode>): number {
  let depth = 0;
  const seen = new Set<string>();
  let parent = node.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = byId.get(parent)?.parentId ?? null;
  }
  return depth;
}

function familyGeometry(nodes: AgentSessionNode[]): Geometry {
  const bounded = nodes.slice().sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)).slice(0, MAX_NODES);
  const byId = new Map(bounded.map((node) => [node.id, node]));
  const times = bounded.map((node) => Date.parse(node.ts)).filter(Number.isFinite);
  const first = Math.min(...times, 0);
  const span = Math.max(1, Math.max(...times, first + 1) - first);
  const positions = new Float32Array(bounded.length * 2);
  const index = new Map(bounded.map((node, i) => [node.id, i]));
  const edges: [number, number][] = [];
  bounded.forEach((node, i) => {
    const time = Date.parse(node.ts);
    positions[i * 2] = ((Number.isFinite(time) ? time : first) - first) / span * 1_000;
    positions[i * 2 + 1] = depthOf(node, byId) * 18 + 10;
    const parent = node.parentId == null ? undefined : index.get(node.parentId);
    if (parent !== undefined) edges.push([parent, i]);
  });
  return { nodeIds: bounded.map((node) => node.id), positions, edges };
}

export function BoopFamilyGraph(props: {
  nodes: AgentSessionNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const selectRef = useRef(props.onSelect);
  const hoverRef = useRef(props.onHover);
  selectRef.current = props.onSelect;
  hoverRef.current = props.onHover;
  const geometry = useMemo(() => familyGeometry(props.nodes), [props.nodes]);
  const idAt = useMemo(() => new Map(geometry.nodeIds.map((id, index) => [index, id])), [geometry]);

  useEffect(() => {
    const element = host.current;
    if (!element || geometry.nodeIds.length === 0) return;
    let disposed = false;
    let projection: PixiProjection | null = null;
    let renders = 0;
    const render = () => {
      projection?.render();
      element.dataset.renderCount = String(++renders);
    };
    const pointer = (event: PointerEvent) => {
      if (!projection) return;
      const rect = element.getBoundingClientRect();
      const picked = projection.pickNodeAt(event.clientX - rect.left, event.clientY - rect.top);
      hoverRef.current(picked == null ? null : idAt.get(picked) ?? null);
    };
    const leave = () => hoverRef.current(null);
    const resize = new ResizeObserver((entries) => {
      const width = Math.max(1, Math.floor(entries[0]?.contentRect.width ?? 1));
      projection?.resize(width, HEIGHT);
      render();
    });
    const initialize = async () => {
      const width = Math.max(1, Math.floor(element.getBoundingClientRect().width));
      const next = new PixiProjection(element, geometry, {
        renderer: "webgl", representation: "particles", width, height: HEIGHT,
        devicePixelRatio: window.devicePixelRatio || 1, backgroundColor: 0x10141c,
      });
      await next.init();
      if (disposed) { next.dispose(); return; }
      projection = next;
      next.app.canvas.dataset.testid = "boop-family-grapht";
      element.dataset.nodeCount = String(geometry.nodeIds.length);
      element.dataset.edgeCount = String(geometry.edges.length);
      element.dataset.truncatedCount = String(Math.max(0, props.nodes.length - geometry.nodeIds.length));
      element.dataset.backend = next.actualBackend;
      next.app.canvas.addEventListener("pointermove", pointer);
      next.app.canvas.addEventListener("pointerleave", leave);
      next.app.canvas.addEventListener("click", (event) => {
        const rect = element.getBoundingClientRect();
        const picked = next.pickNodeAt(event.clientX - rect.left, event.clientY - rect.top);
        const id = picked == null ? null : idAt.get(picked);
        if (id) selectRef.current(id);
      });
      resize.observe(element);
      render();
      await next.settleFrames(4);
    };
    void initialize();
    return () => { disposed = true; resize.disconnect(); projection?.dispose(); };
  }, [geometry, idAt]);

  return <div ref={host} className="boop-family-graph" data-testid="boop-family-graph" aria-label="focused family network" style={{ height: HEIGHT, width: "100%", overflow: "hidden" }} />;
}
