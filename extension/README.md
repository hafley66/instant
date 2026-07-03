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
just ext-build      # one shot  (npm run ext:build)
just ext-watch      # rebuild on save
just ext-check      # typecheck (npm run ext:check)
```

`src/` reads in dependency order: `0_types` → `1_match` → `2_scan` →
`background` / `content` / `inject`.

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
  "schedule": { "intervalMin": 5 }, // or "passive" / omit
  "action": "report",             // report | notify (notify posts to the configured ntfy_url)
  "enabled": true
}
```

- **host gate**: the content script no-ops on any host no enabled rule matches.
- **textnodes**: TreeWalker over text nodes, `regex` per node; re-scans on DOM
  mutations (debounced) for SPAs.
- **selector**: `querySelectorAll(selector)`, `regex` per node's text.
- **netcapture**: the MAIN-world patch intercepts fetch/XHR responses whose URL
  matches `url`/`regex` and relays the JSON; the isolated script runs `regex`
  over the stringified body. Only installed on hosts a netcapture rule matches.
- **driven** (`schedule.intervalMin`): a per-rule alarm reloads a background tab
  at `url` and asks the content script to scan it. `url` must be a concrete URL.

Matches POST to `/ingest` as `{type:"rulematch", ruleId, url, ts, matches:[…]}`.

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
