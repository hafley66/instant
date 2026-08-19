import { Signal } from "@hafley66/signals";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { auditTime, filter, fromEvent, map, share, tap } from "rxjs";
import { readPluginState, savePluginState } from "../../pluginState";

export interface HarnessTraceUiState {
  familyStripLayouts?: Record<string, [number, number]>;
  familyContentLayouts?: Record<string, [number, number]>;
}

const DEFAULT_LAYOUT: [number, number] = [70, 30];
const DEFAULT_CONTENT_LAYOUT: [number, number] = [38, 62];
const MIN_STRIP_SIZE = 15;
const MAX_STRIP_SIZE = 75;
const WHEEL_PERCENT_SCALE = 0.05;

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
  const stripPanel = useRef<ImperativePanelHandle | null>(null);
  const stripHost = useRef<HTMLDivElement | null>(null);
  const gestureState = useMemo(() => Signal({ panelSize: initialLayout[1] }), [sid]);
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

  // Gesture ownership: ordinary vertical wheel (non-Ctrl, deltaY-dominant) over
  // the surrounding focused-strip surface grows/shrinks the outer term/strip
  // dock, clamped 15%-75%, and never bubbles to the Marbler below. Ctrl-wheel /
  // trackpad pinch and horizontal wheel are left to Marbler's own timeline
  // (zoom/pan), so they must not resize the dock; nor may a wheel that began
  // inside the Marbler timeline be captured here. Captured before Marbler's
  // listener so the strip owns plain scroll and Marbler owns time.
  useEffect(() => {
    const host = stripHost.current;
    if (!host) return;
    const wheel$ = fromEvent<WheelEvent>(host, "wheel", { capture: true, passive: false }).pipe(
      filter((event) => !event.ctrlKey && Math.abs(event.deltaY) >= Math.abs(event.deltaX)),
      filter((event) => !(event.target as Element | null)?.closest?.(".time-navigator")),
      map((event) => {
        const current = gestureState.panelSize.$();
        const next = Math.min(MAX_STRIP_SIZE, Math.max(MIN_STRIP_SIZE, current - event.deltaY * WHEEL_PERCENT_SCALE));
        return { event, current, next };
      }),
      filter(({ current, next }) => current !== next),
      tap(({ event, next }) => {
        event.preventDefault();
        event.stopPropagation();
        gestureState.panelSize.$(next);
        stripPanel.current?.resize(next);
      }),
      share(),
    );
    const resize = wheel$.subscribe();
    const persist = wheel$.pipe(auditTime(120)).subscribe(() => saveLayout());
    return () => {
      resize.unsubscribe();
      persist.unsubscribe();
    };
  }, [gestureState]);

  return (
    <PanelGroup direction="vertical" id={`focused-family-${sid}`} data-testid="focused-family-split" style={{ flex: "1 1 auto", minHeight: 0 }} onLayout={(layout) => { latestLayout.current = [layout[0], layout[1]]; }}>
      <Panel id={`focused-family-term-${sid}`} className="focused-family-term-panel" defaultSize={initialLayout[0]} minSize={25}>
        {term}
      </Panel>
      <PanelResizeHandle className="meme-sash meme-sash-horizontal" data-testid="focused-family-resize" onDragging={(dragging) => { if (!dragging) saveLayout(); }} onBlur={saveLayout} />
      <Panel ref={stripPanel} id={`focused-family-strip-${sid}`} defaultSize={initialLayout[1]} minSize={MIN_STRIP_SIZE} maxSize={MAX_STRIP_SIZE}>
        <div ref={stripHost} data-testid="focused-family-wheel-surface" style={{ height: "100%", minHeight: 0 }}>
          {strip}
        </div>
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
