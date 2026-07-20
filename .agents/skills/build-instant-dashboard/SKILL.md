---
name: build-instant-dashboard
description: Add or modify an Instant dashboard for captured usage, spend, status, quota, job, or other structured streams. Use for Rule JSON emissions, JSON Schema-driven metric cards, Vega-Lite charts, Metrics history, dashboard plugins, and golden browser coverage. Prefer configuring the generic Metrics dashboard before creating a service-specific React panel.
---

# Build an Instant dashboard

## Read first

Read these files in order:

1. `src/plugins/metrics/README.md`
2. `src/plugins/metrics/0_types.ts`
3. `src/plugins/metrics/0a_chart.ts`
4. `src/plugins/metrics/0b_layout.tsx`
5. `src/plugins/metrics/1_dashboard.tsx`
6. `src/plugins/metrics/2_runtime.ts`
7. `books/json-rx-automation/0_current-capabilities.md`

Read `books/json-rx-automation/1_timed-events-and-routines.md` and
`2_keyed-aggregation.md` only when the dashboard needs routines or keyed
materialized rows.

## Select the implementation level

Use the lowest level that represents the requested dashboard:

1. Add a Rule JSON definition with `emit.stream` and `emit.schema`.
2. Extend generic schema-to-card or schema-to-chart rendering.
3. Add a reusable dashboard renderer or Vega-Lite spec reference.
4. Add a service-specific panel only when the prior interfaces cannot express
   the requested interaction or data shape.

Do not duplicate the Metrics panel for Codex, OpenCode, Claude, Jenkins, or
another service when a new stream and schema are sufficient.

## Preserve the wire contract

Produce this envelope:

```ts
type DashboardEmission = {
  ruleId: string;
  url: string;
  ts: number;
  matches: Record<string, unknown>[];
  stream: string;
  schema: JsonSchema;
};
```

- Use a stable dotted stream name such as `codex.usage` or `opencode.spend`.
- Keep record values JSON-serializable.
- Keep `ruleId`, `url`, and `ts` for provenance and ordering.
- Use JSON Schema `title`, `description`, `format`, `minimum`, and `maximum`
  before adding renderer-specific metadata.
- Name percentage fields with `_percent` or give them a zero-to-one-hundred
  schema domain when they should become chart series.

## Capture and normalize

For browser-observed JSON, add a `netcapture` rule and map response fields with
JSONata:

```json
{
  "id": "service-usage",
  "host": "^service\\.example$",
  "mode": "netcapture",
  "request": {
    "methods": ["GET"],
    "url": "/api/usage"
  },
  "response": {
    "extract": {
      "session_percent": "session.utilization",
      "session_resets_at": "session.resets_at"
    }
  },
  "emit": {
    "stream": "service.usage",
    "schema": {
      "type": "object",
      "properties": {
        "session_percent": {
          "type": "number",
          "title": "Session usage",
          "minimum": 0,
          "maximum": 100
        },
        "session_resets_at": {
          "type": "string",
          "format": "date-time",
          "title": "Session reset"
        }
      }
    }
  },
  "diagnostics": "all",
  "enabled": true
}
```

Do not add shell, HTTP, WebSocket, LSP, or process execution to Instant while
building a dashboard. Treat those as Sprefa-owned producers that deliver the
same dashboard envelope or a later documented adapter input.

## UI constraints

- Use `TreeTable` for every row-oriented view.
- Use Vega-Lite through `vega-embed` for charts.
- Keep chart specification construction pure and separate from React.
- Use `react-resizable-panels` for split panes and persist layout through
  `pluginState`.
- Keep one panel per file and source files under approximately 500 lines.
- Follow author-driven numeric filenames in dependency and reading order.
- Expose deterministic loading, ready, empty, and error states to tests.

## Tests

For a new capture source:

1. Add a realistic response fixture without credentials or cookies.
2. Cover the real extension, local page, local API response, extraction, and
   localhost ingest path when capture behavior changes.
3. Add or extend the Metrics Playwright test with semantic assertions.
4. Wait for Vega's render-ready state before screenshots or measurements.
5. Update a golden screenshot only after visual inspection.
6. Prefer inline snapshots for pure data and spec transformations.
7. Do not use `toBeDefined`.

Run:

```text
just check
just build
just cargo-check
just ext-build
corepack pnpm@10.12.4 exec vitest run
```

Run browser tests through the repository Playwright configuration. Do not run
`just dev`; use `just dev-safe` for an isolated manual verification instance.

## Report

Report the stream name, schema fields, capture route, files changed, test
counts, and gate results. Do not commit or push unless requested.
