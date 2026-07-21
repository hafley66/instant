# instant core (Chrome extension)

A config-driven MV3 core. The `instant` app (`127.0.0.1:8787`) is the source of
truth for **rules**; the extension fetches them and reports two things back:

1. **Activity spy** (always on) — tab navigation/lifecycle, selections, copies,
   and DOM interactions (click / ctrl-click / dbl-click / drag / right-click).
2. **Rule matches** — data extracted from pages by server-defined rules.

## Build

TypeScript sources live in `src/`; the manifest loads the bundled output in
`dist/`. Build before loading:

```sh
just ext-build      # one shot  (corepack pnpm@10.12.4 ext:build)
just ext-watch      # rebuild on save
just ext-check      # typecheck (corepack pnpm@10.12.4 ext:check)
```

`src/` reads in dependency order: `0_types` → `1_match` → `2_scan` →
`3_extract` → `4_browserEffects` → `5_scheduleRuntime` → `6_v2Rules` → `background` /
`content` / `inject`.

| output | world | when | role |
|---|---|---|---|
| `dist/background.js` | service worker | — | localhost POST, config fetch, driven-scan alarms |
| `dist/content.js` | isolated | document_idle | activity spy, passive scans, netcapture relay |
| `dist/inject.js` | MAIN | document_start | fetch/XHR interceptor (netcapture) |

## Rules

A rule (edited in the app's **Rules** panel, served from `GET /config`):

```jsonc
{
  "id": "claude-usage",
  "host": "claude\\.ai",          // regex, tested against location.host
  "url": "https://claude.ai/...", // regex (passive) or concrete URL (driven)
  "mode": "textnodes",            // textnodes | selector | netcapture
  "selector": ".usage-row",       // selector mode only
  "regex": "(\\d+)% used",        // capture groups feed `captures`
  "captures": { "1": "percent" }, // group (name or 1-based index) -> field
  "request": {                     // netcapture request gate
    "methods": ["GET"],
    "url": "/api/.*usage"
  },
  "response": {                     // JSONata output field -> expression
    "extract": { "percent": "five_hour.utilization * 100" }
  },
  "emit": { "stream": "claude.usage" },
  "schedule": { "intervalMin": 5 }, // or "passive" / omit
  "enabled": true
}
```

- **host gate**: the content script no-ops on any host no enabled rule matches.
- **textnodes**: TreeWalker over text nodes, `regex` per node; re-scans on DOM
  mutations (debounced) for SPAs.
- **selector**: `querySelectorAll(selector)`, `regex` per node's text.
- **netcapture**: the MAIN-world patch intercepts matching fetch/XHR responses
  and relays the JSON. Rules with `response.extract` and `emit` lower into an
  `automation.v2` source, JSONata project, `shareReplay` root, and dashboard
  output. Regex-only netcapture rules retain the compact fallback interpreter.
- **driven** (`schedule.intervalMin`): a per-rule alarm reloads a background tab
  at `url` and asks the content script to scan it. `url` must be a concrete URL.
- **effect schedule**: `schedule.effects` replaces the legacy dedicated-tab
  scan with serializable effects interpreted by extension plugins.

The first browser effect uses the WebDriver BiDi command name
`browsingContext.reload`:

```json
{
  "schedule": {
    "intervalMin": 15,
    "effects": [{
      "id": "reload-usage-when-idle",
      "op": "browsingContext.reload",
      "input": {
        "target": {
          "url": "^https://claude\\.ai/",
          "active": false,
          "idleForMs": 300000,
          "cardinality": "one"
        },
        "ignoreCache": false
      }
    }]
  }
}
```

The alarm emits a `schedule.tick` event into a JSON-Rx machine. Its transition
returns the configured effects. JSON-Rx executes them sequentially through the
browser interpreter and feeds each result event back into the same machine.

Target resolution happens at execution time because Chrome tab IDs are
process-local and ephemeral. `cardinality` defaults to `one`; the most recently
accessed matching context wins. `all` executes sequentially across every match.
Each execution posts `browser.effect.next` or `browser.effect.error` to Instant
with the effect ID and resolved context IDs.

V2 matches POST to `/ingest` as `{type:"rulematch", ruleId, url, ts,
matches:[…], stream, schema, automationVersion:"automation.v2"}`. Rust persists
the common dashboard fields and ignores the diagnostic version marker.

## How it connects

Only the background service worker talks to localhost (`host_permissions` is
`127.0.0.1:8787` only); content scripts relay through it, since an https page
can't fetch http-localhost directly. Driven scans deliberately use the injected
content script (not `executeScript`) so the extension needs **no** broad host
permission. Events only land while the app is running; if it's closed the POST
silently fails and nothing is queued.

## Load it

1. `just ext-build`
2. Open `chrome://extensions`, toggle **Developer mode**.
3. **Load unpacked** → select this `extension/` folder.

## Test the endpoints without the browser

```sh
# activity event
curl -s -XPOST http://127.0.0.1:8787/ingest -H 'content-type: application/json' \
  -d '{"kind":"nav","url":"https://example.com","title":"Example","text":""}'

# rule match
curl -s -XPOST http://127.0.0.1:8787/ingest -H 'content-type: application/json' \
  -d '{"type":"rulematch","ruleId":"demo","url":"https://x","ts":0,"matches":[{"percent":"42"}]}'

# rules the extension will fetch
curl -s http://127.0.0.1:8787/config
```
