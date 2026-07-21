import { useMemo, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { readPluginState, savePluginState } from "../../pluginState";
import type { MetricsUiState } from "./0_types";

export interface MetricsSplitProps {
  chart: ReactNode;
  history: ReactNode;
}

export function MetricsSplit({ chart, history }: MetricsSplitProps) {
  const initialLayout = useMemo(
    () => readPluginState<Partial<MetricsUiState>>("metrics", {}).layout ?? [70, 30],
    [],
  );
  const latestLayout = useRef(initialLayout);
  const saveLayout = () => savePluginState<MetricsUiState>("metrics", { layout: latestLayout.current });

  return (
    <PanelGroup
      direction="vertical"
      id="metrics-chart-history"
      style={{ flex: "1 1 auto", minHeight: 0 }}
      onLayout={(layout) => {
        latestLayout.current = layout;
      }}
    >
      <Panel id="metrics-chart-panel" defaultSize={initialLayout[0]} minSize={25}>
        {chart}
      </Panel>
      <PanelResizeHandle
        className="meme-sash meme-sash-horizontal"
        onDragging={(dragging) => {
          if (!dragging) saveLayout();
        }}
        onBlur={saveLayout}
      />
      <Panel id="metrics-history-panel" defaultSize={initialLayout[1]} minSize={18}>
        {history}
      </Panel>
    </PanelGroup>
  );
}

export interface MetricsComparisonProps {
  streams: string[];
  children: ReactNode[];
}

export function MetricsComparison({ streams, children }: MetricsComparisonProps) {
  const initialLayout = useMemo(
    () => readPluginState<Partial<MetricsUiState>>("metrics", {}).comparisonLayout ?? [50, 50],
    [],
  );
  const latestLayout = useRef(initialLayout);
  const saveLayout = () => savePluginState<MetricsUiState>("metrics", { comparisonLayout: latestLayout.current });

  if (streams.length < 2) return <>{children[0]}</>;

  return (
    <PanelGroup
      direction="horizontal"
      id="metrics-stream-comparison"
      style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0 }}
      onLayout={(layout) => {
        latestLayout.current = layout;
      }}
    >
      <Panel id="metrics-stream-left" defaultSize={initialLayout[0]} minSize={25}>
        {children[0]}
      </Panel>
      <PanelResizeHandle
        className="meme-sash meme-sash-vertical"
        onDragging={(dragging) => {
          if (!dragging) saveLayout();
        }}
        onBlur={saveLayout}
      />
      <Panel id="metrics-stream-right" defaultSize={initialLayout[1]} minSize={25}>
        {children[1]}
      </Panel>
    </PanelGroup>
  );
}
