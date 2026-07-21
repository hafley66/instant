# Rules capture and Metrics dashboard

This directory contains the generic dashboard consumer for values emitted by
Rules. Rules owns configuration, matching, extraction, and match history.
Metrics owns stream selection, schema-driven formatting, visualization, and
metric history. The Metrics panel is registered as a child of Rules through
`PanelDef.railParent`.

## Dashboard interface

The existing `rulematch` payload is the dashboard wire envelope:

```ts
interface DashboardEmission {
  ruleId: string;                    // producing rule and provenance
  url: string;                       // page where the response was observed
  ts: number;                        // capture time in Unix milliseconds
  matches: Record<string, unknown>[]; // one or more records
  stream: string;                    // stable dashboard/dataset identity
  schema: JsonSchema;                // schema for each record
}
```

The generic dashboard boundary is:

```text
(stream, JSON Schema, timestamped records, provenance)
```

## Production integration status

`0_claude-usage.rule.json` and `0a_chatgpt-usage.rule.json` remain the compact
Rules authoring format. The extension lowers each matching netcapture rule into
an `automation.v2` document through `extension/src/6_v2Rules.ts`. The
production compiler in `src/lib/json-rx/9_v2_runtime.ts` executes the browser
source, JSONata projection, and shared dashboard root.

The v2 stateful primitive is an RxJS-shaped `scan` expression referencing a
reusable reducer. Reducers contain a direct object seed and event-type cases
that replace or patch the accumulator. The accumulator is the emitted value;
the v2 format has no machine value, target, or context wrapper.

Codex has a production-normalized schema and typed contracts for
`account/rateLimits/read` and `account/rateLimits/updated`. The adapter accepts
normalized snapshots and sparse updates, while the protocol helper maps the
Codex rate-limits response into those types. A deterministic fake adapter is
available for tests. `CODEX_HOST_STATUS` reports `live: false` and
`state: "pending-host"` because this repository has no live Codex app-server
transport at the native or Sprefa boundary. No process, shell, credential, or
transport implementation is included.

Metrics performs one `activity_rule_matches(limit: 500)` read per poll and
derives one selected stream by default. A second selected stream creates a
generic side-by-side comparison using the same returned rows. Stream selection,
the comparison split, and the chart/history split persist in the `metrics`
`pluginState` slice. Histories use `TreeTable`; charts use Vega-Lite through
`vega-embed`; splits use `react-resizable-panels`.

- `stream` selects and groups a time series across rule executions.
- `schema` describes one record. Standard JSON Schema annotations and numeric
  constraints drive labels, formatting, and chart eligibility.
- `matches` carries record values. One capture can yield multiple records.
- `ts`, `ruleId`, and `url` retain time and source provenance.

The initial rendering policy uses standard schema vocabulary:

| Schema/data shape | Dashboard rendering |
| --- | --- |
| `title` | card label |
| `description` | card help text |
| `type: boolean` | Enabled or Disabled |
| `format: date-time` | localized date and time |
| numeric field ending `_percent` | percentage card and 0..100 time series |
| numeric `minimum: 0, maximum: 100` | percentage card and 0..100 time series |
| other number/string | formatted card and history value |

Chart layout and encoding use Vega-Lite JSON. The application does not define a
second chart grammar. A later rule field can carry a complete Vega-Lite spec or
a named spec reference when inferred rendering cannot represent a dashboard.
The record data remains governed by JSON Schema.

The current chart interaction contract uses Vega-Lite selection parameters:

- Drag the plot horizontally to pan its time scale.
- Use the mouse wheel over the plot to zoom its time scale.
- Double-click the plot to clear the interval selection.
- Select legend entries to isolate series; double-click clears the selection.
- Drag the horizontal sash to divide space between the chart and history grid.

The chart/history and optional stream-comparison layouts are stored in the
`metrics` plugin state and restored on the next panel mount. Vega receives the
measured chart panel width and height after every resize. The default remains a
single stream; the comparison selector can activate one additional stream.

Implementation boundaries follow dependency and reading order:

| File | Interface |
| --- | --- |
| `0_types.ts` | persisted metric and chart-point data shapes |
| `0a_chart.ts` | pure metric records plus dimensions to Vega-Lite spec |
| `0b_layout.tsx` | chart/history split and plugin-state persistence |
| `1_dashboard.tsx` | data formatting and React composition |
| `2_runtime.ts` | polling and JSON-Rx state transitions |

`MetricChart` publishes `data-render-state` and `data-render-error` on its host
element. The golden browser test waits for Vega to finish compiling and
rendering before measuring or capturing the panel.

## End-to-end call tree

Legend: `->` synchronous call or message, `~>` asynchronous boundary,
`[*]` repeated values, `[DB]` persistence, `[NET]` local HTTP.

```text
Claude page fetch/XHR response: JSON object
  -> extension/src/inject.ts deliver(method, url, body, status)
     -> window.postMessage(net capture response)
  ~> extension/src/content.ts message relay
     -> request matcher: host + method + URL expression
     -> extension/src/6_v2Rules.ts V2RuleRuntime.next(NetworkResponse)
     ~> compileAutomationV2 root
        -> source Subject
        -> JSONata project per output field [*]
        -> shareReplay(1, refCount=true)
        -> expression traces [*]
        -> DashboardEmission with automationVersion=automation.v2
  [NET] POST http://127.0.0.1:8787/ingest
  ~> src-tauri/src/activity.rs ingest
     -> persist kind=rulematch [DB]
     -> broadcast activity-added

MetricsDashboardPanel mount
  -> createMetricsDashboardState(load, 5000)
  -> RxJS timer(0, 5000)
  ~> exhaustMap(native activity_rule_matches(limit=500))
     -> Rust reads persisted rulematch rows [DB]
     -> metrics.matches.loaded Event
  -> JSON-Rx runMachine / scan
     -> State { value: ready|empty|error, rows, error }
  -> React render
     -> one or two selected stream views from the returned rows
     -> cards from latest record + JSON Schema
     -> Vega-Lite points from percentage fields [*]
     -> TreeTable history from emissions [*]
```

Cardinality:

```text
1 HTTP response
  -> 0..N matching rules
  -> 0..1 extracted record per current rule extractor
  -> 0..N persisted rulematch emissions
  -> 0..N dashboard rows per stream
  -> 0..N percentage points per row
```

## Browser execution worlds

Chrome isolates the page, extension content script, and service worker.

```text
MAIN page world
  inject.ts wraps window.fetch and XMLHttpRequest at document_start
  cannot call chrome.*

ISOLATED content world
  content.ts reads rule configuration
  writes request patterns to data-ext-netcapture
  receives window messages
  lowers netcapture rules into v2 runtimes
  feeds responses into source Subjects
  relays v2 emissions to the service worker

SERVICE WORKER
  background.ts reports extension and webRequest diagnostics
  localhost is the only event destination
```

The DOM attribute is the configuration bridge from the isolated content world
to the MAIN-world wrapper. A response can complete before configuration arrives.
`inject.ts` retains up to 8 usage-like responses and replays matching entries
when the attribute changes. The extension E2E delays `/config` until after the
fixture response to cover this ordering.

## Rule example

`0_claude-usage.rule.json` is a compact production authoring example. Its
essential contract is:

```json
{
  "id": "claude-usage",
  "host": "^claude\\.ai$",
  "mode": "netcapture",
  "request": {
    "methods": ["GET"],
    "url": "/api/organizations/[^/]+/usage"
  },
  "response": {
    "extract": {
      "five_hour_percent": "five_hour.utilization",
      "five_hour_resets_at": "five_hour.resets_at",
      "seven_day_percent": "seven_day.utilization"
    }
  },
  "emit": {
    "stream": "claude.usage",
    "schema": {
      "type": "object",
      "properties": {
        "five_hour_percent": {
          "type": "number",
          "title": "5-hour usage",
          "minimum": 0,
          "maximum": 100
        },
        "five_hour_resets_at": {
          "type": "string",
          "format": "date-time",
          "title": "5-hour reset"
        }
      }
    }
  },
  "enabled": true
}
```

`response.extract` maps output field names to JSONata expressions. `emit.stream`
names the dataset. `emit.schema` defines one extracted record.

## Filtering and traces

Explicit `rulematch` emissions bypass the generic browser activity site filter.
The enabled rule is the authorization to capture its matched host. Generic page
activity still applies `exclude_sites`.

Expression diagnostics are configured per rule:

- `off`: no expression trace events.
- `errors`: filtered, missing, and error outcomes.
- `all`: every evaluated field.

Traces are ingested as `rule.trace`. Network observations use `netcapture.*`.
The Rules panel and `GET /diagnostics` expose those records.

## Reactive lifecycle

```text
panel mount
  -> timer emits immediately
  -> one load starts
  -> ticks during load are ignored by exhaustMap
  -> loaded/failed event updates JSON-Rx state
  -> state is replayed to the mounted subscriber
every 5 seconds
  -> repeat load
panel unmount
  -> unsubscribe
  -> timer and in-flight cancellable Observable work disposed
```

The native invocation returns a Promise and cannot be interrupted after entry.
`exhaustMap` prevents overlapping reads and bounds concurrent dashboard loads at
one.

## Persistence and transport

The extension sends only extracted fields in the `rulematch` envelope. Raw
response bodies stay in the page/extension process. Transport targets
`127.0.0.1`. Rust stores the envelope in the activity database. The dashboard
polls the latest 500 matching rows and derives its view without a second metric
store.

## Verification boundaries

- `e2e/0_rules-extension.spec.ts` runs Chromium with the built extension, a
  local page, a real local API request, delayed configuration, extraction, and
  ingest assertions using the Claude response fixture.
- `e2e/metrics-dashboard.spec.ts` injects the native query result, opens Metrics
  through the Rules child rail item, verifies one native read, selects Claude
  and Codex streams through the generic comparison controls, waits for both
  Vega render states, records the golden dashboard screenshot, and drags the
  chart/history split.
- `src/lib/json-rx/*.test.ts` covers state updates, machine scans, partitioned
  instances, catalogs, expression traces, automation.v2 validation and
  compilation, Codex normalization, sparse update ordering, and host sharing.

## Off-the-shelf visualization layers

The current dependency is Vega-Lite through `vega-embed`. Vega-Lite accepts a
declarative JSON grammar, including marks, encodings, axes, legends, scales,
transforms, and interaction parameters. This aligns with serializable rule and
dashboard definitions.

Other library boundaries evaluated for later use:

- Apache ECharts accepts `dataset` plus `series.encode`, supports dynamic
  updates through `setOption`, and includes dashboard-oriented chart types.
- Observable Plot accepts typed records and concise mark/channel definitions.
  Its configuration is JavaScript-oriented rather than a standalone published
  interchange specification.
- Perspective supplies a streaming analytical table and pivot/viewer custom
  element. It can cover larger tabular streams, grouping, and interactive
  exploration if those become dashboard requirements.

The existing TreeTable remains the required list/table renderer inside Instant.

## Browser effects

Rule schedules may carry generic effect descriptions. JSON-Rx and the rule
model retain `{ id?, op, input? }`; the extension browser plugin owns target
selection and Chrome API calls.

```text
alarm tick
  -> JSON-Rx schedule.tick Event
  -> schedule machine Transition.effects [*]
  -> JSON-Rx concatMap effect interpreter
     -> resolve logical target against current contexts
     -> execute command
     -> browser.effect.next | browser.effect.error
  -> result Event re-enters the schedule machine
  -> localhost ingest diagnostic
```

The implemented command is `browsingContext.reload`, named after WebDriver
BiDi. Its target supports URL regex, active state, minimum idle duration, and
`one`/`all` cardinality. Concrete Chrome tab IDs are resolved at execution time
and appear only in result events. This keeps ephemeral browser identity out of
stored rules and JSON-Rx's generic algebra.

An interval with no effects retains the existing dedicated-background-tab scan.
No production rule enables scheduled Claude reloads. The extension E2E adds an
effect to its local fixture rule, fires the alarm, observes a second page load,
and asserts the correlated success diagnostic.

## Network recording and API annotation path

Chrome already exposes the Network panel data to DevTools extensions through
`chrome.devtools.network`. `getHAR()` returns the current log in HAR form,
`onRequestFinished` streams completed HAR entries, and `request.getContent()`
retrieves a selected response body. This API requires a `devtools_page` and the
DevTools window. A dedicated Instant DevTools panel can therefore record the
same request model users inspect in Chrome without maintaining another fetch or
XHR interceptor for recording mode.

Use HAR 1.2 as the immutable observation format. Keep capture facts separate
from inferred contracts and user annotations:

```text
Chrome DevTools Network
  -> HAR entry + optional response content
  -> CaptureStore (append-only local observations)
  -> CaptureAdapter plugin
     -> OpenAPI 3.1 inferred operation/schema
     -> Instant netcapture rule
     -> curl
     -> HAR file
  -> Annotation document
     -> OpenAPI Overlay 1.1 actions
  -> Workflow document
     -> Arazzo 1.1 steps and dependencies
```

Suggested plugin boundary:

```ts
interface CaptureAdapter<Output> {
  id: string;
  accepts: string[];
  convert(captures: HarEntry[], selection: CaptureSelection): Promise<Output>;
}
```

The normalized input is a HAR entry plus locally attached tags, redactions,
path-parameter selections, field selections, and joins. Exporters own target
formats. This keeps Bruno, OpenAPI, rule JSON, and later formats out of capture
storage.

Reusable components:

- Chrome's DevTools Network API supplies HAR and bodies for explicit recording.
- `har-to-openapi` converts HAR observations to OpenAPI 3.0 or 3.1 and supports
  domain filtering and noisy-path replacement.
- OpenAPI Overlay uses ordered JSONPath-targeted `update`, `remove`, and `copy`
  actions for annotations that remain separate from generated OpenAPI.
- Arazzo describes call sequences, dependencies, inputs, outputs, and success
  criteria against OpenAPI source descriptions.
- Bruno CLI imports OpenAPI into OpenCollection, `.bru`, or one collection JSON
  file. The OpenAPI exporter therefore covers Bruno without a Bruno-specific
  capture implementation.

`chrome.debugger` plus CDP can capture response bodies without an open DevTools
window, but it requires debugger attachment and exposes a broader permission
surface. The DevTools Network API fits the explicit "record and point at a
request" interaction. The current MAIN-world wrapper remains the low-permission
automatic rule runtime.

Joins with external data belong after capture normalization. A join definition
can reference a capture field by JSON Pointer or JSONata and produce ordinary
dashboard records governed by JSON Schema. The resulting records enter the
same `stream + schema + timestamp + provenance` dashboard interface described
above.
