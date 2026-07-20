import { useMemo, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { readPluginState, savePluginState } from "../../pluginState";

interface MetricsUi {
  layout: number[];
}

export interface MetricsSplitProps {
  chart: ReactNode;
  history: ReactNode;
}

export function MetricsSplit({ chart, history }: MetricsSplitProps) {
  const initialLayout = useMemo(
    () => readPluginState<MetricsUi>("metrics", { layout: [70, 30] }).layout,
    [],
  );
  const latestLayout = useRef(initialLayout);
  const saveLayout = () => savePluginState<MetricsUi>("metrics", { layout: latestLayout.current });

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
