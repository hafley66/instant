import type { JsonSchema } from "../../rulesModel";

export interface MetricMatch {
  ruleId: string;
  url: string;
  ts: number;
  matches: Record<string, unknown>[];
  stream?: string;
  schema?: JsonSchema;
}

export interface MetricPoint {
  ts: number;
  stream: string;
  field: string;
  series: string;
  value: number;
  ruleId: string;
  url: string;
}

export interface MetricsUiState {
  layout: number[];
  comparisonLayout: number[];
  comparisonStreams: string[];
}
