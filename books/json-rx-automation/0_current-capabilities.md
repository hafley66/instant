# Current automation capabilities

Instant currently has two related execution surfaces:

1. Rules are serializable JSON consumed by the Chrome extension.
2. JSON-Rx is a TypeScript library for event streams, state machines, reusable
   definitions, expressions, and interpreted effects.

The JSON-Rx library contains capabilities that have not yet been exposed in the
Rule JSON schema. Keeping these surfaces distinct is important when describing
what can execute without recompiling.

The production tree now also contains an `automation.v2` Zod 4 schema and RxJS
compiler under `src/lib/json-rx`. It compiles validated source, merge, scan,
project, and `shareReplay` nodes into dashboard emissions. Stateful v2 scans
reference reusable reducers with direct object seeds and event-type cases.
Claude v1 remains the
active extension capture format; the Metrics plugin exports a matching Claude
v2 definition for production-side compilation.

## Rule JSON

A rule is selected by a host regular expression and an optional page URL
regular expression. Enabled rules support three observation modes.

### Text-node capture

`textnodes` walks text nodes and applies a regular expression. Named or numeric
capture groups become fields in the emitted record.

```json
{
  "id": "incident-identifiers",
  "host": "^app\\.example\\.com$",
  "mode": "textnodes",
  "regex": "Incident ([A-Z]+-[0-9]+)",
  "captures": {
    "1": "incident"
  },
  "enabled": true
}
```

### Selector capture

`selector` restricts the scan to elements matching a CSS selector. The regular
expression is applied to each selected element's text.

```json
{
  "id": "message-usage",
  "host": "^app\\.example\\.com$",
  "mode": "selector",
  "selector": "[data-message-body]",
  "regex": "Usage: ([0-9]+)%",
  "captures": {
    "1": "percent"
  },
  "enabled": true
}
```

MutationObserver-driven scans allow selector and text rules to observe content
added after initial navigation.

### Network-response capture

`netcapture` observes page-world `fetch` and XMLHttpRequest JSON responses. It
matches HTTP method and URL, then evaluates one JSONata expression per output
field.

```json
{
  "id": "service-health",
  "host": "^example\\.com$",
  "mode": "netcapture",
  "request": {
    "methods": ["GET"],
    "url": "/api/health"
  },
  "response": {
    "extract": {
      "availability_percent": "availability * 100",
      "queue_depth": "workers.queueDepth",
      "checked_at": "timestamp"
    }
  },
  "emit": {
    "stream": "example.health",
    "schema": {
      "type": "object",
      "properties": {
        "availability_percent": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "queue_depth": { "type": "number" },
        "checked_at": { "type": "string", "format": "date-time" }
      }
    }
  },
  "diagnostics": "all",
  "enabled": true
}
```

Emissions appear in Rules match history and the Metrics panel. JSON Schema
drives labels and value formatting. Numeric fields ending in `_percent`, or
having a zero-to-one-hundred schema domain, become chart series.

## Scheduled browser effects

Rules can use Chrome alarms with an interval measured in minutes. The browser
effect interpreter currently implements `browsingContext.reload`.

```json
{
  "schedule": {
    "intervalMin": 5,
    "effects": [
      {
        "id": "reload-usage",
        "op": "browsingContext.reload",
        "input": {
          "target": {
            "url": "^https://example\\.com/usage",
            "active": false,
            "idleForMs": 300000,
            "cardinality": "one"
          },
          "ignoreCache": false
        }
      }
    ]
  }
}
```

Target fields select tabs by URL regex, active status, idle duration, and
cardinality. `one` selects the most recently accessed match. `all` selects every
match. An interval schedule without effects retains the older dedicated-tab
scan behavior.

## JSON-Rx library

JSON-Rx currently supplies:

- JSON events with identity, causation, time, and partition keys
- state replacement, JSON Patch, and JSON Pointer field updates
- state-machine reduction through RxJS `scan`
- one machine instance per partition key
- reusable machine and flow references through a catalog
- asynchronous effects whose result events re-enter the machine
- JSON Logic predicates and JSONata projections with diagnostics
- RxJS combination, flattening, timing, retry, and cancellation operators

Production v2 host status:

- Codex account/rate-limit snapshot and sparse-update contracts are typed and
  normalized in `src/lib/json-rx/10_codex_host.ts`.
- Complete nullable Codex records are produced for snapshot, update, and
  update-before-snapshot orderings.
- A deterministic fake host adapter is available for tests.
- `CODEX_HOST_STATUS.state` is `"pending-host"`; live Codex app-server
  transport is absent at the native and Sprefa boundary.
- Process execution, shell execution, credentials, and transport forwarding
  remain outside this repository change.

Rule JSON does not currently expose arbitrary machines, custom event sources,
DOM action effects, authenticated HTTP effects, or keyed materialized views.
