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
  field: string;
  value: number;
}
