import type { JsonSchema } from "../../rulesModel";
import type { MetricMatch, MetricPoint } from "./0_types";

export function streamNames(rows: MetricMatch[]): string[] {
  return [...new Set(rows.map((row) => row.stream).filter((stream): stream is string => Boolean(stream)))];
}
export function selectedStreams(available: string[], stored: string[] = []): string[] {
  const selected = stored.filter((stream, index) => available.includes(stream) && stored.indexOf(stream) === index);
  return selected.length ? selected.slice(0, 2) : available.slice(0, 1);
}

export function streamRows(rows: MetricMatch[], stream: string): MetricMatch[] {
  return rows.filter((row) => row.stream === stream).sort((left, right) => right.ts - left.ts);
}

function numeric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPercentMetric(field: string, definition?: JsonSchema): boolean {
  return field === "percent" || field.endsWith("_percent") || (definition?.minimum === 0 && definition.maximum === 100);
}

export function metricPoints(rows: MetricMatch[], schema?: JsonSchema): MetricPoint[] {
  return rows.flatMap((row) =>
    row.matches.flatMap((match) =>
      Object.entries(match)
        .filter(([field, value]) => numeric(value) && isPercentMetric(field, schema?.properties?.[field]))
        .map(([field, value]) => ({
          ts: row.ts,
          stream: row.stream ?? "",
          field,
          series: `${row.stream ?? ""} · ${field}`,
          value: value as number,
          ruleId: row.ruleId,
          url: row.url,
        })),
    ),
  );
}
