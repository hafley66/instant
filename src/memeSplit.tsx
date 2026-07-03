// The meme panel's split-pane layout: sidebar (file tree) | main, with main
// further split into canvas | layers. Built on react-resizable-panels
// (see AGENTS.md "Split panes") instead of hand-rolled pointer-drag sashes.
// Sizes persist as percentages in pluginState (see memeSplitLayout.ts for the
// legacy px -> percentage migration and bound math).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  layersBoundsPct,
  migrateLegacyLayout,
  sidebarBoundsPct,
  type LegacyMemeUi,
  type MemeLayout,
} from "./memeSplitLayout";

// Fallback container size used only before the layout root has been measured
// (first paint) and only when there's no persisted layout yet to fall back
// on directly.
const FALLBACK_WIDTH = 900;
const FALLBACK_HEIGHT = 600;

export interface MemeSplitUi extends LegacyMemeUi {
  outerLayout?: number[];
  innerLayout?: number[];
}

export interface MemeSplitProps {
  initialUi: MemeSplitUi;
  onOuterLayout: (layout: number[]) => void;
  onInnerLayout: (layout: number[]) => void;
  sidebar: ReactNode;
  stage: ReactNode;
  layersPanel: ReactNode;
}

export function MemeSplit({
  initialUi,
  onOuterLayout,
  onInnerLayout,
  sidebar,
  stage,
  layersPanel,
}: MemeSplitProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () =>
      setContainerSize({
        width: el.clientWidth || FALLBACK_WIDTH,
        height: el.clientHeight || FALLBACK_HEIGHT,
      });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const hasPersistedLayout = !!(initialUi.outerLayout && initialUi.innerLayout);

  const layout: MemeLayout = useMemo(() => {
    if (initialUi.outerLayout && initialUi.innerLayout) {
      return {
        outer: [initialUi.outerLayout[0], initialUi.outerLayout[1]],
        inner: [initialUi.innerLayout[0], initialUi.innerLayout[1]],
      };
    }
    return migrateLegacyLayout(initialUi, containerSize.width, containerSize.height);
  }, [initialUi, containerSize.width, containerSize.height]);

  // One-time migration: write the converted percentages back into
  // pluginState so subsequent mounts read outerLayout/innerLayout directly
  // and no longer depend on the container's measured size.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (hasPersistedLayout || migratedRef.current) return;
    migratedRef.current = true;
    onOuterLayout(layout.outer);
    onInnerLayout(layout.inner);
  }, [hasPersistedLayout, layout, onOuterLayout, onInnerLayout]);

  const sidebarBounds = sidebarBoundsPct(containerSize.width);
  const layersBounds = layersBoundsPct(containerSize.height);

  // onLayout fires on every drag tick; only persist to pluginState once the
  // drag/keyboard interaction ends (mirrors the old sash's pointerup-only
  // save) so we don't hammer the store mid-drag.
  const latestOuter = useRef<number[]>(layout.outer);
  const latestInner = useRef<number[]>(layout.inner);
  const flushOuter = () => onOuterLayout(latestOuter.current);
  const flushInner = () => onInnerLayout(latestInner.current);

  return (
    <div ref={rootRef} className="meme-split-root">
      <PanelGroup
        direction="horizontal"
        id="meme-workspace"
        className="meme-workspace"
        onLayout={(l) => {
          latestOuter.current = l;
        }}
      >
        <Panel
          id="meme-sidebar-panel"
          defaultSize={layout.outer[0]}
          minSize={sidebarBounds.min}
          maxSize={sidebarBounds.max}
          className="meme-thumbs-panel"
        >
          {sidebar}
        </Panel>
        <PanelResizeHandle
          className="meme-sash meme-sash-vertical"
          onDragging={(dragging) => {
            if (!dragging) flushOuter();
          }}
          onBlur={flushOuter}
        />
        <Panel id="meme-main-panel" defaultSize={layout.outer[1]}>
          <PanelGroup
            direction="vertical"
            id="meme-inner-split"
            onLayout={(l) => {
              latestInner.current = l;
            }}
          >
            <Panel id="meme-stage-panel" defaultSize={layout.inner[0]}>
              {stage}
            </Panel>
            <PanelResizeHandle
              className="meme-sash meme-sash-horizontal"
              onDragging={(dragging) => {
                if (!dragging) flushInner();
              }}
              onBlur={flushInner}
            />
            <Panel
              id="meme-layers-panel"
              defaultSize={layout.inner[1]}
              minSize={layersBounds.min}
              maxSize={layersBounds.max}
            >
              {layersPanel}
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  );
}
