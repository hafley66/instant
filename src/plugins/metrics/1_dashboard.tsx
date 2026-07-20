import { useEffect, useMemo, useRef, useState } from "react";
import embed from "vega-embed";
import { invoke } from "../../generated/native";
import { TreeTable, type TreeColumn } from "../../treetable";
import type { JsonSchema } from "../../rulesModel";
import type { State } from "../../lib/json-rx/0_types";
import type { MetricMatch, MetricPoint } from "./0_types";
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
        .map(([field, value]) => ({ ts: row.ts, field, value })),
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
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!host.current || !data.length || width < 1) return;
    let view: { finalize: () => void } | undefined;
    embed(host.current, {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: Math.max(240, width - 80),
      height: 260,
      autosize: { type: "fit-x", contains: "padding" },
      data: { values: data },
      mark: { type: "line", point: { filled: true, size: 55 } },
      encoding: {
        x: { field: "ts", type: "temporal", title: "time", axis: { format: "%H:%M:%S", labelAngle: 0 } },
        y: { field: "value", type: "quantitative", title: "usage %", scale: { domain: [0, 100] } },
        color: { field: "field", type: "nominal", title: "measure" },
        tooltip: [
          { field: "ts", type: "temporal", title: "time" },
          { field: "field", type: "nominal", title: "measure" },
          { field: "value", type: "quantitative", title: "usage", format: ".2f" },
        ],
      },
    }, { actions: false }).then((result) => {
      view = result.view;
    }).catch(console.error);
    return () => {
      view?.finalize();
    };
  }, [data, width]);
  return <div ref={host} className="metrics-chart" />;
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
      <div className="panel-scroll">
        {latest && schema ? <MetricCards row={latest} schema={schema} /> : <div className="session-empty">{dashboardState.error ? String(dashboardState.error) : "no emitted metrics"}</div>}
        {chartData.length ? <MetricChart data={chartData} /> : null}
        {data.length ? (
          <TreeTable columns={HISTORY_COLUMNS} data={data} getRowId={(row) => row.key} defaultSorting={[{ id: "time", desc: true }]} />
        ) : null}
      </div>
    </div>
  );
}
