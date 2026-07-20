import { useEffect, useMemo, useRef, useState } from "react";
import embed from "vega-embed";
import { invoke } from "../../generated/native";
import { TreeTable, type TreeColumn } from "../../treetable";
import type { JsonSchema } from "../../rulesModel";
import type { MetricMatch, MetricPoint } from "./0_types";

const LIMIT = 500;

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function points(rows: MetricMatch[]): MetricPoint[] {
  return rows.flatMap((row) =>
    row.matches.flatMap((match) =>
      Object.entries(match)
        .filter((entry): entry is [string, number] => numeric(entry[1]))
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
            <span className="metrics-card-value">{String(value)}</span>
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
    cell: (row) => Object.entries(row.matches[0] ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(" · "),
  },
];

function MetricChart({ data }: { data: MetricPoint[] }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current || !data.length) return;
    let view: { finalize: () => void } | undefined;
    embed(host.current, {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      data: { values: data },
      mark: { type: "line", point: true },
      encoding: {
        x: { field: "ts", type: "temporal", title: "time" },
        y: { field: "value", type: "quantitative", title: "value" },
        color: { field: "field", type: "nominal", title: "measure" },
      },
    }, { actions: false }).then((result) => {
      view = result.view;
    }).catch(console.error);
    return () => view?.finalize();
  }, [data]);
  return <div ref={host} className="metrics-chart" />;
}

export function MetricsDashboardPanel() {
  const [rows, setRows] = useState<MetricMatch[]>([]);
  const [selectedStream, setSelectedStream] = useState<string>();
  useEffect(() => {
    invoke<MetricMatch[]>("activity_rule_matches", { limit: LIMIT }).then(setRows).catch(console.error);
    const timer = window.setInterval(() => {
      invoke<MetricMatch[]>("activity_rule_matches", { limit: LIMIT }).then(setRows).catch(console.error);
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const streams = [...new Set(rows.map((row) => row.stream).filter((stream): stream is string => !!stream))];
  const stream = selectedStream && streams.includes(selectedStream) ? selectedStream : streams[0];
  const metricRows = rows.filter((row) => row.stream === stream);
  const latest = metricRows[0];
  const schema = latest?.schema;
  const chartData = useMemo(() => points(metricRows), [metricRows]);
  const data = rows.map((row, index) => ({ ...row, key: `${row.ts}-${index}` }));

  return (
    <div className="v2-panel metrics-panel">
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
        {latest && schema ? <MetricCards row={latest} schema={schema} /> : <div className="session-empty">no emitted metrics</div>}
        {chartData.length ? <MetricChart data={chartData} /> : null}
        {data.length ? (
          <TreeTable columns={HISTORY_COLUMNS} data={data} getRowId={(row) => row.key} defaultSorting={[{ id: "time", desc: true }]} />
        ) : null}
      </div>
    </div>
  );
}
