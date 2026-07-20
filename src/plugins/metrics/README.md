# Metrics plugin

The Metrics plugin consumes metric-bearing rule matches from the local browser
ingest stream. It owns the dashboard panel and rendering policy. The Rules
plugin owns rule editing. The extension owns page interception and extraction.

## Data path

```text
Chrome page fetch/XHR
  -> extension/src/inject.ts
  -> extension/src/content.ts
  -> JSONata response extraction
  -> POST 127.0.0.1:8787/ingest
  -> SQLite events.kind = rulematch
  -> MetricsDashboardPanel
```

The response shape is configured on a rule:

```json
{
  "id": "claude-usage",
  "host": "^claude\\.ai$",
  "mode": "netcapture",
  "request": {
    "methods": ["GET"],
    "url": "/api/.*usage"
  },
  "response": {
    "extract": {
      "five_hour_percent": "five_hour.utilization * 100",
      "five_hour_resets_at": "five_hour.resets_at",
      "seven_day_percent": "seven_day.utilization * 100"
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
groups the values for a dashboard. `emit.schema` describes those values and
supplies labels and constraints to renderers. The current renderer shows
schema-backed metric cards, a Vega-Lite time series for numeric values, and the
shared TreeTable history.

All transport stays on `127.0.0.1`. The response body is processed in the
extension and only extracted fields are sent to Instant.
