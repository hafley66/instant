// Pure rule model: the Rule/RuleMatch shapes plus the string<->field mapping the
// inline grid editor relies on. No JSX, no tauri, no React — so the field
// mapping, schedule parse/format, and validation are unit-testable in isolation
// (rulesModel.test.ts). rules.tsx imports these; the grid hands us (columnId,
// string) pairs and we map them back onto an immutable Rule (or reject).

export type RuleMode = "textnodes" | "selector" | "netcapture";
export type RuleSchedule =
  | { source: { interval: { periodMs: number } }; pipe: Array<{ exhaustMap: { effect: unknown } }> }
  | { intervalMin: number }
  | "passive";
export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minimum?: number;
  maximum?: number;
  format?: string;
}

export interface Rule {
  id: string;
  host: string;
  url?: string;
  mode: RuleMode;
  selector?: string;
  regex?: string;
  captures?: Record<string, string>;
  request?: { methods?: string[]; url?: string };
  response?: { extract?: Record<string, string> };
  emit?: { stream: string; schema?: JsonSchema };
  schedule?: RuleSchedule;
  enabled?: boolean;
}

// rule-match payload (Rust RuleMatch, serialized with ruleId).
export interface RuleMatch {
  ruleId: string;
  url: string;
  ts: number;
  matches: Record<string, unknown>[];
  stream?: string;
  schema?: JsonSchema;
}

// Select-column option sets. `as const` so they double as the runtime validator
// and the TreeColumn select options (readonly string[]).
export const RULE_MODES = ["textnodes", "selector", "netcapture"] as const;

// Cell display (host column, feed). "5m" / "passive" / "".
export function scheduleLabel(s: Rule["schedule"]): string {
  if (s == null) return "";
  if (s === "passive") return "passive";
  return `${"source" in s ? s.source.interval.periodMs / 60_000 : s.intervalMin}m`;
}

// Edit value for the schedule cell: bare "passive" | minutes | "" (no trailing
// "m"; the user types "passive" or an integer). Distinct from scheduleLabel so
// the cell reads "5m" but edits as "5".
export function formatSchedule(s: Rule["schedule"]): string {
  if (s == null) return "";
  if (s === "passive") return "passive";
  return String("source" in s ? s.source.interval.periodMs / 60_000 : s.intervalMin);
}

type EditableSchedule = { intervalMin: number } | "passive";
export type ScheduleParse = { ok: true; value: EditableSchedule } | { ok: false; error: string };

// "passive" (any case) | positive integer minutes. Empty / non-integer / <= 0
// are rejected so a bad edit flashes and never persists.
export function parseSchedule(input: string): ScheduleParse {
  const t = input.trim();
  if (t.toLowerCase() === "passive") return { ok: true, value: "passive" };
  if (/^\d+$/.test(t)) {
    const n = Number.parseInt(t, 10);
    if (n > 0) return { ok: true, value: { intervalMin: n } };
    return { ok: false, error: "schedule minutes must be > 0" };
  }
  return { ok: false, error: `bad schedule "${input}" — use "passive" or minutes` };
}

// null when `src` compiles as a RegExp, else the engine's message. host and
// regex fields are both regexes (host is tested against location.host).
export function validateRegex(src: string): string | null {
  try {
    new RegExp(src);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export type FieldEdit = { ok: true; rule: Rule } | { ok: false; error: string };

function has<T extends readonly string[]>(opts: T, v: string): v is T[number] {
  return (opts as readonly string[]).includes(v);
}

// Map one inline cell edit back onto an immutable Rule, validating per field.
// Unknown / read-only columns (id) reject. Empty text clears optional fields.
export function applyCellEdit(rule: Rule, columnId: string, value: string): FieldEdit {
  switch (columnId) {
    case "host": {
      const err = validateRegex(value);
      if (err) return { ok: false, error: `bad host regex: ${err}` };
      return { ok: true, rule: { ...rule, host: value } };
    }
    case "url":
      return { ok: true, rule: { ...rule, url: value.trim() || undefined } };
    case "mode":
      if (!has(RULE_MODES, value)) return { ok: false, error: `bad mode: ${value}` };
      return { ok: true, rule: { ...rule, mode: value } };
    case "selector":
      return { ok: true, rule: { ...rule, selector: value.trim() || undefined } };
    case "regex": {
      const v = value.trim();
      const err = v ? validateRegex(v) : null;
      if (err) return { ok: false, error: `bad regex: ${err}` };
      return { ok: true, rule: { ...rule, regex: v || undefined } };
    }
    case "schedule": {
      const p = parseSchedule(value);
      if (!p.ok) return { ok: false, error: p.error };
      if (p.value !== "passive" && typeof rule.schedule === "object" && "source" in rule.schedule) {
        return {
          ok: true,
          rule: {
            ...rule,
            schedule: {
              ...rule.schedule,
              source: { interval: { periodMs: p.value.intervalMin * 60_000 } },
            },
          },
        };
      }
      return { ok: true, rule: { ...rule, schedule: p.value } };
    }
    default:
      return { ok: false, error: `not editable: ${columnId}` };
  }
}

// Collision-free next id for + Rule (rules.length+1 alone reuses ids after a
// delete, which duplicates getRowId and breaks row identity / selection).
export function nextRuleId(rules: Rule[]): string {
  const ids = new Set(rules.map((r) => r.id));
  let n = rules.length + 1;
  while (ids.has(`rule-${n}`)) n++;
  return `rule-${n}`;
}
