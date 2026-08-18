import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { readPluginState, savePluginState } from "../../pluginState";

export interface HarnessTraceUiState {
  familyStripLayouts?: Record<string, [number, number]>;
  familyContentLayouts?: Record<string, [number, number]>;
}

const DEFAULT_LAYOUT: [number, number] = [70, 30];
const DEFAULT_CONTENT_LAYOUT: [number, number] = [38, 62];

function layoutFor(sid: string): [number, number] {
  const layout = readPluginState<HarnessTraceUiState>("harnessTrace", {}).familyStripLayouts?.[sid];
  if (!layout || layout.length !== 2 || !layout.every((size) => Number.isFinite(size) && size > 0)) return DEFAULT_LAYOUT;
  return layout;
}

function contentLayoutFor(sid: string): [number, number] {
  const layout = readPluginState<HarnessTraceUiState>("harnessTrace", {}).familyContentLayouts?.[sid];
  if (!layout || layout.length !== 2 || !layout.every((size) => Number.isFinite(size) && size > 0)) return DEFAULT_CONTENT_LAYOUT;
  return layout;
}

export interface FocusedFamilySplitProps {
  sid: string;
  term: ReactNode;
  strip: ReactNode;
  onCommittedLayout: () => void;
}

// This only mounts for the focused-family view. The regular relation strip
// remains content-sized, while this view preserves a user-set percentage split
// per owning terminal in the harnessTrace plugin slice.
export function FocusedFamilySplit({ sid, term, strip, onCommittedLayout }: FocusedFamilySplitProps) {
  const initialLayout = useMemo(() => layoutFor(sid), [sid]);
  const latestLayout = useRef(initialLayout);
  const frame = useRef<number | null>(null);
  const notifyAfterCommit = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      onCommittedLayout();
    });
  };

  useEffect(() => {
    notifyAfterCommit();
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []); // the mount is the restored/open layout commit

  const saveLayout = () => {
    const state = readPluginState<HarnessTraceUiState>("harnessTrace", {});
    savePluginState<HarnessTraceUiState>("harnessTrace", {
      familyStripLayouts: { ...state.familyStripLayouts, [sid]: latestLayout.current },
    });
    notifyAfterCommit();
  };

  return (
    <PanelGroup direction="vertical" id={`focused-family-${sid}`} data-testid="focused-family-split" style={{ flex: "1 1 auto", minHeight: 0 }} onLayout={(layout) => { latestLayout.current = [layout[0], layout[1]]; }}>
      <Panel id={`focused-family-term-${sid}`} defaultSize={initialLayout[0]} minSize={25}>
        {term}
      </Panel>
      <PanelResizeHandle className="meme-sash meme-sash-horizontal" data-testid="focused-family-resize" onDragging={(dragging) => { if (!dragging) saveLayout(); }} onBlur={saveLayout} />
      <Panel id={`focused-family-strip-${sid}`} defaultSize={initialLayout[1]} minSize={15}>
        {strip}
      </Panel>
    </PanelGroup>
  );
}

export function FocusedFamilyContentSplit(props: { sid: string; graph: ReactNode; table: ReactNode }) {
  const initialLayout = useMemo(() => contentLayoutFor(props.sid), [props.sid]);
  const latestLayout = useRef(initialLayout);
  const saveLayout = () => {
    const state = readPluginState<HarnessTraceUiState>("harnessTrace", {});
    savePluginState<HarnessTraceUiState>("harnessTrace", {
      ...state,
      familyContentLayouts: { ...state.familyContentLayouts, [props.sid]: latestLayout.current },
    });
  };

  return (
    <PanelGroup direction="vertical" id={`focused-family-content-${props.sid}`} data-testid="focused-family-content-split" style={{ flex: "1 1 auto", minHeight: 0 }} onLayout={(layout) => { latestLayout.current = [layout[0], layout[1]]; }}>
      <Panel id={`focused-family-graph-${props.sid}`} defaultSize={initialLayout[0]} minSize={15}>
        {props.graph}
      </Panel>
      <PanelResizeHandle className="meme-sash meme-sash-horizontal" data-testid="focused-family-content-resize" onDragging={(dragging) => { if (!dragging) saveLayout(); }} onBlur={saveLayout} />
      <Panel id={`focused-family-table-${props.sid}`} defaultSize={initialLayout[1]} minSize={25}>
        {props.table}
      </Panel>
    </PanelGroup>
  );
}
