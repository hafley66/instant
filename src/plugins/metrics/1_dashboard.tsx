import { useEffect, useMemo, useRef, useState } from "react";
import embed from "vega-embed";
import { invoke } from "../../generated/native";
import { TreeTable, type TreeColumn } from "../../treetable";
import type { JsonSchema } from "../../rulesModel";
import type { State } from "../../lib/json-rx/0_types";
import type { MetricMatch, MetricPoint } from "./0_types";
import { metricChartSpec } from "./0a_chart";
import { MetricsSplit } from "./0b_layout";
import { createMetricsDashboardState } from "./2_runtime";

const LIMIT = 500;

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPercentMetric(field: string, definition?: JsonSchema): boolean {
  return field === "percent" || field.endsWith("_percent") || (definition?.minimum === 0 && definition.maximum === 100);
}

function formatMetricValue(field: string, value: unknown, definition?: JsonSchema): string {
  if (definition?.format === "date-time" && typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
    }
  }
  if (typeof value === "boolean") return value ? "Enabled" : "Disabled";
  if (numeric(value)) {
    const formatted = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
    return isPercentMetric(field, definition) ? `${formatted}%` : formatted;
  }
  return String(value);
}

function points(rows: MetricMatch[], schema?: JsonSchema): MetricPoint[] {
  return rows.flatMap((row) =>
    row.matches.flatMap((match) =>
      Object.entries(match)
        .filter((entry): entry is [string, number] => numeric(entry[1]) && isPercentMetric(entry[0], schema?.properties?.[entry[0]]))
        .map(([field, value]) => ({ ts: row.ts, field, value, ruleId: row.ruleId, url: row.url })),
    ),
  );
}

function MetricCards({ row, schema }: { row: MetricMatch; schema: JsonSchema }) {
  const values = row.matches[0] ?? {};
  return (
    <div className="metrics-cards">
      {Object.entries(schema.properties ?? {}).map(([field, definition]) => {
        const value = values[field];
        if (value === undefined) return null;
        return (
          <div className="metrics-card" key={field}>
            <span className="metrics-card-label">{definition.title ?? field}</span>
            <span className="metrics-card-value">{formatMetricValue(field, value, definition)}</span>
            {definition.description ? <span className="metrics-card-help">{definition.description}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

const HISTORY_COLUMNS: TreeColumn<MetricMatch & { key: string }>[] = [
  { id: "time", header: "time", sortValue: (row) => row.ts, cell: (row) => new Date(row.ts).toLocaleTimeString() },
  { id: "rule", header: "rule", sortValue: (row) => row.ruleId, cell: (row) => row.ruleId },
  { id: "stream", header: "stream", sortValue: (row) => row.stream ?? "", cell: (row) => row.stream ?? "" },
  {
    id: "values",
    header: "values",
    cell: (row) => Object.entries(row.matches[0] ?? {})
      .map(([field, value]) => `${field}=${formatMetricValue(field, value, row.schema?.properties?.[field])}`)
      .join(" · "),
  },
];

function MetricChart({ data }: { data: MetricPoint[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [renderState, setRenderState] = useState<"loading" | "ready" | "error">("loading");
  const [renderError, setRenderError] = useState("");
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = {
        width: Math.floor(entry.contentRect.width),
        height: Math.floor(entry.contentRect.height),
      };
      setSize((current) => current.width === next.width && current.height === next.height ? current : next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!host.current || !data.length || size.width < 1 || size.height < 1) return;
    let active = true;
    let view: { finalize: () => void } | undefined;
    setRenderState("loading");
    setRenderError("");
    embed(host.current, metricChartSpec(data, size.width, size.height), { actions: false }).then((result) => {
      if (!active) {
        result.view.finalize();
        return;
      }
      view = result.view;
      setRenderState("ready");
    }).catch((error: unknown) => {
      if (!active) return;
      const message = error instanceof Error ? error.message : String(error);
      console.error(error);
      setRenderError(message);
      setRenderState("error");
    });
    return () => {
      active = false;
      view?.finalize();
    };
  }, [data, size]);
  return (
    <div
      ref={host}
      className="metrics-chart"
      data-testid="metrics-chart"
      data-render-state={renderState}
      data-render-error={renderError || undefined}
      style={{ width: "100%", height: "100%", minHeight: 0, boxSizing: "border-box" }}
    />
  );
}

export function MetricsDashboardPanel() {
  const runtime = useMemo(
    () => createMetricsDashboardState(() => invoke<MetricMatch[]>("activity_rule_matches", { limit: LIMIT })),
    [],
  );
  const [dashboardState, setDashboardState] = useState<State>({ value: "loading", rows: [], error: null });
  const [selectedStream, setSelectedStream] = useState<string>();
  useEffect(() => {
    const subscription = runtime.subscribe(setDashboardState);
    return () => subscription.unsubscribe();
  }, [runtime]);

  const rows = dashboardState.rows as unknown as MetricMatch[];

  const streams = [...new Set(rows.map((row) => row.stream).filter((stream): stream is string => !!stream))];
  const stream = selectedStream && streams.includes(selectedStream) ? selectedStream : streams[0];
  const metricRows = rows.filter((row) => row.stream === stream).sort((a, b) => b.ts - a.ts);
  const latest = metricRows[0];
  const schema = latest?.schema;
  const chartData = useMemo(() => points(metricRows, schema), [metricRows, schema]);
  const data = rows.map((row, index) => ({ ...row, key: `${row.ts}-${index}` }));

  return (
    <div className="v2-panel metrics-panel" data-testid="metrics-dashboard" data-state={dashboardState.value}>
      <div className="act-bar">
        <span className="spy-title">metrics</span>
        <span className="wt-count">{metricRows.length}</span>
        <span className="spy-spacer" />
        {streams.length ? (
          <select value={stream} onChange={(event) => setSelectedStream(event.target.value)}>
            {streams.map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        ) : <span className="wt-count">no stream</span>}
      </div>
      <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {latest && schema ? <MetricCards row={latest} schema={schema} /> : <div className="session-empty">{dashboardState.error ? String(dashboardState.error) : "no emitted metrics"}</div>}
        {chartData.length || data.length ? (
          <MetricsSplit
            chart={chartData.length ? <MetricChart data={chartData} /> : <div className="session-empty">no chartable values</div>}
            history={data.length ? (
              <TreeTable columns={HISTORY_COLUMNS} data={data} getRowId={(row) => row.key} defaultSorting={[{ id: "time", desc: true }]} />
            ) : null}
          />
        ) : null}
      </div>
    </div>
  );
}
